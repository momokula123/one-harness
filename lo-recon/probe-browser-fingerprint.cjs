'use strict';
// 一次性探针：JS 重渲染后元素标记的"指纹找回"。
// 桩页 home 有 input#q + button#go。流程：
//   ① snapshot 拿编号 → ② 模拟 React 重渲染（整棵子树换新节点，属性全丢）→
//   ③ 用旧编号 browser_type/browser_click —— 应按指纹找回，编号不变，照常点中跳页。
//   ④ 再把元素真删掉 → 旧编号应报"已从页面上消失"。
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
      res.end('<html><head><title>BH-FP</title></head><body><h1>BH-FP</h1><input id="q" placeholder="search"/><button id="go" onclick="location.href=\'/page2\'">GO</button></body></html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const tools = require('../core/tools/index.js');
  const ctx = { workingDir: path.join(os.tmpdir(), 'bh-fp-' + Date.now()), settings: {} };
  fs.mkdirSync(ctx.workingDir, { recursive: true });
  const exec = (name, args) => tools.execute(name, JSON.stringify(args || {}), ctx);

  const out = [];
  const check = (name, ok, detail) => out.push(`${name}: ${ok ? 'PASS' : 'FAIL ' + String(detail).slice(0, 160)}`);
  try {
    await exec('browser_open', { url: `http://127.0.0.1:${port}/` });
    const snap = await exec('browser_snapshot', {});
    const refInput = Number((snap.text.match(/\[(\d+)\] <input/) || [])[1]);
    const refBtn = Number((snap.text.match(/\[(\d+)\] <button/) || [])[1]);
    check('refs', refInput > 0 && refBtn > 0, snap.text.slice(0, 200));

    // 标记可视化层：绿框数应等于编号数，且每个编号元素都打了属性
    const { BrowserWindow } = require('electron');
    const wc = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()).webContents;
    const layerInfo = await wc.executeJavaScript(`(() => ({
      layer: !!document.getElementById('bh-mark-layer'),
      boxes: document.querySelectorAll('#bh-mark-layer > div').length,
      marks: document.querySelectorAll('[data-bh-ref]').length,
    }))()`, true);
    check('overlay', layerInfo.layer && layerInfo.boxes === layerInfo.marks && layerInfo.boxes >= 2, JSON.stringify(layerInfo));

    // 模拟 React 重渲染：body 整个换成没有 data-bh-ref 的新节点（元素内容/位置不变）
    await wc.executeJavaScript(`(() => {
      const body = document.body;
      const fresh = body.cloneNode(true);            // 克隆会丢掉我们注入的属性？不会 —— clone 保留属性。
      fresh.querySelectorAll('[data-bh-ref]').forEach((el) => el.removeAttribute('data-bh-ref'));
      body.parentNode.replaceChild(fresh, body);     // 换新子树：框架重渲染的等价效果
      return true;
    })()`, true);
    const attrGone = await wc.executeJavaScript(`!document.querySelector('[data-bh-ref]')`, true);
    check('attr-wiped', attrGone === true, '属性应已被换掉');

    // 旧编号直接 type：应指纹找回（id + placeholder 命中）
    const r1 = await exec('browser_type', { ref: refInput, text: 'recovered' });
    check('type-recovered', /已输入|输入/.test(r1.text) && !/isError|找不到|消失/.test(r1.text), r1.text.slice(0, 160));

    // 旧编号直接 click：应找回 button#go，真跳 page2
    const r2 = await exec('browser_click', { ref: refBtn });
    check('click-recovered', /地址：.*\/page2/.test(r2.text) && /a#back/.test(r2.text), r2.text.slice(0, 160));

    // 负例：回 home，snapshot 后把 button 真删掉，旧编号应报"消失"
    await exec('browser_open', { url: `http://127.0.0.1:${port}/` });
    const snap2 = await exec('browser_snapshot', {});
    const refBtn2 = Number((snap2.text.match(/\[(\d+)\] <button/) || [])[1]);
    await wc.executeJavaScript(`(() => { const b = document.getElementById('go'); b && b.remove(); return true; })()`, true);
    const r3 = await exec('browser_click', { ref: refBtn2 });
    check('gone-detected', /消失/.test(r3.text), r3.text.slice(0, 160));

    await exec('browser_close', {});
  } catch (e) {
    out.push('CRASH ' + String(e && e.stack || e).slice(0, 400));
  }
  const result = { out, allPass: out.every((l) => /PASS|out,/.test(l)) && out.length >= 5 };
  try { fs.writeFileSync(process.env.HATCH_PROBE_OUT || 'bh-fp-out.json', JSON.stringify(result, null, 1)); } catch (_) {}
  app.exit(0);
}).catch((e) => { try { fs.writeFileSync(process.env.HATCH_PROBE_OUT || 'bh-fp-out.json', 'CRASH ' + String(e).slice(0, 400)); } catch (_) {} app.exit(1); });
