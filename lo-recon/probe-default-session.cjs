'use strict';
// 一次性探针：模拟"默认会话"真实一轮 —— default-llm 专用会话（不传 modules，走动态解析）
// + 真 agnes 模型 + 本地桩页。断言：模型能拿到 browser 工具、真的调用、回答含页面内容。
const { app } = require('electron');
const http = require('http');
const fs = require('fs');

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><head><title>模型榜</title></head><body><h1>OpenRuter 模型榜</h1><ul><li>GLM-5-Flash</li><li>DeepSeek-V5-Chat</li></ul><button>刷新榜单</button></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const store = require('../core/store.js');
  const sessionLib = require('../core/session.js');
  const prompts = require('../core/prompts.js');
  const { Agent } = require('../core/agent.js');

  store.saveSettings({ approval: { mode: 'auto' } }); // 免得评审子会话再烧一轮
  const proj = store.createProject('默认会话自测', null);
  const s = sessionLib.createSession({ projectId: proj.id, programId: 'default-llm', name: '默认会话自测' });
  s.instruction = prompts.PROMPTS[s.promptKey];
  store.saveSession(proj.id, s);

  const toolsSeen = [];
  const agent = new Agent({
    getSettings: () => store.getSettings(),
    emit: (ev) => { if (ev.type === 'tool:announce') toolsSeen.push(ev.name); },
    askUser: async () => ({}),
  });

  sessionLib.userMessage(s, `用内置浏览器打开 http://127.0.0.1:${port}/ ，然后告诉我页面上列了哪些模型。只看这一页，不要点别的东西。`, {});
  store.saveSession(proj.id, s);

  const r = await Promise.race([
    agent.runTurn(s),
    new Promise((_, rej) => setTimeout(() => rej(new Error('120s 超时')), 120000)),
  ]);
  const texts = s.entries.map((e) => String(e.text || '')).filter(Boolean);
  const last = texts[texts.length - 1] || '';
  const out = {
    ok: r.ok, steps: r.steps, toolsSeen,
    mentionedGlm: /GLM-5/i.test(last) || s.entries.some((e) => /GLM-5/i.test(String(e.text || ''))),
    tail: last.slice(-260),
  };
  server.close();
  fs.writeFileSync(process.env.HATCH_PROBE_OUT || 'defsession-out.json', JSON.stringify(out));
  console.log('[default-session-test] ' + JSON.stringify(out));
  app.exit(0);
}).catch((e) => {
  try { fs.writeFileSync(process.env.HATCH_PROBE_OUT || 'defsession-out.json', JSON.stringify({ crash: String(e && e.stack || e).slice(0, 500) })); } catch {}
  console.log('[default-session-test] CRASH ' + String(e && e.stack || e).slice(0, 400));
  app.exit(1);
});
