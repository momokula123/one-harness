'use strict';
// 探针：出厂那份模型（config/model.json）到底会不会**照着程序下发的工具表**发 tool_call？
// 用程序自己的工具注册表取 schema —— 不手写假 JSON。
const path = require('path');
const root = path.join(__dirname, '..');
const toolsIndex = require(path.join(root, 'core/tools/index.js'));
const cfg = require(path.join(root, 'config/model.json'));

const schemas = toolsIndex.schemasFor(['generate_image']);
console.log('[schema] 下发的工具：', schemas.map((s) => s.function.name).join(', '));

const body = {
  model: cfg.model,
  messages: [{ role: 'user', content: '画一只柯基坐在草地上，1K，1:1，存成 corgi' }],
  tools: schemas,
  stream: false,
};

(async () => {
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    console.log('[失败] 请求打不出去：', e.message);
    process.exit(1);
  }
  console.log('[http]', res.status, res.statusText, (Date.now() - t0) + 'ms');
  let json;
  try { json = JSON.parse(text); } catch (e) {
    console.log('[失败] 返回不是 JSON：', text.slice(0, 300));
    process.exit(1);
  }
  const msg = (json.choices && json.choices[0] && json.choices[0].message) || {};
  const calls = msg.tool_calls || [];
  console.log('[结论] tool_calls 数量 =', calls.length);
  if (calls.length) {
    for (const c of calls) console.log('  →', c.function && c.function.name, (c.function && c.function.arguments || '').slice(0, 300));
  } else {
    console.log('[说明] 模型直接答了话（没调工具）：', String(msg.content || '').slice(0, 200));
  }
})();
