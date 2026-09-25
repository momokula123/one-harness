'use strict';
// 工具组契约探针（纯本机，不打公网）。
//
// 守的是一条协议铁律：assistant 消息里的每个 tool_calls 都必须有对应的 tool 消息跟着 ——
// 少一个、或中间夹了别的角色，上游就整轮 400：
//   An assistant message with 'tool_calls' must be followed by tool messages responding to
//   each 'tool_call_id'. (insufficient tool messages following tool_calls message)
//
// 真实事故（2026-09-25，会话 c66c1fa9）：模型一次返回 2 个调用，第 1 个还在跑时用户按了
// 「停止」→ 第 2 个调用永远没有 tool 消息。事件日志 append-only，缺口永久留下 →
// 那个会话之后**每一次**请求都被判 400，等于废掉。
//
// 两处修复各守一段：
//   core/session.js  normalizeToolGroups —— 发请求那一刻把不合规的消息修好（能救老会话）
//   core/agent.js    fillUnansweredToolCalls —— 收尾时把缺口记进日志（新事件不再留缺口）
//
// 运行： node test/toolcall-groups.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp-toolcall');
process.env.HATCH_DATA_DIR = path.join(TMP, 'data');
process.env.HATCH_USER_DATA = path.join(TMP, 'userdata');

const store = require('../core/store');
const sessionLib = require('../core/session');
const { Agent } = require('../core/agent');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra ? '  → ' + extra : ''));
  }
}

/**
 * 把上游那条规则机器化：返回"会被判 400 的位置"。
 * 断言用的就是它 —— 所以它自己有区分度（下面 1b 拿一份明知不合规的输入做反向对照）。
 */
function violations(msgs) {
  const bad = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === 'tool') {
      const prev = msgs[i - 1];
      const ok = prev && (prev.role === 'tool'
        || (prev.role === 'assistant' && Array.isArray(prev.tool_calls)
          && prev.tool_calls.some((c) => c.id === m.tool_call_id)));
      if (!ok) bad.push('孤儿 tool 消息 @' + i + '（' + m.tool_call_id + '）');
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = m.tool_calls.map((c) => c.id);
      const got = [];
      for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) got.push(msgs[j].tool_call_id);
      for (const id of ids) if (!got.includes(id)) bad.push('tool_calls 缺回应 @' + i + '（' + id + '）');
    }
  }
  return bad;
}

