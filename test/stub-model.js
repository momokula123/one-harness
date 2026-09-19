'use strict';
// 测试用的本机假模型端点（stub）。
//
// 为什么要有它：巡检（features）的 D / F / F2 段要真的走一遍「模型 → 工具 → 再模型」的链路，
// 但**模型本身不是被测对象** —— 它是外部服务：公网往返一次几十秒、还花额度。
// 换成本机桩之后链路照跑，D 段从 100 秒降到 1~2 秒，结果也可重复。
// （features.js 头部那句「前置：本机模型端点在跑」就是这个意思。兜底端点接上公网以后，
//   测试数据目录没配端点就跟着走了公网 —— 整趟因此从 1 分钟变成 4 分钟。）
//
// 它同时要答两种请求：
//   1. 主对话（流式，可能要求调用工具）—— 按**本轮**已回灌的 tool 回执条数推进脚本。
//   2. 审批闸门的评审子会话（非流式，completeOnce）—— 回一个 <result> 三轴 JSON。
//
// 运行： node test/stub-model.js [port]      不传端口默认 18787；启动后打印 PORT=<n>

const http = require('http');

const MODELS = ['stub-model'];

// 每条请求故意慢一拍。桩在本机是 0 毫秒级，界面上的中间态（"运行时出现停止按钮"、
// 流式打字过程）根本来不及被看到 —— D1 那类断言会红。真模型一次往返几十秒，
// 桩给 500ms 谈不上失真，却能让"运行时"这个状态真的存在够久。
// 要跑得更快可以设 HATCH_STUB_DELAY=0（那时请把 D1 的等待同步改小）。
const DELAY_MS = () => Math.max(0, Number(process.env.HATCH_STUB_DELAY == null ? 500 : process.env.HATCH_STUB_DELAY));

// 评审裁决：写文件到项目内 = 可恢复的中风险改动。三轴都得给全，
// 否则 features 的 F8（「风险/授权/语法三轴齐全」）会红。
const REVIEW_REPLY =
  '<result>{"risk":"high","risk_reason":"会在项目内写文件，属于可恢复的中风险改动。","authorization":"explicitly_yes","correct":true}</result>';

/** 评审子会话：user 一定以「## Command under review」开头（见 core/approvals.js） */
function isReview(body) {
  return ((body && body.messages) || []).some(
    (m) => typeof m.content === 'string' && m.content.includes('## Command under review')
  );
}

function toolNames(body) {
  return ((body && body.tools) || []).map((t) => (t.function && t.function.name) || t.name || '');
}

/**
 * 主对话的下一步。只在用户**明确提到那个文件名/命令**时才动工具 ——
 * 否则别的段落随便发一句话，也会被塞一个 write_file 出去（在 always-ask 模式下还会弹出审批卡）。
 */
function nextStep(body) {
  const msgs = (body && body.messages) || [];
  const tools = toolNames(body);

  // ★ 工具回执只能按**本轮**数（最后一条 user 之后的那些），不能按整段历史数。
  // F 段是在 D 段那个会话里接着跑的，历史里已经躺着 2 条 tool 回执 ——
  // 按历史数就会以为"这个文件的工具都跑完了"，直接回文本，
  // 审批卡根本不弹，F1~F10 一起红（看着像审批坏了，其实是探针数错了数）。
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && typeof msgs[i].content === 'string') { lastUserIdx = i; break; }
  }
  const n = msgs.slice(lastUserIdx + 1).filter((m) => m.role === 'tool').length;
  const ask = String((msgs[lastUserIdx] && msgs[lastUserIdx].content) || '');

  // F 段：用 shell 跑一条命令 —— 必须真的申请 shell_command，审批卡才有东西可拦
  if (/HATCH_APPROVAL_TEST/.test(ask) && tools.includes('shell_command')) {
    if (n === 0) return { tool: { name: 'shell_command', args: { command: 'echo HATCH_APPROVAL_TEST' } } };
    return { text: '这条命令没有通过审批，我先停在这里。' };
  }

  // F2 段：写 notes/from-approval.md（用户会拒绝）
  if (/from-approval/.test(ask) && tools.includes('write_file')) {
    if (n === 0) {
      return { tool: { name: 'write_file', args: { relativePath: 'notes/from-approval.md', content: 'APPROVAL_OK' } } };
    }
    return { text: '写入没有成功，我先停下等你确认。' };
  }

  // D 段：写 notes/sweep.md，再读回来确认
  if (/sweep/.test(ask)) {
    if (n === 0 && tools.includes('write_file')) {
      return { tool: { name: 'write_file', args: { relativePath: 'notes/sweep.md', content: 'SWEEP_OK' } } };
    }
    if (n === 1 && tools.includes('read_file_lines')) {
      return { tool: { name: 'read_file_lines', args: { relativePath: 'notes/sweep.md' } } };
    }
    if (n >= 2) return { text: '已完成：notes/sweep.md 里写的是 SWEEP_OK，读回来的内容一致。' };
  }

  return { text: '好的，收到。' };
}

