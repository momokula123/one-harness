'use strict';
// 冒烟测试：用假的 OpenAI 兼容服务跑通 整轮 → 工具调用 → 落盘 → 检查点 → 回滚
// 运行： node test/smoke.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp');
process.env.HATCH_DATA_DIR = path.join(TMP, 'data');

const store = require('../core/store');
const sessionLib = require('../core/session');
const checkpoints = require('../core/checkpoints');
const compact = require('../core/compact');
const model = require('../core/model');
const { Agent } = require('../core/agent');
const approvals = require('../core/approvals');
const tools = require('../core/tools');
const runlog = require('../core/runlog');
const { classifyCommand } = require('../core/tools/shell');

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

// ---------- 一张真的 4×4 PNG（生图工具的假产物）----------
// 不用别人的图片文件当夹具：这里现封一张，宽高正好用来断言"尺寸是从字节里读出来的"。
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function tinyPng(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 4;
      raw[o] = 220; raw[o + 1] = 90; raw[o + 2] = 70; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const TINY_PNG = tinyPng(4, 4);

// ---------- 假模型服务 ----------
let call = 0;
function startMock() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    // 生图产物那张图（生图接口只回 URL，工具自己来下载）
    if (req.url.startsWith('/img/tiny.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    // 假生图接口：把收到的请求体原样留下来给断言看
    if (req.url.startsWith('/v1/images/generations')) {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        global.__imageCalls = (global.__imageCalls || 0) + 1;
        global.__lastImageReq = payload;
        global.__lastImageAuth = req.headers.authorization || '';
        const prompt = String(payload.prompt || '');
        if (prompt.includes('FAIL401')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (prompt.includes('USE_B64')) {
          // 另一种返回形状：不给 URL，直接给 base64
          res.end(JSON.stringify({ created: 1, data: [{ url: null, b64_json: TINY_PNG.toString('base64'), revised_prompt: null }] }));
          return;
        }
        res.end(JSON.stringify({
          created: 1,
          data: [{ url: 'http://' + req.headers.host + '/img/tiny.png', b64_json: null, revised_prompt: '改写后的提示词' }],
        }));
      });
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        const msgs = payload.messages || [];
        const sys = String((msgs[0] || {}).content || '');
        const hasToolResult = msgs.some((m) => m.role === 'tool');
        const toolNames = (payload.tools || []).map((t) => t.function.name);
        const joined = JSON.stringify(msgs);
        call++;
        // 把请求体原样留给断言看：**"参数到底有没有发出去"只能从这儿证** ——
        // 内核里算出来一个字段，和它真的出现在 HTTP body 里，是两件事。
        global.__lastChatReq = payload;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
        const chunk = (delta, finish) => ({ choices: [{ index: 0, delta, finish_reason: finish || null }] });

        // ---- 压缩摘要：直接回一段文本，好让"该压 / 不该压"两侧都能走到头 ----
        if (sys.startsWith('You compress agent transcripts')) {
          send(chunk({ content: '（压缩后的摘要）用户的目标、已改的文件、下一步。' }));
          send(chunk({}, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // ---- 评审子会话：走另一套脚本 ----
        if (sys.startsWith('You are the command reviewer')) {
          global.__lastReviewTools = toolNames;
          if (joined.includes('REVIEW_FAIL')) {
            // 一直吐不出 <result>，用来验证「评审坏了要转人工」的兜底
            send(chunk({ content: '我不太确定，先不判断了。' }));
            send(chunk({}, 'stop'));
          } else if (joined.includes('REVIEW_READ') && !hasToolResult) {
            // 先取证：要求给只读工具，再出裁决
            send(chunk({ tool_calls: [{ index: 0, id: 'rv_1', function: { name: 'list_directory', arguments: '{"relativePath":"."}' } }] }));
            send(chunk({}, 'tool_calls'));
          } else {
            send(chunk({ content: '<result>{"risk":"medium","authorization":"neutral","correct":true}</result>' }));
            send(chunk({}, 'stop'));
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (!hasToolResult) {
          send({ choices: [{ delta: { reasoning_content: '先写一个文件。' } }] });
          send({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_1',
                  function: { name: 'write_file', arguments: JSON.stringify({ relativePath: 'notes/hello.txt', content: 'hello hatch\n第二行\n' }) },
                }],
              },
            }],
          });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          send({ usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 } });
        } else {
          const toolMsg = msgs.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
          send({ choices: [{ delta: { content: '搞定。工具回执：' + toolMsg.slice(0, 60).replace(/\n/g, ' ') } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          send({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
        }
        res.write('data: [DONE]\n\n');
        res.end();
        // 把工具名暴露给断言用
        global.__lastToolNames = toolNames;
        global.__lastMessages = msgs;
      });
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'workspace'), { recursive: true });
  const server = await startMock();
  const port = server.address().port;
  console.log('\n假模型服务: http://127.0.0.1:' + port + '/v1\n');

  store.init();
  store.saveSettings({
    model: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'mock-model' },
    approval: { mode: 'auto' },
  });

  console.log('\n1b) 兜底端点：与"用户自己的模型"分两套存');
  {
    const MOCK = 'http://127.0.0.1:' + port + '/v1';
    const g = store.getSettings();
    check('语言模型兜底来自随包 config/model.json',
      g.fallback.llm.model === store.readFactory('model').model && !!g.fallback.llm.baseUrl,
      JSON.stringify(g.fallback.llm));
    check('生图兜底来自随包 config/image.json',
      g.fallback.image.model === store.readFactory('image').model && /agnes/.test(g.fallback.image.baseUrl),
      JSON.stringify(g.fallback.image));
    check('对照：两个文件是两份东西（不是同一个兜底被读了两遍）',
      store.factoryFiles('model')[0] !== store.factoryFiles('image')[0]);
    check('用户自己配了端点 → 正在用的就是他那一套',
      g.model.baseUrl === MOCK && g.model.model === 'mock-model', JSON.stringify({ b: g.model.baseUrl, m: g.model.model }));
    check('★ 不去借兜底的 key（A 家的钥匙发到 B 家地址上，是不报错的那种错）',
      g.model.apiKey === '', JSON.stringify(g.model.apiKey));
    check('modelOwn 记的是用户填的原文（界面输入框绑它，而不是绑"生效值"）',
      g.modelOwn.baseUrl === MOCK && g.modelOwn.model === 'mock-model');
    check('派生字段不落盘（settings.json 里没有 modelOwn）',
      !fs.readFileSync(store.SETTINGS_FILE, 'utf8').includes('modelOwn'));

    // 清空用户那组 → 整套切兜底
    store.saveSettings({ model: { baseUrl: '', model: '' } });
    const g2 = store.getSettings();
    check('用户两项清空 → 整套回落到兜底',
      g2.model.baseUrl === g2.fallback.llm.baseUrl && g2.model.model === g2.fallback.llm.model);
    check('对照：这时 modelOwn 仍是空串（界面才知道"你没填"）', g2.modelOwn.baseUrl === '');
    // 上下文大小跟着"当前生效的那套"走：agnes-3.0-flash 是 512K，写在 config/model.json 里
    check('兜底那份自带上下文大小（512K，来自 config/model.json）',
      g2.fallback.llm.contextLength === 524288, String(g2.fallback.llm.contextLength));
    check('走兜底时，生效的上下文大小 = 兜底那套的（不是内置的 16384，否则 512K 的模型会被过早压缩）',
      g2.model.contextLength === 524288, String(g2.model.contextLength));

    // 卡片里改兜底，会立刻反映到"正在用的"上
    store.saveSettings({ fallback: { llm: { model: 'probe-fallback-model' } } });
    check('兜底卡片改了 → 正在用的那套跟着变', store.getSettings().model.model === 'probe-fallback-model');

    // ★ 两套真的分开：把用户那组写回去，兜底的改动就不再影响正在用的
    store.saveSettings({ model: { baseUrl: MOCK, model: 'mock-model' } });
    check('★ 用户填回自己的端点 → 兜底那份改动不再影响正在用的（真的分开了）',
      store.getSettings().model.model === 'mock-model');
    check('★ 反向：用户这组的值也没有渗进兜底卡片', store.getSettings().fallback.llm.model === 'probe-fallback-model');
    // ★ 反过来也不能拿兜底的 512K 去套别人的端点（撑爆是"上下文溢出"，比早压缩难查）
    check('★ 换回自己的端点后，上下文大小回到保守默认（不是兜底那 512K）',
      store.getSettings().model.contextLength === 16384, String(store.getSettings().model.contextLength));
    store.saveSettings({ fallback: { llm: { model: '' } } });   // 还原，别影响后面的用例
    check('还原：兜底模型又回到出厂值', store.getSettings().fallback.llm.model === store.readFactory('model').model);
  }

  console.log('\n1c) 思考强度（reasoning_effort）：只跟着兜底那份走');
  {
    const MOCK = 'http://127.0.0.1:' + port + '/v1';
    // 兜底那份**临时指到假端点**：它默认是 agnes 的公网地址，冒烟里不能真联网、更不能花人钱。
    // 模型名与钥匙都跟用户那组不一样 —— 这样"请求到底走的哪一套"能从请求体里看出来。
    const FB = { baseUrl: MOCK, apiKey: 'test-key-not-real', model: 'mock-fallback-model' };
    const facModel = store.readFactory('model');
    check('出厂思考强度取自随包 config/model.json', facModel.reasoning === 'none', JSON.stringify(facModel.reasoning));
    check('取值表由内核给出（界面照它画下拉，不自己抄一份字面值）',
      JSON.stringify(store.REASONING_LEVELS) === JSON.stringify(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
      JSON.stringify(store.REASONING_LEVELS));

    // 用户配着自己的端点（1b 段留下的 MOCK），这里只动兜底卡片
    store.saveSettings({ fallback: { llm: { ...FB, reasoning: 'high' } } });
    const g1 = store.getSettings();
    check('卡片里填的思考强度落到兜底那份上', g1.fallback.llm.reasoning === 'high');
    check('★ 用户自己那套**不带**思考强度（在哪儿调都一样，动不到他正在用的模型）',
      g1.model.reasoning === '', JSON.stringify(g1.model.reasoning));

    // 真正决定行为的一步：这个字段到底有没有进 HTTP body
    const ag = new Agent({ getSettings: () => store.getSettings(), emit: () => {}, askUser: async () => ({ approved: true, note: '' }) });
    const ownSess = sessionLib.createSession({ projectId: 'p-reason', name: 'x', programId: 'chat' });
    const pinSess = sessionLib.createSession({ projectId: 'p-reason', name: 'y', programId: 'default-llm' });
    await model.streamChat(ag.modelConfig(ownSess), { messages: [{ role: 'user', content: 'hi' }], onEvent: () => {} });
    check('★ 走自己的端点：请求体里**没有** reasoning_effort',
      !('reasoning_effort' in (global.__lastChatReq || {})),
      'reasoning_effort=' + JSON.stringify((global.__lastChatReq || {}).reasoning_effort));
    check('对照：这一发确实是打给用户那套的（模型名对得上）',
      (global.__lastChatReq || {}).model === 'mock-model', JSON.stringify((global.__lastChatReq || {}).model));
    await model.streamChat(ag.modelConfig(pinSess), { messages: [{ role: 'user', content: 'hi' }], onEvent: () => {} });
    check('同一个设置下，专用会话的请求体里带上了 reasoning_effort=high',
      (global.__lastChatReq || {}).reasoning_effort === 'high',
      JSON.stringify((global.__lastChatReq || {}).reasoning_effort));
    check('对照：这一发打的是兜底那份（模型名不是用户那个）',
      (global.__lastChatReq || {}).model === FB.model, JSON.stringify((global.__lastChatReq || {}).model));

    // 上游只认那几个字面值（实测：乱填/大写一律 400）→ 这里必须拦住，别把一个必然失败的请求发出去
    store.saveSettings({ fallback: { llm: { reasoning: 'ULTRA' } } });
    check('乱填的思考强度被当成"没设"（不外发，回落出厂值）',
      store.getSettings().fallback.llm.reasoning === facModel.reasoning,
      JSON.stringify(store.getSettings().fallback.llm.reasoning));
    store.saveSettings({ fallback: { llm: { reasoning: facModel.reasoning } } });
    check('填的值 == 出厂值 → 存空串（改 config/model.json 还能跟着走）',
      JSON.parse(fs.readFileSync(store.SETTINGS_FILE, 'utf8')).fallback.llm.reasoning === '',
      JSON.stringify(JSON.parse(fs.readFileSync(store.SETTINGS_FILE, 'utf8')).fallback.llm.reasoning));
    // 还原：兜底那组回出厂（别让假端点留在后面的用例里）
    store.saveSettings({ fallback: { llm: { baseUrl: '', apiKey: '', model: '', reasoning: '' } } });
    check('还原：兜底端点回到随包 config/model.json 那份',
      store.getSettings().fallback.llm.baseUrl === facModel.baseUrl);
  }

  console.log('\n1d) 「默认模型」专用会话：端点整组走兜底，普通会话切不过来');
  {
    const MOCK = 'http://127.0.0.1:' + port + '/v1';
    // 兜底那份临时指到假端点（默认是 agnes 公网地址，冒烟里不能真联网）。
    // 模型名/钥匙/上下文都跟用户那组不同 —— 一眼就能看出请求走的是哪一套。
    const FB = { baseUrl: MOCK, apiKey: 'test-key-not-real', model: 'mock-fallback-model' };
    store.saveSettings({ fallback: { llm: FB } });
    const facModel = store.readFactory('model');
    const agentLib = require('../core/agent');
    const progs = require('../core/prompts').listPrograms();
    const pinned = progs.find((p) => p.id === 'default-llm');
    check('程序预设里有「默认模型」，且带着 modelSource=fallback',
      !!pinned && pinned.modelSource === 'fallback');
    check('它和 Omni 的能力一样（两处共用同一份模块清单，只有端点来源不同）',
      JSON.stringify(pinned.modules) === JSON.stringify(progs.find((p) => p.id === 'omni').modules));

    const ag = new Agent({ getSettings: () => store.getSettings(), emit: () => {}, askUser: async () => ({ approved: true, note: '' }) });
    const pin = sessionLib.createSession({ projectId: 'p-x', name: '默认模型', programId: 'default-llm' });
    const ownSess = sessionLib.createSession({ projectId: 'p-x', name: '普通', programId: 'omni' });
    check('按这个预设建出来的会话带 modelSource=fallback', pin.modelSource === 'fallback');
    check('普通预设建出来的是 null（跟随设置）', ownSess.modelSource === null);
    check('★ 传参塞不进来（唯一来源是程序预设 → 普通会话切不过去）',
      sessionLib.createSession({ projectId: 'p-x', programId: 'omni', modelSource: 'fallback' }).modelSource === null);

    const c1 = ag.modelConfig(pin);
    check('★ 专用会话的端点整组是兜底那份（模型名换成兜底那个）',
      c1.baseUrl === FB.baseUrl && c1.model === FB.model, JSON.stringify({ b: c1.baseUrl, m: c1.model }));
    check('★ 连钥匙也是兜底那份（不能拿用户家的钥匙去开兜底家的门）', c1.apiKey === FB.apiKey);
    const c2 = ag.modelConfig(ownSess);
    check('对照：同一时刻普通会话打的确实是用户配的那套',
      c2.baseUrl === MOCK && c2.model === 'mock-model' && c2.apiKey === '',
      JSON.stringify({ b: c2.baseUrl, m: c2.model, k: c2.apiKey }));
    check('sessionMeta 会说清这个会话走的是兜底（界面才显示得出出处）',
      agentLib.sessionMeta(pin).modelSource === 'fallback' && agentLib.sessionMeta(ownSess).modelSource === null);

    // 容量：兜底那份自带 512K，压缩阈值必须按**这个会话实际在用的端点**算。
    // 拿全局那套的 16384 去卡专用会话，等于还有 50 万 token 空间就白砍一次上下文。
    const pinCtx = store.endpointFor(store.getSettings(), 'fallback').contextLength;
    check('专用会话的容量是兜底那份自带的 512K（卡片留空 → 取配置文件的）',
      pinCtx === facModel.contextLength && pinCtx === 524288, String(pinCtx));
    const big = 'x'.repeat(90000);          // ≈2.25 万 token：越过 16384 的线，离 512K 还很远
    const entries = [];
    for (let i = 0; i < 8; i++) {
      entries.push({ id: 'e' + i, ts: Date.now() + i, type: 'message', role: 'user', parts: [{ type: 'text', text: big }] });
    }
    const mk = (modelSource) => ({ ...pin, id: 'smoke-compact-' + (modelSource || 'own'), modelSource, entries: entries.map((e) => ({ ...e })), compaction: null });
    const msgs = [{ role: 'user', content: big }];

    const before = call;
    const stay = await compact.maybeCompact(store.getSettings(), mk('fallback'), msgs, {});
    check('★ 专用会话按兜底的 512K 算阈值 → 2.25 万 token 远没到线，一次摘要调用都不发',
      stay.compacted === false && call === before, JSON.stringify({ r: stay, extraCalls: call - before }));
    const ownBig = await compact.maybeCompact(store.getSettings(), mk(null), msgs, {});
    check('反向对照：同一条消息在用户那套（16384）里就该压 —— 证明上一条不是"什么都没发生"',
      ownBig.compacted === true && call === before + 1, JSON.stringify({ r: ownBig, extraCalls: call - before }));
    // 摘要这次调用也得打对地方（不然会出现"对话打 A 家、摘要打 B 家"）
    check('摘要请求走的是同一个会话的端点（不是拿用户那套去压专用会话）',
      (global.__lastChatReq || {}).model === 'mock-model', JSON.stringify((global.__lastChatReq || {}).model));
    store.saveSettings({ fallback: { llm: { baseUrl: '', apiKey: '', model: '' } } });   // 还原
    check('还原：兜底端点回到随包那份', store.getSettings().fallback.llm.baseUrl === facModel.baseUrl);
  }

  // 运行日志：冒烟里也真开一份（默认不 init 就是关的），这样"整轮对话该产出哪些日志行"
  // 有断言兜底 —— 免得哪天埋点被误删，又要等出事时才发现没记录。日志写到 TMP 下，不碰仓库 logs/。
  const RUNLOG_DIR = path.join(TMP, 'logs');
  runlog.init({ dataDir: path.join(TMP, 'data'), logDir: RUNLOG_DIR });

  console.log('1) 数据层');
  const project = store.createProject('测试项目', path.join(TMP, 'workspace'));
  check('创建项目', !!project.id && fs.existsSync(project.cwd));
  const session = sessionLib.createSession({ projectId: project.id, name: '冒烟', programId: 'coder' });
  session.instruction = require('../core/prompts').PROMPTS.coder;
  check('创建会话（模块数 ' + session.modules.length + '）', session.modules.includes('fs') && session.modules.includes('shell'));

  console.log('\n2) 工具注册表');
  check('别名解析 shell_command', tools.resolveTool('shell_command') && tools.resolveTool('shell_command').module === 'shell');
  check('未知工具返回 null', tools.resolveTool('nope_tool') === null);
  const schemas = tools.schemasFor(['read_file_lines', 'write_file']);
  check('按别名生成 schema', schemas.length === 2 && schemas[0].type === 'function');
  check('工具数量 ' + tools.ALL.length, tools.ALL.length >= 12);
  // office 工具与引擎是绑死的：引擎在就 2 个，引擎不在就必须一个都不注册。
  // 后者才是真正要守的不变式 —— 「注册了但必然失败」的工具会把模型带进重试死循环。
  const officeMod = require('../core/tools/office');
  const officeCount = tools.ALL.filter((t) => t.module === 'office').length;
  check(
    `office 工具与引擎一致（引擎${officeMod.engineUsable() ? '在' : '不在'}，注册 ${officeCount} 个）`,
    officeCount === (officeMod.engineUsable() ? 2 : 0),
  );

  console.log('\n3) 风险分类器');
  check('ls 是 low', classifyCommand('ls -la').risk === 'low');
  check('npm install 是 medium', classifyCommand('npm install left-pad').risk === 'medium');
  check('git reset --hard 是 high', classifyCommand('git reset --hard HEAD~3').risk === 'high');
  check('rm -rf / 是 too_destructive', classifyCommand('rm -rf /').risk === 'too_destructive');

  console.log('\n4) 完整一轮（流式 + 工具调用 + 落盘）');
  const events = [];
  const agent = new Agent({
    getSettings: () => store.getSettings(),
    emit: (ev) => events.push(ev),
    askUser: async () => ({ approved: true, note: '测试自动批准' }),
  });
  sessionLib.userMessage(session, '在 notes 目录建一个 hello.txt');
  // 计数用**增量**而不是绝对值：call 是假端点的全局计数，前面几段（思考强度、
  // 专用会话、压缩阈值）各自也发过请求。写死"共 2 次"会把那些段一起算进来 ——
  // 那样一加用例就红，且红得与这里无关。
  const callsBeforeTurn = call;
  const r = await agent.runTurn(session);
  check('runTurn 成功', r.ok === true, JSON.stringify(r));
  check('共调用模型 2 次', call - callsBeforeTurn === 2, '实际 ' + (call - callsBeforeTurn));
  check('模型看到的工具里有 write_file', (global.__lastToolNames || []).includes('write_file'));
  check('第二轮消息里带上了 tool 结果', (global.__lastMessages || []).some((m) => m.role === 'tool'));
  check('文件已创建', fs.existsSync(path.join(project.cwd, 'notes', 'hello.txt')));
  check('文件内容正确', fs.readFileSync(path.join(project.cwd, 'notes', 'hello.txt'), 'utf8').startsWith('hello hatch'));
  const summary = session.entries.find((e) => e.type === 'turnSummary');
  check('写了 turnSummary', !!summary && summary.files.length === 1, JSON.stringify(summary && summary.files));
  check('summary 记录了新增行', summary && summary.files[0].added >= 2);
  check('推送了流式 delta 事件', events.some((e) => e.type === 'assistant:delta'));
  check('推送了工具开始/结束事件', events.some((e) => e.type === 'tool:start') && events.some((e) => e.type === 'tool:end'));
  check('推送了 turn:end', events.some((e) => e.type === 'turn:end'));

  // 4b) 早期抛错必须释放 running 锁，并且补发 turn:end。
  // 回归的是一个真实死锁：锁在原 try 之外就上了，而 getSettings() 抛错时 finally 跑不到 →
  // running 锁不释放 → 这个会话之后每次发送都被判成"正在运行中"，界面停在"运行中"再也发不出消息。
  const lockSession = { ...session, id: 'smoke-lock-' + Date.now(), entries: [...session.entries] };
  const lockEvents = [];
  const badAgent = new Agent({
    getSettings: () => { throw new Error('设置文件损坏（模拟）'); },
    emit: (ev) => lockEvents.push(ev),
    askUser: async () => ({ approved: true, note: '' }),
  });
  let lockRes = null;
  await badAgent.runTurn(lockSession).then((r) => { lockRes = r; }, () => { lockRes = 'rejected'; });
  check('getSettings 抛错被折成本轮的失败结果（而不是炸穿调用方）',
    lockRes && lockRes.ok === false && lockRes.reason === 'error', JSON.stringify(lockRes));
  check('错误落成会话里的 critical 记录（用户看得见）',
    lockSession.entries.some((e) => e.type === 'error' && e.critical === true));
  check('抛错后 running 锁被释放（否则该会话永久发不出消息）', badAgent.isRunning(lockSession.id) === false);
  check('抛错也会补发 turn:end（界面才能从"运行中"复位）', lockEvents.some((e) => e.type === 'turn:end'));

  // 用量：累计 ≠ 上下文占用，两个都要对（meta 挂在 session:update 上）
  const meta = (events.filter((e) => e.type === 'session:update').pop() || {}).meta;
  const u = (meta && meta.usage) || {};
  check('usage 记了 2 次调用', u.calls === 2, JSON.stringify(u));
  check('usage 累计输入 = 60+100', u.promptTokens === 160, String(u.promptTokens));
  check('usage 累计输出 = 10+20', u.completionTokens === 30, String(u.completionTokens));
  check('lastPromptTokens 是最后一次的 100（上下文占用）', u.lastPromptTokens === 100, String(u.lastPromptTokens));
  check('lastCompletionTokens 是最后一次的 20', u.lastCompletionTokens === 20, String(u.lastCompletionTokens));

  // 4c) 运行日志。
  // 这是"请求停不下来"那类问题唯一的事后依据 —— 出事时磁盘上必须已经有一份完整记录，
  // 不能等到复盘时才发现埋点被删了/写歪了。所以这里对**日志的产出**做断言，而不是只测函数返回。
  console.log('\n4c) 运行日志（事后排障的唯一依据）');
  const runLogFile = runlog.logFile();
  check('日志文件名按天分：run-YYYY-MM-DD.log',
    /run-\d{4}-\d{2}-\d{2}\.log$/.test(runLogFile || ''), String(runLogFile));
  const logLines = (runLogFile && fs.existsSync(runLogFile) ? fs.readFileSync(runLogFile, 'utf8') : '')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));   // 顺便验证每行都是合法 JSON
  const kinds = logLines.map((l) => l.kind);
  check('写了 app.start（能看出是哪次启动、什么运行时）',
    logLines.some((l) => l.kind === 'app.start' && l.pid), JSON.stringify(kinds));
  check('轮次边界记了起止', kinds.filter((k) => k === 'turn').length >= 2, JSON.stringify(kinds));
  check('模型请求记了发起与开销', kinds.includes('model.start') && kinds.includes('model.call'), JSON.stringify(kinds));

  const mc = logLines.filter((l) => l.kind === 'model.call');
  check('每次模型调用都有耗时与 token（共 2 次）',
    mc.length === 2 && mc.every((l) => typeof l.durationMs === 'number' && l.ok === true),
    JSON.stringify(mc));
  check('模型开销的 token 数正确（末次 100 / 20）',
    !!mc[1] && mc[1].promptTokens === 100 && mc[1].completionTokens === 20, JSON.stringify(mc[1] || null));

  const tc = logLines.filter((l) => l.kind === 'tool.call');
  check('工具调用记了名称、耗时、成功状态（★ 成功也记，不只记失败）',
    tc.length === 1 && tc[0].tool === 'write_file' && typeof tc[0].durationMs === 'number' && tc[0].ok === true,
    JSON.stringify(tc));
  check('工具调用记了参数（复盘时要知道它拿什么去调的）',
    !!tc[0] && !!tc[0].args && tc[0].args.relativePath === 'notes/hello.txt', JSON.stringify(tc[0] && tc[0].args));
  check('失败才带 error 字段，成功时为 undefined（不塞无意义字段）',
    !!tc[0] && tc[0].error === undefined);

  // 脱敏：密钥绝不能落进日志文件（它是纯文本、还可能被随手发出去）
  runlog.log('probe.secret', { apiKey: 'sk-abcdef1234567890', nested: { authorization: 'Bearer topsecret' } });
  const logText = fs.readFileSync(runLogFile, 'utf8');
  check('密钥被脱敏，不落盘',
    !logText.includes('sk-abcdef1234567890') && !logText.includes('topsecret') && logText.includes('***7890'),
    logText.split('\n').filter((l) => l.includes('probe.secret')).join(''));

  // 关掉后不能再写（测试环境可整体关闭）
  process.env.HATCH_RUN_LOG = '0';
  const offInit = runlog.init({ logDir: RUNLOG_DIR });
  const beforeOff = fs.readFileSync(runLogFile, 'utf8').split('\n').filter(Boolean).length;
  runlog.log('should.not.appear', { x: 1 });
  const offText = fs.readFileSync(runLogFile, 'utf8');
  check('HATCH_RUN_LOG=0 时不写任何东西（init 返回 false，isEnabled 为假）',
    offInit === false && runlog.isEnabled() === false
      && !offText.includes('should.not.appear')
      && offText.split('\n').filter(Boolean).length === beforeOff,
    'init=' + offInit + ' 行数 ' + beforeOff + ' → ' + offText.split('\n').filter(Boolean).length);
  delete process.env.HATCH_RUN_LOG;

  // ---------- 4d) 生图工具（打假生图端点：不联网、不花钱）----------
  console.log('\n4d) 生图工具 generate_image');
  {
    const P = require('../core/prompts');
    const MOCK = 'http://127.0.0.1:' + port + '/v1';
    const imgTool = tools.resolveTool('generate_image');
    check('生图工具注册在 image 模块下', !!imgTool && imgTool.module === 'image');
    check('工具目录里能看到它（界面「工具」页读的就是这份）',
      tools.catalog().some((t) => t.alias === 'generate_image'));
    check('omni / coder 两个预设都挂上了 image 模块',
      P.getProgram('omni').modules.includes('image') && P.getProgram('coder').modules.includes('image'));
    check('★ schema 能生成给模型（不然模型根本不知道有这个工具）',
      tools.schemasFor(P.toolAliasesFor({ modules: ['image'] }, ['image'])).some((s) => s.function.name === 'generate_image'));

    store.saveSettings({ fallback: { image: { baseUrl: MOCK, apiKey: 'test-key-not-real', model: 'mock-image-model' } } });
    const mkCtx = () => ({ workingDir: project.cwd, settings: store.getSettings(), log: () => {} });
    global.__imageCalls = 0;

    const r1 = await tools.execute('generate_image', JSON.stringify({ prompt: '窗台上的一只猫', size: '2K', ratio: '16:9', save_as: 'cat' }), mkCtx());
    check('生图跑通', r1.isError !== true, r1.text);
    const req1 = global.__lastImageReq || {};
    check('假端点确实收到了 1 次请求', global.__imageCalls === 1, String(global.__imageCalls));
    check('带上了 Authorization', /^Bearer test-key-not-real$/.test(global.__lastImageAuth || ''), String(global.__lastImageAuth));
    check('请求形状照文档：response_format 在 extra_body 里，不在顶层',
      !('response_format' in req1) && !!req1.extra_body && req1.extra_body.response_format === 'url',
      JSON.stringify(req1));
    check('size / ratio / model 原样传下去',
      req1.size === '2K' && req1.ratio === '16:9' && req1.model === 'mock-image-model', JSON.stringify(req1));
    const catFile = path.join(project.cwd, 'cat.png');
    check('图真的落进工作目录', fs.existsSync(catFile), catFile);
    check('尺寸是从字节里读出来的（4×4 就是那张假 PNG 的真实尺寸）', /4×4/.test(r1.text), r1.text.split('\n')[0]);
    check('结果里给了相对路径', /cat\.png/.test(r1.text));
    check('revised_prompt 有就带出来', /改写后的提示词/.test(r1.text));
    check('★ 明确告诉模型它看不到这张图（别让它假装看过）', /看不到/.test(r1.text));
    check('★ 带上了 images（界面靠它把图贴出来）',
      Array.isArray(r1.images) && r1.images[0].rel === 'cat.png' && r1.images[0].mime === 'image/png',
      JSON.stringify(r1.images));

    const r2 = await tools.execute('generate_image', JSON.stringify({ prompt: 'USE_B64 再来一张', save_as: 'cat' }), mkCtx());
    check('b64_json 那种返回形状也认（不是只认 url）',
      r2.isError !== true && fs.existsSync(path.join(project.cwd, 'cat-1.png')), r2.text);
    check('同名不覆盖（第二次写成 cat-1.png）', !!r2.images && r2.images[0].rel === 'cat-1.png', JSON.stringify(r2.images));

    // 三处都要有，缺一处用户就看不见图：事件日志 → 转录 → 界面
    sessionLib.toolMessage(session, { callId: 'img_1', name: 'generate_image', text: r1.text, isError: false, images: r1.images });
    const trow = sessionLib.renderTranscript(session).filter((r) => r.kind === 'tool').pop();
    check('转录里带上了图片（界面按 rel 走 files:preview 取像素）',
      trow.images.length === 1 && trow.images[0].rel === 'cat.png', JSON.stringify(trow.images));
    const toolMsgs = sessionLib.renderMessages(session).filter((m) => m.role === 'tool');
    check('★ 工具产出的图不会漏进模型消息（OpenAI 只有 user 能带图，混进去就是 400）',
      toolMsgs.every((m) => typeof m.content === 'string' && !m.content.includes('data:image')));

    // 出错路径：每一条都要"当场说清楚、别白跑"
    const r3 = await tools.execute('generate_image', JSON.stringify({ prompt: 'x', images: ['../outside.png'] }), mkCtx());
    check('参考图越界被拦（工作目录外一律不许读）', r3.isError === true && /越界/.test(r3.text), r3.text);
    const r4 = await tools.execute('generate_image', JSON.stringify({ prompt: 'x', size: '8K' }), mkCtx());
    check('非法 size 当场回绝（不白跑一趟）', r4.isError === true && /size/.test(r4.text), r4.text);
    const r5 = await tools.execute('generate_image', JSON.stringify({ prompt: 'FAIL401' }), mkCtx());
    check('上游 401 给的是"去核对 key"这种能照做的提示',
      r5.isError === true && /401/.test(r5.text) && /key/.test(r5.text), r5.text);

    // 卡片里把 Key 清掉 = 回落到出厂那份（"留空 = 用出厂值"这条对 key 也成立）
    store.saveSettings({ fallback: { image: { apiKey: '' } } });
    check('卡片里清空 Key = 回落到出厂那份',
      store.getSettings().fallback.image.apiKey === store.readFactory('image').apiKey);

    // 真的"没有 key"这条分支：手搓一份 ctx（出厂那份现在带着 key，走 store 到不了这个状态）。
    // 判据是**一条请求都不许发** —— 没有 key 打过去只会白等一轮再拿个 401。
    const beforeMissing = global.__imageCalls;
    const noKeyCtx = {
      workingDir: project.cwd,
      settings: { fallback: { image: { baseUrl: MOCK, apiKey: '', model: 'mock-image-model' } } },
    };
    const r6 = await tools.execute('generate_image', JSON.stringify({ prompt: 'x' }), noKeyCtx);
    check('★ 没配 key 时不发请求，直接说明去哪填',
      r6.isError === true && global.__imageCalls === beforeMissing && /设置/.test(r6.text), r6.text);
    // 端点也没配（出厂文件被删/没打包进去时就是这个状态）
    const noCfgCtx = { workingDir: project.cwd, settings: { fallback: { image: { baseUrl: '', apiKey: '', model: '' } } } };
    const r7 = await tools.execute('generate_image', JSON.stringify({ prompt: 'x' }), noCfgCtx);
    check('端点没配时也是"没发请求 + 说清楚去哪配"',
      r7.isError === true && global.__imageCalls === beforeMissing && /Base URL/.test(r7.text), r7.text);
    store.saveSettings({ fallback: { image: { baseUrl: '', apiKey: '', model: '' } } });   // 还原
    check('还原后生图兜底又回到出厂那份（config/image.json）',
      store.getSettings().fallback.image.model === store.readFactory('image').model);
  }

  console.log('\n5) 检查点与回滚');
  const log = checkpoints.readLog(project.id);
  check('检查点日志有记录', log.length >= 1, '条数 ' + log.length);
  check('记录类型是 absent（新建文件）', log[0].kind === 'absent');
  const userEntry = session.entries.find((e) => e.type === 'message' && e.role === 'user');
  const rb = checkpoints.rollbackTo(project.id, session.id, userEntry.ts);
  check('回滚删掉了新建文件', rb.deleted.length === 1 && !fs.existsSync(path.join(project.cwd, 'notes', 'hello.txt')), JSON.stringify(rb));

  // 用户报过的那条：恢复之后再点一次「恢复」→
  //   ERR_INVALID_ARG_TYPE: The "path" argument must be of type string. Received null
  // 根因：revertFile 取"最后一条记录"，而恢复动作自己也写一条 kind:'restored'、sha:null
  // 的记录，null 被当 blob 文件名喂给 path.join 就炸了。改成只认 snapshot 写的记录
  // （absent / modified），顺带变成幂等。
  const helloPath = path.join(project.cwd, 'notes', 'hello.txt');
  const tailRec = checkpoints.listForPath(project.id, helloPath).slice(-1)[0];
  check('回滚后该路径最后一条记录是 restored 且 sha 为 null（就是崩的那条）',
    !!tailRec && tailRec.kind === 'restored' && tailRec.sha === null, JSON.stringify(tailRec));
  const revertAgain = checkpoints.revertFile(project.id, session.id, helloPath);
  check('再点一次「恢复」不抛异常（幂等）', revertAgain.ok === true, JSON.stringify(revertAgain));
  const nullPath = checkpoints.revertFile(project.id, session.id, null);
  check('路径传 null 时给可读错误而不是抛异常', nullPath.ok === false && !!nullPath.message, JSON.stringify(nullPath));
  const fList = checkpoints.listFiles(project.id);
  check('listFiles 每个文件一行、不含 restored，并带改动次数',
    fList.length === 1 && fList[0].path === helloPath && fList[0].changes === 1 && fList[0].kind === 'absent',
    JSON.stringify(fList));
  check('listRecent 也已经滤掉没有路径的坏记录', checkpoints.listRecent(project.id).every((r) => typeof r.path === 'string' && r.path));

  // 目录被删掉过时，恢复要能把目录补回来（否则 copyFileSync 直接 ENOENT，
  // 又会以 "操作失败：Error invoking remote method …" 的形式糊到用户脸上）
  {
    const dir2 = path.join(project.cwd, 'deep', 'nested');
    fs.mkdirSync(dir2, { recursive: true });
    const f3 = path.join(dir2, 'note.txt');
    fs.writeFileSync(f3, 'BEFORE-DIR-DELETE');
    checkpoints.snapshot(project.id, session.id, f3);          // 记下"改动前"的内容
    fs.writeFileSync(f3, 'AFTER');
    fs.rmSync(path.join(project.cwd, 'deep'), { recursive: true, force: true });   // 整个目录没了
    const r3 = checkpoints.revertFile(project.id, session.id, f3);
    check('目录被删掉过也能恢复（会补建目录）',
      r3.ok === true && fs.existsSync(f3) && fs.readFileSync(f3, 'utf8') === 'BEFORE-DIR-DELETE', JSON.stringify(r3));
  }

  // 构造一段"只恢复过、没改过"的坏日志：第一条就是 restored（sha null）。
  // 老代码的 rollbackTo 会拿它当 baseline → 同样 path.join(dir, null) 抛错。
  {
    const p2 = store.createProject('坏日志项目', path.join(TMP, 'workspace2'));
    const f2 = path.join(p2.cwd, 'x.txt');
    const cpDir = path.join(store.projectDataDir(p2.id), 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(
      path.join(cpDir, 'log.jsonl'),
      [
        JSON.stringify({ ts: 1, projectId: p2.id, sessionId: 's', path: f2, kind: 'restored', sha: null, size: 0 }),
        JSON.stringify({ ts: 2, projectId: p2.id, sessionId: 's', path: f2, kind: 'modified', sha: null, size: 0 }),
        '',
      ].join('\n')
    );
    let rb2 = null;
    let threw = null;
    try { rb2 = checkpoints.rollbackTo(p2.id, 's', 0); } catch (e) { threw = e.message; }
    check('日志里混着 restored / sha 为 null 的坏记录时，回滚也不炸（记为跳过）',
      threw === null && rb2 && rb2.skipped.length === 1, { threw, rb2 });
  }

  console.log('\n6) 会话持久化与分叉');
  store.saveSession(project.id, session);
  const list = store.listSessions(project.id);
  check('会话出现在列表', list.some((s) => s.id === session.id));
  const loaded = store.loadSession(project.id, session.id);
  check('重新读取事件数一致', loaded.entries.length === session.entries.length);
  const forked = sessionLib.forkSession(loaded, loaded.entries[0].id);
  check('分叉得到更短的日志', forked.entries.length <= loaded.entries.length && forked.id !== loaded.id);

  // ⚠️ 这一段**故意留着这张表`deleteProject` 的语义**：删除项目 = 只摘索引。
  // 用户要的就是这个（"删除对话只是删除这个对话索引"），所以断言必须钉住"磁盘什么都不删"，
  // 否则以后有人顺手加个 rmSync 就会把用户的会话记录和检查点一起带走。
  console.log('\n6b) 删除项目 = 只摘索引（磁盘一律不删）');
  {
    // 造一个"工作目录在自己真实目录里"的项目：这是最危险的那种（用户选的目录不是我们的）
    const outside = path.join(TMP, 'user-owned-dir');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'user-file.txt'), '用户的文件');
    const victim = store.createProject('待删除项目', outside);
    const vSess = sessionLib.createSession({ projectId: victim.id, name: '待删会话', programId: 'coder' });
    vSess.instruction = require('../core/prompts').PROMPTS.coder;
    store.saveSession(victim.id, vSess);
    const vDir = store.projectDataDir(victim.id);
    const vSessionFile = store.sessionFile(victim.id, vSess.id);
    check('删除前：记录目录与会话文件都在', fs.existsSync(vDir) && fs.existsSync(vSessionFile), { vDir });

    const info = store.projectDeleteInfo(victim.id);
    check('deleteInfo 报出会话数与工作目录', info && info.sessionCount === 1 && info.cwd === outside,
      info && JSON.stringify({ n: info.sessionCount, cwd: info.cwd }));
    check('deleteInfo 认出这是用户自己的目录（不是程序自建的 workspace）',
      info && info.selfWorkspace === false, info && info.selfWorkspace);

    // 自动生成的 workspace 那种（cwd 就是程序在数据目录里给它建的那个）也要判对
    const autoProj = store.createProject('自动 workspace 项目', null);
    const autoInfo = store.projectDeleteInfo(autoProj.id);
    check('deleteInfo 认出自动创建的 workspace',
      autoInfo && autoInfo.selfWorkspace === true, autoInfo && JSON.stringify({ cwd: autoInfo.cwd, dir: autoInfo.recordDir }));

    const okDel = store.deleteProject(victim.id);
    check('deleteProject 返回 true', okDel === true);
    check('项目从列表里消失', !store.listProjects().some((p) => p.id === victim.id));
    check('getProject 也读不到了', store.getProject(victim.id) === null);
    check('deleteProject 幂等：删第二次返回 false', store.deleteProject(victim.id) === false);

    // ★ 核心三条：磁盘上什么都不许少
    check('★ 记录目录仍然在（会话/检查点都保留）', fs.existsSync(vDir), vDir);
    check('★ 会话记录文件仍然在', fs.existsSync(vSessionFile), vSessionFile);
    check('★ 用户的工作目录与里面的文件一根汗毛都没动',
      fs.existsSync(outside) && fs.readFileSync(path.join(outside, 'user-file.txt'), 'utf8') === '用户的文件', outside);
    // 新模型：记录挂在**工程文件夹**上，索引只是指针。指针摘掉后按旧 id 自然查不到 ——
    // 但重新打开那个文件夹就该原样认回来（这才是"删索引不删数据"的完整证明）。
    check('摘掉索引后，按旧 id 已经查不到会话（记录不挂在索引上）',
      !(store.listSessions(victim.id) || []).some((s) => s.id === vSess.id));
    {
      const reopened = store.createProject('重新打开', outside);
      check('★ 重新打开同一个文件夹，会话原样都在（记录跟着文件夹走）',
        (store.listSessions(reopened.id) || []).some((s) => s.id === vSess.id), { id: reopened.id });
      check('★ 同一个文件夹再打开一次不会变出第二个工程（按地址认工程）',
        store.createProject('再开一次', outside).id === reopened.id);
      store.deleteProject(reopened.id);
    }

    // 不能误伤别的项目
    check('别的项目不受影响（原测试项目还在）', store.listProjects().some((p) => p.id === project.id));
    check('deleteInfo 对不存在的项目返回 null', store.projectDeleteInfo('nope-id-xxx') === null);
    store.deleteProject(autoProj.id);   // 收尾：别把自动 workspace 那个项目留在列表里影响后面
  }

  console.log('\n7) 审批闸门');
  const shellTool = tools.resolveTool('shell_command');
  const g1 = await approvals.gate(store.getSettings(), { tool: shellTool, args: { command: 'ls' }, session });
  check('低风险命令直接放行', g1.action === 'allow' && g1.risk === 'low', JSON.stringify(g1));
  const settingsAuto = store.saveSettings({ approval: { mode: 'auto' } });
  const g2 = await approvals.gate(settingsAuto, { tool: shellTool, args: { command: 'rm -rf /' }, session });
  check('极高危命令被拒（auto 模式）', g2.action === 'deny', JSON.stringify(g2));
  store.saveSettings({ approval: { mode: 'always-ask' } });
  const g3 = await approvals.gate(store.getSettings(), { tool: shellTool, args: { command: 'git push --force' }, session });
  check('高风险命令要求人工确认', g3.action === 'ask', JSON.stringify(g3));
  check('always-ask 也先把评审意见取回来（人要有依据再拍板）', g3.reviewer && g3.reviewer.ok === true, JSON.stringify(g3.reviewer));
  const fsTool = tools.resolveTool('write_file');
  const g4 = await approvals.gate(store.getSettings(), { tool: fsTool, args: { relativePath: 'a.txt', content: 'x' }, session });
  // 「每次询问」是用户明选的模式，不能被"项目内文件改动直接放行"越过 ——
  // 否则最常见的写文件恰好都是 fs 模块，全被静默放行，用户等于没被问过。
  check('always-ask 下项目内写文件也要问人', g4.action === 'ask' && g4.risk === 'medium', JSON.stringify(g4));
  const settingsReviewer = store.saveSettings({ approval: { mode: 'reviewer' } });
  const g5 = await approvals.gate(settingsReviewer, { tool: fsTool, args: { relativePath: 'a.txt', content: 'x' }, session });
  check('reviewer 模式下项目内写文件不打扰用户', g5.action === 'allow', JSON.stringify(g5));

  console.log('\n7b) 评审子会话（三轴）');
  store.saveSettings({ approval: { mode: 'reviewer' } });
  // parseResult 的边界：没有 <result>、或 JSON 里没有三轴键，都算解析失败
  check('parseResult 认 <result> 块', JSON.stringify(approvals.parseResult('<result>{"risk":"high","correct":false}</result>')) === '{"risk":"high","correct":false}');
  check('parseResult 拒绝无关 JSON', approvals.parseResult('看到 {"foo":1} 这样的东西') === null);
  check('parseResult 拒绝纯文本', approvals.parseResult('我觉得没问题') === null);
  check('parseResult 容忍前后闲聊', approvals.parseResult('分析如下：\n<result>{"risk":"low","authorization":"neutral","correct":true}</result>\n完毕') !== null);

  // 评审会自己调只读工具取证，再出裁决
  const gRev = await approvals.gate(store.getSettings(), {
    tool: shellTool,
    args: { command: 'npm install REVIEW_READ' },
    session,
  });
  check('reviewer 模式：中等风险命令交给评审', !!gRev.reviewer, JSON.stringify(gRev));
  check('评审拿到了只读工具', (global.__lastReviewTools || []).length === 3 && (global.__lastReviewTools || []).includes('read_file_lines'), JSON.stringify(global.__lastReviewTools));
  check('评审出了可解析的裁决', gRev.reviewer && gRev.reviewer.ok === true, JSON.stringify(gRev.reviewer));
  check('评审多步后仍收敛', gRev.reviewer && gRev.reviewer.steps <= 4, String(gRev.reviewer && gRev.reviewer.steps));
  check('三轴裁决 → 放行', gRev.action === 'allow', JSON.stringify(gRev));

  // 评审坏了：默认必须转人工，而不是默默放行
  const gFail = await approvals.gate(store.getSettings(), {
    tool: shellTool,
    args: { command: 'npm install REVIEW_FAIL' },
    session,
  });
  check('评审输出无法解析 → 转人工（失败安全）', gFail.action === 'ask' && gFail.reviewerFailed === true, JSON.stringify(gFail));
  const allowOnFail = store.saveSettings({ approval: { onReviewerFailure: 'allow' } });
  const gFail2 = await approvals.gate(allowOnFail, {
    tool: shellTool,
    args: { command: 'npm install REVIEW_FAIL' },
    session,
  });
  check('设成 allow 时才放行', gFail2.action === 'allow', JSON.stringify(gFail2));
  store.saveSettings({ approval: { onReviewerFailure: 'ask' } });

  console.log('\n8) 上下文渲染');
  const msgs = sessionLib.renderMessages(session);
  check('第一条是 system', msgs[0].role === 'system' && msgs[0].content.includes('One Harness'));
  check('system 里带环境块', msgs[0].content.includes('<environment>'));
  check('assistant 消息带 tool_calls', msgs.some((m) => m.role === 'assistant' && m.tool_calls));
  check('tool 消息带 tool_call_id', msgs.some((m) => m.role === 'tool' && m.tool_call_id));

  // 闸门的决定要跟着工具结果一起落盘，否则刷新界面后卡片上就看不到「谁放行的」
  const toolRows = sessionLib.renderTranscript(session).filter((r) => r.kind === 'tool');
  check('工具结果里记了闸门决定', toolRows.length > 0 && !!toolRows[0].decision, JSON.stringify(toolRows[0] && toolRows[0].decision));
  check('决定里有 action 与 risk', !!(toolRows[0].decision && toolRows[0].decision.action && toolRows[0].decision.risk), JSON.stringify(toolRows[0] && toolRows[0].decision));

  console.log('\n9) 布局状态（ui-state/*.json）');
  const uistate = require('../core/uistate');
  const uiGlobal0 = uistate.readGlobal();
  check('global 有默认窗口 bounds', uiGlobal0.lastActiveWindowBounds.width === 1360 && uiGlobal0.lastActiveWindowBounds.x === null, JSON.stringify(uiGlobal0.lastActiveWindowBounds));
  const w0 = uistate.readWindow('main');
  check('窗口默认左栏 220 / 右栏 345', w0.workspace.leftSidebarWidth === 220 && w0.workspace.rightPanelWidth === 345);
  check('窗口默认右栏视图是 devRightPanelView=files（名字照抄 Bionic）', w0.workspace.devRightPanelView === 'files');
  check('面板块叫 workspace（对应 Bionic 的 bionic 段）', !!w0.workspace && w0.projectIdentifier === null);
  check('当前项目在顶层 windowContext.activeProjectIdentifier（Bionic 的形状）',
    !!w0.windowContext && w0.windowContext.type === 'workspace' && w0.windowContext.activeProjectIdentifier === null && Array.isArray(w0.windowContext.projectIdentifiers));
  check('global 里没有 expandedKvConfigSections（Bionic 把它放在 window 层）',
    !('expandedKvConfigSections' in uistate.readGlobal()) && Array.isArray(w0.expandedKvConfigSections));

  const w1 = uistate.patchWindow('main', {
    workspace: { leftSidebarWidth: 10, rightPanelWidth: 9999, devRightPanelView: 'tools', leftSidebarIsCollapsed: true },
    windowContext: { type: 'workspace', projectIdentifiers: ['p1', 'p2'], activeProjectIdentifier: 'p2' },
  });
  check('越界宽度被夹回合法区间', w1.workspace.leftSidebarWidth === 168 && w1.workspace.rightPanelWidth === 640, JSON.stringify(w1.workspace));
  check('折叠状态与视图写进去了', w1.workspace.leftSidebarIsCollapsed === true && w1.workspace.devRightPanelView === 'tools');
  check('windowContext 写进去了', w1.windowContext.activeProjectIdentifier === 'p2' && w1.windowContext.projectIdentifiers.length === 2);

  // 旧字段名要能迁移（对齐 Bionic 时改过名，不能让用户已有的布局白丢）
  const wOld = uistate.patchWindow('legacy', { workspace: { rightPanelView: 'tools', activeProjectId: 'proj-x' } });
  check('旧名 rightPanelView 自动迁到 devRightPanelView',
    wOld.workspace.devRightPanelView === 'tools' && !('rightPanelView' in wOld.workspace), JSON.stringify(wOld.workspace));
  check('旧名 workspace.activeProjectId 自动迁到 windowContext',
    wOld.windowContext.activeProjectIdentifier === 'proj-x' && !('activeProjectId' in wOld.workspace));

  const rf = uistate.windowFile('main');
  check('布局文件按 window-<key>.json 命名', path.basename(rf) === 'window-main.json', path.basename(rf));
  const onDisk = JSON.parse(fs.readFileSync(rf, 'utf8'));
  check('重新读盘拿到同样的值', onDisk.workspace.leftSidebarWidth === 168 && onDisk.workspace.devRightPanelView === 'tools');

  uistate.saveWindowBounds({ x: 12, y: 34, width: 1200, height: 800 });
  const uiGlobal1 = uistate.readGlobal();
  check('窗口几何落到 global.lastActiveWindowBounds', uiGlobal1.lastActiveWindowBounds.x === 12 && uiGlobal1.lastActiveWindowBounds.width === 1200, JSON.stringify(uiGlobal1.lastActiveWindowBounds));
  const again = uistate.saveWindowBounds({ x: 12, y: 34, width: 1200, height: 800 });
  check('几何没变时不重复写', again.width === 1200);

  uistate.registerWindow('second');
  check('registerWindow 登记窗口键并建文件', uistate.readGlobal().openedWindowKeys.includes('second') && fs.existsSync(uistate.windowFile('second')));
  uistate.removeWindow('second');
  check('removeWindow 收拾干净', !fs.existsSync(uistate.windowFile('second')) && !uistate.readGlobal().openedWindowKeys.includes('second'));

  // ---------- 「用系统默认浏览器打开」的判定（core/open-target.js） ----------
  // 起因：右栏浏览器那个按钮按了没反应 —— openPath 只吃文件系统路径，喂 URL 会
  // 返回 "Failed to open path"（字符串、不抛异常），旧代码没接，于是静默失败。
  // 这些断言钉住"什么形状该交给谁"，其中 file:/// 那条就是用户截图里的形状。
  const ot = require('../core/open-target');
  check('https 网址判为 URL（交给 openExternal）',
    ot.resolve('https://github.com/momokula123/one-harness').kind === 'url',
    JSON.stringify(ot.resolve('https://github.com/momokula123/one-harness')));
  check('大写 scheme 也认',
    ot.resolve('HTTPS://Example.com/A?b=1').scheme === 'https');
  check('file:/// URL 判为 URL —— 正是旧代码喂给 openPath 必然失败的那种形状',
    (() => { const r = ot.resolve('file:///C:/Users/Administrator/Downloads'); return r.kind === 'url' && r.target === 'file:///C:/Users/Administrator/Downloads'; })(),
    JSON.stringify(ot.resolve('file:///C:/Users/Administrator/Downloads')));
  check('Windows 盘符路径判为本地路径并转成 file://',
    (() => { const r = ot.resolve('C:\\Users\\Administrator\\Downloads'); return r.kind === 'path' && r.target === 'file:///C:/Users/Administrator/Downloads' && r.abs === 'C:\\Users\\Administrator\\Downloads'; })(),
    JSON.stringify(ot.resolve('C:\\Users\\Administrator\\Downloads')));
  check('正斜杠盘符路径同样认',
    ot.resolve('C:/Users/Administrator/Downloads').target === 'file:///C:/Users/Administrator/Downloads');
  check('路径里的中文与空格按 URL 规则转义',
    ot.resolve('C:\\Users\\Administrator\\我的 文件.html').target === 'file:///C:/Users/Administrator/%E6%88%91%E7%9A%84%20%E6%96%87%E4%BB%B6.html',
    ot.resolve('C:\\Users\\Administrator\\我的 文件.html').target);
  check('UNC 路径转成 file://server/share',
    ot.resolve('\\\\server\\share\\a.txt').target === 'file://server/share/a.txt',
    ot.resolve('\\\\server\\share\\a.txt').target);
  check('`C:foo` 这种盘符相对路径不会被误判成 scheme',
    ot.resolve('C:foo').kind === 'path', JSON.stringify(ot.resolve('C:foo')));
  check('mailto: 判为 URL（协议链接也必须走 openExternal）',
    ot.resolve('mailto:someone@example.com').kind === 'url');
  check('空串判为 empty —— 调用方必须给提示，不许静默',
    ot.resolve('   ').kind === 'empty');
  check('相对路径按 base 拼绝对',
    ot.resolve('sub/a.html', { base: 'C:\\proj' }).target === 'file:///C:/proj/sub/a.html',
    ot.resolve('sub/a.html', { base: 'C:\\proj' }).target);
  // 反向对照：证明"判成 url"不是恒真 —— 本地路径这一侧必须为 false
  check('对照：本地路径不会被判成 URL',
    ot.isUrlLike('C:\\Users\\Administrator\\Downloads') === false && ot.isUrlLike('file:///C:/x') === true);

  // ---------- 工程索引的导出 / 导入（core/project-index.js + store） ----------
  // 索引就是 projects.json 里那几行（id / 名字 / 工作目录 / 创建时间）。这组断言要钉住两件事：
  //   ① 导出的是**真文件**（判据：把它导回来能读出来，而不是只看"函数返回了 ok"）；
  //   ② 导入**只增不减**、且不把备份里的旧值盖到本机头上 —— 覆盖是静默的，不钉住就没人发现。
  const pi = require('../core/project-index');

  check('打包形状对：kind / version / count / projects',
    (() => {
      const b = pi.build([{ id: 'p1', name: '甲', cwd: 'C:/a', createdAt: 5 }], { version: 'test' });
      return b.kind === pi.KIND && b.version === pi.VERSION && b.count === 1 &&
        b.app.version === 'test' && typeof b.exportedAt === 'number' && b.projects.length === 1;
    })(), JSON.stringify(pi.build([{ id: 'p1', name: '甲', cwd: 'C:/a', createdAt: 5 }], { version: 'test' })));
  check('打包时丢掉没有 id 的记录（索引靠 id 认工程）',
    pi.build([{ name: '没有 id' }, { id: 'ok', name: '有 id' }], {}).count === 1);

  check('文件名补扩展名：没写 .json 就补上',
    pi.ensureJsonExt('D:/bak/index') === 'D:/bak/index.json');
  check('已带 .json 不重复补，大写也认',
    pi.ensureJsonExt('D:/bak/index.json') === 'D:/bak/index.json' && pi.ensureJsonExt('a.JSON') === 'a.JSON');
  check('默认文件名带本地时间到分钟（同一天导多次不会撞名）',
    pi.defaultFileName(new Date(2026, 8, 18, 9, 5)) === 'one-harness-projects-20260918-0905.json',
    pi.defaultFileName(new Date(2026, 8, 18, 9, 5)));

  check('合并只按 id 去重：同一个工作目录下的两个工程都保留（本机数据里就有一例）',
    pi.merge([], [{ id: 'x', name: 'X', cwd: 'C:/shared' }, { id: 'y', name: 'Y', cwd: 'C:/shared' }]).added === 2);
  check('备份里同一条出现两次只进一次',
    (() => { const m = pi.merge([], [{ id: 'a', name: 'A' }, { id: 'a', name: 'A2' }]); return m.added === 1 && m.skipped === 1; })());
  check('merge 不修改入参数组',
    (() => { const src = [{ id: 'a', name: 'A' }, { id: 'a', name: 'A2' }]; pi.merge([], src); return src.length === 2; })());
  check('规范化不保留外来字段（备份里的附加信息不许写回索引）',
    (() => { const p = pi.normalizeProject({ id: 'z', name: 'Z', sessions: 7, junk: true }); return p && !('sessions' in p) && !('junk' in p); })(),
    JSON.stringify(pi.normalizeProject({ id: 'z', name: 'Z', sessions: 7, junk: true })));

  const idxFile = path.join(TMP, 'idx-export.json');
  const idxBefore = store.listProjects();
  const ex = store.exportProjectIndex(idxFile, { version: 'test' });
  check('导出：文件真的落到盘上且有内容', fs.existsSync(idxFile) && ex.bytes > 0, JSON.stringify(ex));
  check('导出：count 与本机工程数一致', ex.count === idxBefore.length, ex.count + ' vs ' + idxBefore.length);
  const bundle = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  check('导出：kind 是本程序的工程索引', bundle.kind === pi.KIND);
  check('导出：记下了是哪个程序版本做的这份备份', bundle.app.version === 'test');

  const reImport = store.importProjectIndex(idxFile);
  check('把刚导出的文件导回来：一条都不新增 —— 这是"导出的是真文件"的判据',
    reImport.ok === true && reImport.added === 0 && reImport.skipped === idxBefore.length, JSON.stringify(reImport));

  // 摘掉一条索引，再导入，看它是否**只**把这一条补回来
  const idxProj = store.createProject('索引往返项目', path.join(TMP, 'idx-ws'));
  store.exportProjectIndex(idxFile, { version: 'test' });
  store.deleteProject(idxProj.id);
  check('先把这条从索引里摘掉', !store.listProjects().some((p) => p.id === idxProj.id));
  const im2 = store.importProjectIndex(idxFile);
  check('导入把摘掉的那条补回来（新增 1、其余全部跳过）',
    im2.ok === true && im2.added === 1 && im2.skipped === idxBefore.length, JSON.stringify(im2));
  const idxBack = store.getProject(idxProj.id);
  check('补回来的字段与本机原值逐项一致（这个名字/工作目录/创建时间都要还原）',
    !!idxBack && idxBack.name === '索引往返项目' && idxBack.cwd === idxProj.cwd && idxBack.createdAt === idxProj.createdAt,
    JSON.stringify(idxBack));
  check('导入的新工程：文件夹在、里面还没记录 → empty 记 1（如实说它是空工程）',
    im2.gone === 0 && im2.empty === 1, JSON.stringify({ gone: im2.gone, empty: im2.empty }));

  // ---- gone / empty 三态对照：它们说的是"工程文件夹在不在、里面有没有记录"，不是别的 ----
  // 实际场景就是换台机器导索引：记录跟着工程文件夹走，所以"文件夹在不在"决定这条指得到指不到。
  // 三态（文件夹在+有记录 / 文件夹在+没记录 / 文件夹不在）数字必须跟着变，否则就是假信号。
  store.deleteProject(idxProj.id);                                  // 摘索引，磁盘一律不动
  const diskSession = sessionLib.createSession({ projectId: idxProj.id, name: '盘上就有的会话' });
  sessionLib.userMessage(diskSession, '你好');
  store.saveSession(idxProj.id, diskSession);                       // 记录落在 <工程文件夹>/.one-harness/ 下
  const imBody = store.importProjectIndex(idxFile);
  check('文件夹在、记录也在：gone 和 empty 都是 0（不无中生有地报警）',
    imBody.ok === true && imBody.added === 1 && imBody.gone === 0 && imBody.empty === 0, JSON.stringify(imBody));
  check('而且那条正文还读得出来（导入没把它弄丢）',
    (() => { const l = store.listSessions(idxProj.id); return l.length === 1 && l[0].name === '盘上就有的会话'; })(),
    JSON.stringify(store.listSessions(idxProj.id).map((s) => s.name)));

  store.deleteProject(idxProj.id);
  fs.rmSync(path.join(idxProj.cwd, '.one-harness'), { recursive: true, force: true });
  const imNoBody = store.importProjectIndex(idxFile);
  check('对照一：文件夹还在、记录被清掉 → empty 是 1（工程在，只是空的）',
    imNoBody.ok === true && imNoBody.added === 1 && imNoBody.gone === 0 && imNoBody.empty === 1, JSON.stringify(imNoBody));

  store.deleteProject(idxProj.id);
  fs.rmSync(idxProj.cwd, { recursive: true, force: true });         // 连工程文件夹一起删
  const imGone = store.importProjectIndex(idxFile);
  check('对照二：工程文件夹都不在 → gone 是 1（指针指到空处，数字必须跟着变）',
    imGone.ok === true && imGone.added === 1 && imGone.gone === 1 && imGone.empty === 0, JSON.stringify(imGone));


  // 手工造一份"带杂质的备份"：外来字段、同 id 改名、空名字、缺 id
  const fxFile = path.join(TMP, 'idx-fixture.json');
  fs.writeFileSync(fxFile, JSON.stringify({
    kind: pi.KIND, version: 1, exportedAt: Date.now(), count: 4,
    projects: [
      { id: 'fx-a', name: '外来工程 A', cwd: 'C:/tmp/a', createdAt: 111, sessions: 7, junk: true },
      { id: idxProj.id, name: '备份里改过的名字', cwd: 'C:/tmp/zzz', createdAt: 999 },
      { id: 'fx-b', name: '' },
      { name: '没有 id' },
    ],
  }), 'utf8');
  const im3 = store.importProjectIndex(fxFile);
  check('导入杂质备份：只增不改（新增 2、已有 1 跳过、不完整 1 忽略）',
    im3.ok === true && im3.added === 2 && im3.skipped === 1 && im3.invalid === 1, JSON.stringify(im3));
  check('文件声称 4 条 —— 声明数与实际处理数都要能对上账',
    im3.declared === 4 && im3.added + im3.skipped + im3.invalid === 4, JSON.stringify(im3));
  check('★ 本机已有的工程不被备份里的旧值覆盖（名字仍是本机的）',
    store.getProject(idxProj.id).name === '索引往返项目', store.getProject(idxProj.id).name);
  check('★ 工作目录也不被覆盖',
    store.getProject(idxProj.id).cwd === idxProj.cwd, store.getProject(idxProj.id).cwd);
  check('导入写回索引的记录只有那四个字段（外来字段没被带进来）',
    (() => {
      const on = JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'projects.json'), 'utf8'));
      const p = on.projects.find((x) => x.id === 'fx-a');
      return !!p && JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['createdAt', 'cwd', 'id', 'name']);
    })(),
    JSON.stringify(JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'projects.json'), 'utf8')).projects.filter((x) => x.id === 'fx-a')));
  check('空名字的工程落成「未命名项目」、缺 createdAt 的补上一个数字',
    (() => {
      const p = store.getProject('fx-b');
      return !!p && p.name === '未命名项目' && p.cwd === null && typeof p.createdAt === 'number' && p.createdAt > 0;
    })(), JSON.stringify(store.getProject('fx-b')));
  check('导入的工程可以从索引里查回来（列表里真有）',
    store.listProjects().some((p) => p.id === 'fx-a'));

  // 手写的裸数组索引也要能导进来（用户自己整理过的清单）
  const legacyFile = path.join(TMP, 'idx-legacy.json');
  fs.writeFileSync(legacyFile, JSON.stringify([{ id: 'legacy-1', name: '裸数组工程', cwd: null, createdAt: 1 }]), 'utf8');
  const im4 = store.importProjectIndex(legacyFile);
  check('裸数组形状也认（手写清单不至于导不进来）', im4.ok === true && im4.added === 1 && im4.legacy === true, JSON.stringify(im4));

  check('导入不存在的文件 → 明确报「读不到」',
    (() => { const r = store.importProjectIndex(path.join(TMP, 'idx-nope.json')); return r.ok === false && /读不到/.test(r.error); })(),
    JSON.stringify(store.importProjectIndex(path.join(TMP, 'idx-nope.json'))));
  fs.writeFileSync(path.join(TMP, 'idx-junk.json'), '这不是 json', 'utf8');
  check('导入垃圾文件 → 明确报「不是合法的 JSON」',
    (() => { const r = store.importProjectIndex(path.join(TMP, 'idx-junk.json')); return r.ok === false && /JSON/.test(r.error); })());
  fs.writeFileSync(path.join(TMP, 'idx-other.json'), JSON.stringify({ kind: 'other-app/data', projects: [] }), 'utf8');
  check('别的程序的 json → 报错并带上对方的 kind（不硬导）',
    (() => { const r = store.importProjectIndex(path.join(TMP, 'idx-other.json')); return r.ok === false && /other-app\/data/.test(r.error); })(),
    JSON.stringify(store.importProjectIndex(path.join(TMP, 'idx-other.json'))));
  fs.writeFileSync(path.join(TMP, 'idx-empty.json'), JSON.stringify({ hello: 1 }), 'utf8');
  check('没有 projects 列表的 json → 报错',
    store.importProjectIndex(path.join(TMP, 'idx-empty.json')).ok === false);
  // 反向对照：同一个入口对合法文件必须是 ok:true —— 否则上面那几条 "ok===false" 可能恒真
  check('对照：同一入口对合法文件是 ok:true（证明那几条报错断言有区分度）',
    store.importProjectIndex(legacyFile).ok === true);

  server.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
