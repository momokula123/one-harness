'use strict';
// browser_open 的端到端探针：真起一个 Electron 离屏窗口、真加载本机一个**只跑 http** 的服务。
//
// 为什么必须有它：test/browser-nav.js 只验协议候选这个纯函数，证明不了"真的能打开"。
// 用户报的 bug 就是端到端行为（模型调 browser_open 打不开 http 站点），所以这里跑真链路。
//
// 运行（Git Bash，注意宿主预设的 ELECTRON_RUN_AS_NODE 必须去掉，否则 Electron 退化成纯 node）：
//   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
//     node_modules/electron/dist/electron.exe test/browser-nav-e2e.js
//
// 不会弹窗打扰用户：探针把 showInactive 拦成空操作，窗口全程隐藏。
// 不联网：靶子是本进程自己起的 127.0.0.1 服务。

const http = require('http');
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const PORT = Number(process.env.PROBE_PORT || 8911);
// 临时 userData 落系统 temp，别往工程目录里长东西
app.setPath('userData', path.join(os.tmpdir(), 'oh-browser-nav-e2e'));
// 模型浏览时本来是"亮出来给用户围观"的，探针里不能真弹（用户可能在干别的）
BrowserWindow.prototype.showInactive = function () {};

const browser = require('../core/tools/browser');
const open = browser.tools.find((t) => t.alias === 'browser_open');
const close = browser.tools.find((t) => t.alias === 'browser_close');

let pass = 0;
const fails = [];
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fails.push(name); console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

const PAGE = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>HTTP 探针页</title></head>' +
  '<body><h1>只跑 http 的页面</h1><a href="/next">next</a></body></html>';

app.whenReady().then(async () => {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.method + ' ' + req.url);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  srv.on('clientError', (e, sock) => { hits.push('TLS-on-http(' + e.code + ')'); sock.destroy(); });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  const bare = '127.0.0.1:' + PORT + '/';

  try {
    console.log('— browser_open 打本机 http-only 服务 —');

    // ① 裸地址（模型最常给的形状）：旧代码补 https 必挂，现在应能打开
    let r = await open.run({ url: bare });
    check('① 裸地址 127.0.0.1:PORT → 打开成功（旧代码会补成 https 必失败）',
      !r.isError && /HTTP 探针页/.test(r.text || ''), { isError: r.isError, head: String(r.text || '').slice(0, 120) });
    check('①b 服务端确实收到的是明文 GET（没被升级成 https）',
      hits.some((h) => /^GET \//.test(h)), hits);

    // ② 带 http:// 显式给协议
    r = await open.run({ url: 'http://' + bare });
    check('② 显式 http:// → 打开成功', !r.isError && /HTTP 探针页/.test(r.text || ''), { isError: r.isError, head: String(r.text || '').slice(0, 80) });

    // ③ 反向对照：证明"这条链路本身不是万能的"、探针有区分度 ——
    //    旧代码正是走 https，所以这一步必须失败，否则第 ① 条全绿也可能是探针失灵。
    const w = BrowserWindow.getAllWindows()[0];
    let httpsErr = '';
    try { await w.webContents.loadURL('https://' + bare); } catch (e) { httpsErr = String((e && e.message) || e); }
    check('③ ★ 反向对照：同地址用 https 打 → 必须失败（旧代码走的就是这一步）',
      /ERR_/.test(httpsErr), httpsErr.slice(0, 120));

    // ④ 安全边界没被这次的改动放开
    r = await open.run({ url: 'file:///C:/Windows/win.ini' });
    check('④ file:// 仍被拒（只允许 http/https）', r.isError && /只支持 http\/https/.test(r.text || ''), r.text);

    // ⑤ 打不通的地址：报错里说清"http 与 https 都试过了"，别让模型以为只支持一种协议。
    //    用 65533（没人监听）而不是 1 —— 那是 Chromium 的"不安全端口"黑名单，报错会变成
    //    ERR_UNSAFE_PORT，验证不到"连接被拒后换协议"这件事本身。
    r = await open.run({ url: '127.0.0.1:65533/nothing' });
    check('⑤ 打不通 → 明确报错且说明两种协议都试过',
      r.isError && /都试过/.test(r.text || ''), String(r.text || '').slice(0, 140));
    check('⑤b 报错文案里不再出现"只接受 https"式的暗示（两个协议都写了）',
      /http 与 https/.test(r.text || ''), String(r.text || '').slice(0, 100));

    await close.run({});
  } catch (e) {
    fails.push('测试异常 ' + (e && e.message));
    console.log('测试异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e));
  }

  srv.close();
  console.log('\n通过 ' + pass + ' / 失败 ' + fails.length);
  if (fails.length) console.log('失败项：\n  ' + fails.join('\n  '));
  app.exit(fails.length ? 1 : 0);
}).catch((e) => {
  console.log('启动异常：' + (e && e.stack ? e.stack : e));
  app.exit(1);
});