function chatResponse(model, step) {
  if (step.tool) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_' + Math.random().toString(36).slice(2, 10),
        type: 'function',
        function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) },
      }],
    };
  }
  return { role: 'assistant', content: step.text };
}

function usageOf(raw) {
  const promptTokens = Math.ceil(raw.length / 3.6);
  return { prompt_tokens: promptTokens, completion_tokens: 32, total_tokens: promptTokens + 32 };
}

/** 真正的应答。body 已经解析好、延迟也已经等过了。 */
function respond(body, raw, res) {
  const model = (body && body.model) || MODELS[0];
  const step = isReview(body) ? { text: REVIEW_REPLY } : nextStep(body);

  // 每条请求打一行：排查「测试为什么慢」时，一眼能看出桩收到了几次、每次给的是什么。
  // 挂了不响（比如客户端在等一个桩永远不会给的形状）当场就看得出来。
  const m0 = (body && body.messages) || [];
  const u0 = [...m0].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
  console.log('[stub] ' + (isReview(body) ? 'REVIEW' : 'chat') + (body && body.stream ? '/stream' : '/once')
    + ' 工具回执=' + m0.filter((m) => m.role === 'tool').length
    + ' 工具数=' + toolNames(body).length
    + ' 用户话=' + JSON.stringify(String((u0 && u0.content) || '').replace(/\s+/g, ' ').slice(0, 40))
    + ' → ' + (step.tool ? '调用 ' + step.tool.name : '文本'));

  if (body && body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta, finish) => {
      res.write('data: ' + JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', model,
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      }) + '\n\n');
    };
    send({ role: 'assistant' });
    if (step.tool) {
      send({
        tool_calls: [{
          index: 0,
          id: 'call_' + Math.random().toString(36).slice(2, 10),
          type: 'function',
          function: { name: step.tool.name, arguments: '' },
        }],
      });
      // 参数也分片吐，模拟真实模型的增量 JSON（渲染层/内核都按增量拼）
      for (const part of (JSON.stringify(step.tool.args).match(/.{1,18}/gs) || [])) {
        send({ tool_calls: [{ index: 0, function: { arguments: part } }] });
      }
      send({}, 'tool_calls');
    } else {
      for (const part of (String(step.text).match(/[\s\S]{1,20}/g) || [])) send({ content: part });
      send({}, 'stop');
    }
    // 真网关在流末尾会补一个 usage 块（choices 为空数组）—— 界面那一行用量明细就靠它。
    // 不补的话 D6 系列只会看到"模型未回传用量"，那是桩的缺口，不是产品的毛病。
    res.write('data: ' + JSON.stringify({
      id: 'chatcmpl-stub', object: 'chat.completion.chunk', model, choices: [], usage: usageOf(raw),
    }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-stub', object: 'chat.completion', model,
    choices: [{ index: 0, message: chatResponse(model, step), finish_reason: step.tool ? 'tool_calls' : 'stop' }],
    usage: usageOf(raw),
  }));
}

function handleChat(req, res) {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 坏请求也照答，别让测试卡在那儿等超时 */ }
    const ms = DELAY_MS();
    if (ms) setTimeout(() => respond(body, raw, res), ms);
    else respond(body, raw, res);
  });
}

/** 起桩。端口被占会打印警告（此时测试会回落成"走公网真模型"，慢但不会假绿）。 */
function start(port) {
  const p = Number(port || process.env.HATCH_STUB_PORT || 18787);
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.indexOf('/v1/models') === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    if (req.method === 'POST' && req.url.indexOf('/v1/chat/completions') === 0) return handleChat(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  server.on('error', (e) => console.log('[stub] 起不来（' + e.code + '）：' + e.message));
  server.listen(p, '127.0.0.1', () => console.log('[stub] 本机假模型端点就绪 http://127.0.0.1:' + p + '/v1'));
  return server;
}

if (require.main === module) {
  start(process.argv[2]);
  process.on('SIGINT', () => process.exit(0));
}

module.exports = { start, MODELS, REVIEW_REPLY, nextStep };