// ---------- 本机假端点 ----------
let PORT = 0;
function startMock() {
  const server = http.createServer((req, res) => {
    // 慢接口：专门留出窗口让「停止」落在工具执行期间（事故就是这么发生的）
    if (req.url.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>慢页面</body></html>');
      }, 1500);
      return;
    }
    if (!req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const msgs = payload.messages || [];
      const sys = String((msgs[0] || {}).content || '');
      const joined = JSON.stringify(msgs);

      // 流式（stream:true 是写死的），所以任何一路都用 SSE 答
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const chunk = (delta, finish) => ({ choices: [{ index: 0, delta, finish_reason: finish || null }] });
      const text = (s) => {
        for (const part of (String(s).match(/[\s\S]{1,20}/g) || [])) send(chunk({ content: part }));
        send(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      };

      // 审批闸门的评审子会话：给一个三轴齐全的裁决
      if (sys.startsWith('You are the command reviewer') || joined.includes('## Command under review')) {
        return text('<result>{"risk":"medium","authorization":"neutral","correct":true}</result>');
      }
      // 压缩摘要（本探针不该走到，走到了也让它能过）
      if (sys.startsWith('You compress agent transcripts')) return text('（摘要）');

      // 主对话：本轮还没有 tool 回执 → 一次要两个调用（事故形状的关键是"一组多个"）
      let lastUser = -1;
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = i; break; }
      const nTool = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
      if (nTool === 0) {
        global.__stubGaveTwoCalls = true;
        send(chunk({ tool_calls: [{ index: 0, id: 'ca_slow', type: 'function', function: { name: 'web_fetch', arguments: '' } }] }));
        send(chunk({ tool_calls: [{ index: 1, id: 'cb_write', type: 'function', function: { name: 'write_file', arguments: '' } }] }));
        send(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ url: 'http://127.0.0.1:' + PORT + '/slow', maxChars: 2000 }) } }] }));
        send(chunk({ tool_calls: [{ index: 1, function: { arguments: JSON.stringify({ relativePath: 'later.txt', content: '第二个工具不该被执行' }) } }] }));
        send(chunk({}, 'tool_calls'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      return text('收工。');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const WS = path.join(TMP, 'workspace');

function newSession(name) {
  return sessionLib.createSession({ projectId: 'p-toolgroup', name, programId: 'chat', workingDir: WS });
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  const server = await startMock();
  PORT = server.address().port;
  console.log('\n本机假端点: http://127.0.0.1:' + PORT + '/v1\n');

  store.init();
  const agent = new Agent({
    getSettings: () => store.getSettings(),
    emit: () => {},
    askUser: async () => ({ approved: true, note: '' }),
  });
  store.saveSettings({ model: { baseUrl: 'http://127.0.0.1:' + PORT + '/v1', model: 'mock-model' }, approval: { mode: 'auto' } });

  console.log('1) 渲染边界自愈：半截工具组（事故形状）');
  {
    const s = newSession('半截组');
    sessionLib.userMessage(s, '帮我并行查两个页面');
    sessionLib.assistantMessage(s, [
      { type: 'text', text: '好，我并行查。' },
      { type: 'toolCallRequest', callId: 'ca_1', name: 'web_fetch', argsText: '{"url":"http://a"}' },
      { type: 'toolCallRequest', callId: 'cb_2', name: 'web_fetch', argsText: '{"url":"http://b"}' },
    ]);
    sessionLib.toolMessage(s, { callId: 'ca_1', name: 'web_fetch', text: '页面 A 的内容', isError: false });
    // cb_2 的回执缺失 —— 用户此刻按了「停止」

    const before = violations([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'ca_1', type: 'function', function: {} }, { id: 'cb_2', type: 'function', function: {} }] },
      { role: 'tool', tool_call_id: 'ca_1', content: '页面 A 的内容' },
    ]);
    check('反向对照：不修的话这份输入确实被判不合规（校验器有区分度）', before.length === 1, JSON.stringify(before));

    const msgs = sessionLib.renderMessages(s, { vision: true });
    const bad = violations(msgs);
    check('修完：按上游规则合规，一个缺口都不剩', bad.length === 0, bad.join('; '));
    const tools = msgs.filter((m) => m.role === 'tool');
    check('补的那条落在同一个工具组里（紧跟真实回执，中间没夹别的角色）',
      tools.length === 2 && tools[0].tool_call_id === 'ca_1' && tools[1].tool_call_id === 'cb_2',
      JSON.stringify(tools.map((m) => m.tool_call_id)));
    check('补的那条正文说明"没执行"（不是空串、也不是伪造的结果）',
      tools[1] && String(tools[1].content).includes('未执行'), JSON.stringify(tools[1] && tools[1].content));
    check('真实回执原样保留（没被覆盖）', tools[0].content === '页面 A 的内容', JSON.stringify(tools[0].content));
  }

  console.log('\n2) 合法输入必须原样通过（不多补一条）');
  {
    const s = newSession('完整组');
    sessionLib.userMessage(s, '读一下那个文件');
    sessionLib.assistantMessage(s, [{ type: 'toolCallRequest', callId: 'cd_1', name: 'read_file_lines', argsText: '{"relativePath":"a.txt"}' }]);
    sessionLib.toolMessage(s, { callId: 'cd_1', name: 'read_file_lines', text: '内容', isError: false });
    const msgs = sessionLib.renderMessages(s, { vision: true });
    const tools = msgs.filter((m) => m.role === 'tool');
    check('完整组：只发一条 tool 消息', tools.length === 1, String(tools.length));
    check('完整组：这条是原始回执', tools[0].tool_call_id === 'cd_1' && tools[0].content === '内容');
    check('完整组：合规', violations(msgs).length === 0);
    check('幂等：再修一次结果不变', JSON.stringify(sessionLib.normalizeToolGroups(msgs)) === JSON.stringify(msgs));
  }

  console.log('\n3) 另外两种坏形状');
  {
    const orphan = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '接着上次' },
      { role: 'tool', tool_call_id: 'zz_孤儿', content: '压缩切点留下的孤儿回执' },
    ];
    const out = sessionLib.normalizeToolGroups(orphan);
    check('孤儿 tool 消息被丢掉（否则上游报"tool 消息前面没有 tool_calls"）',
      out.filter((m) => m.role === 'tool').length === 0, JSON.stringify(out.map((m) => m.role)));
    check('对照：丢掉孤儿之后剩下的两条原样在', out.length === 2 && out[1].content === '接着上次');

    const dup = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'd1', type: 'function', function: {} }] },
      { role: 'tool', tool_call_id: 'd1', content: '第一次' },
      { role: 'tool', tool_call_id: 'd1', content: '重复' },
    ];
    const d = sessionLib.normalizeToolGroups(dup).filter((m) => m.role === 'tool');
    check('重复 id 只留一条（且留的是第一条）', d.length === 1 && d[0].content === '第一次', JSON.stringify(d.map((m) => m.content)));
  }

  console.log('\n4) 端到端：一次两个调用 + 执行中按「停止」');
  {
    const s = newSession('停止打断');
    sessionLib.userMessage(s, '并行做两件事');
    const events = [];
    let stopCalled = false;
    const ag = new Agent({
      getSettings: () => store.getSettings(),
      emit: (ev) => {
        events.push(ev.type);
        // 第一个工具刚开始跑（它打的是那个 1.5 秒的慢接口）→ 此刻按下停止
        if (ev.type === 'tool:start' && !stopCalled) {
          stopCalled = true;
          ag.stop(s.id);
        }
      },
      askUser: async () => ({ approved: true, note: '' }),
    });

    const r = await ag.runTurn(s);
    check('这一轮以"已停止"收场（证明走的是停止路径）', r.reason === 'aborted', JSON.stringify(r));
    check('模型这一轮确实一次给了两个调用（事故形状）', global.__stubGaveTwoCalls === true && events.includes('tool:start'));

    const answered = new Map();
    for (const e of s.entries) {
      if (e.type !== 'message' || e.role !== 'tool') continue;
      for (const p of e.parts || []) if (p.type === 'toolCallResult') answered.set(p.callId, String(p.text || ''));
    }
    check('两个 callId 都落盘了回执（缺一个这个会话就废了）',
      answered.has('ca_slow') && answered.has('cb_write'), JSON.stringify([...answered.keys()]));
    check('停止时还没跑的那个 = 如实记成"未执行"',
      String(answered.get('cb_write') || '').includes('未执行'), JSON.stringify(answered.get('cb_write')));
    check('反向对照：第二个工具真的没被执行（它要写的文件不存在）',
      !fs.existsSync(path.join(WS, 'later.txt')));
    check('补的是 1 条（第一个工具自己回了真实结果，没被重复补）',
      [...answered.values()].filter((t) => t.includes('未执行')).length === 1,
      JSON.stringify([...answered.values()].map((t) => t.slice(0, 24))));

    const msgs = sessionLib.renderMessages(s, { vision: true });
    const bad = violations(msgs);
    check('★ 收尾后要发出去的消息合规（老代码这里就是那条 400 的来源）', bad.length === 0, bad.join('; '));
    console.log('    本轮事件序列: ' + events.join(' '));
  }

  server.close();
  console.log('\n工具组契约：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('套件崩了：', e && e.stack ? e.stack : e);
  process.exit(1);
});
