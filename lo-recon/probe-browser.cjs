'use strict';
// 一次性探针：在 Electron 主进程里真跑内置浏览器工具链。
// 本地 http 桩两页：home（input + button）→ /page2（a 链接）。断言 open/type/click/screenshot/close。
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/page2') {
      res.end('<html><head><title>PAGE2</title></head><body><h1>PAGE2-OK</h1><a href="/" id="back">back home</a></body></html>');
    } else {
      res.end('<html><head><title>BH-PROBE</title></head><body><h1>BH-PROBE</h1><input id="q" placeholder="search"/><button id="go" onclick="location.href=\'/page2\'">GO</button></body></html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = require('../core/tools/browser.js');
  const tools = require('../core/tools/index.js');
  const ctx = { workingDir: path.join(os.tmpdir(), 'bh-probe-' + Date.now()), settings: {} };
  fs.mkdirSync(ctx.workingDir, { recursive: true });
  const exec = (name, args) => tools.execute(name, JSON.stringify(args || {}), ctx);

  const out = {};
  try {
    const r1 = await exec('browser_open', { url: `http://127.0.0.1:${port}/` });
    out.open = /页面：BH-PROBE/.test(r1.text) && /\[\d+\] <input/.test(r1.text) ? 'PASS' : 'FAIL:' + r1.text.slice(0, 200);
    const refInput = Number((r1.text.match(/\[(\d+)\] <input/) || [])[1]);
    const refBtn = Number((r1.text.match(/\[(\d+)\] <button/) || [])[1]);
    const r2 = await exec('browser_type', { ref: refInput, text: 'hello' });
    out.type = /已输入/.test(r2.text) ? 'PASS' : 'FAIL:' + r2.text.slice(0, 120);
    const typed = await tools.execute('browser_snapshot', '{}', ctx);
    out.typedVisible = /hello/.test(typed.text) ? 'PASS' : 'FAIL:' + typed.text.slice(0, 300);
    const r3 = await exec('browser_click', { ref: refBtn });
    out.click = /地址：.*\/page2/.test(r3.text) && /a#back/.test(r3.text) ? 'PASS' : 'FAIL:' + r3.text.slice(0, 200);
    const r4 = await exec('browser_screenshot', { save_as: 'probe-shot' });
    const rel = r4.images && r4.images[0] && r4.images[0].rel;
    out.shot = /截图已保存/.test(r4.text) && rel && fs.existsSync(path.join(ctx.workingDir, rel)) ? 'PASS' : 'FAIL:' + r4.text.slice(0, 160);
    await exec('browser_close', {});
    out.close = 'PASS';
  } catch (e) {
    out.crash = String((e && e.stack) || e).slice(0, 500);
  }
  server.close();
  // ★ app.exit 会吞 stdout（2026-09-20 实测），结果必须写文件回读
  try { fs.writeFileSync(process.env.HATCH_PROBE_OUT || 'bh-probe-out.json', JSON.stringify(out, null, 1)); } catch (_) {}
  console.log('[probe-browser] ' + JSON.stringify(out));
  app.exit(0);
});
