'use strict';
// 内置浏览器（离屏）：给模型一个**自己的** Chromium —— 主进程隐藏窗口，与用户右栏
// 那个 <webview> 完全隔离，谁也不抢谁的。交互走「文字快照 + 按序号点」：
//   snapshot 注入脚本把视口内可见的可交互元素编号（写 data-bh-ref 属性），
//   click/type 按编号找到元素、滚进视口、取中心坐标，发**真实鼠标事件**
//   （sendInputEvent，走 Chromium 命中测试 —— el.click() 那种假点击绕过命中测试，
//   被遮挡/隐藏的元素也能"点中"，那是假象；真人点不到的它也不许点得中）。
// 截图 capturePage 落盘工作目录，走 images 通道给用户看缩略图（模型侧仍是纯文本）。

const fs = require('fs');
const path = require('path');
const { uniquePath } = require('../store');
const images = require('../images');

let win = null; // 单例离屏窗口。同一时刻只有一个 agent 轮在驱动它，跨会话共用够用。
// 编号 → 元素指纹（快照时记下 tag/id/type/aria/name/placeholder/文字/中心坐标）。
// JS 框架重渲染会把 data-bh-ref 属性连节点一起换掉，属性锚点丢了就按指纹重扫找回，
// 编号保持稳定 —— 模型不用因为页面自己动了就重新 snapshot（Playwright MCP / browser-use 同思路）。
let refFps = new Map();

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  // 惰性 require：catalog() 会在纯 node 测试进程里被调用，那里 require('electron')
  // 拿到的是个路径字符串，只有主进程里才是真模块。
  const { BrowserWindow } = require('electron');
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1600,               // 拉高的视口：大多数页面一屏装下，少一步滚动
    paintWhenInitiallyHidden: true, // 隐藏窗口也要持续渲染，否则 capturePage 拿到空图
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 只放行 http/https。file:// 已定性为"经 shell 就能执行本地文件"的原语，这里同样不开。
  const schemeOk = (u) => /^https?:\/\//i.test(u);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (schemeOk(url)) win.webContents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!schemeOk(url)) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  return win;
}

function wc() {
  return ensureWindow().webContents;
}

// 把离屏窗口亮给用户看：模型浏览时用户能全程围观（点了哪、输了什么）。
// showInactive = 不抢焦点，用户手上的事不被打断。任何模式都不额外隐藏。
function showBrowser() {
  const { screen } = require('electron');
  const w = ensureWindow();
  // 建窗时按 1600 高给的视口，亮出来前按屏幕工作区收拢，别让下半截悬在屏外
  try {
    const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize;
    if (w.getBounds().height > ah || w.getBounds().width > aw) w.setBounds({ width: Math.min(1280, aw), height: ah });
    w.setPosition(Math.max(0, Math.round((aw - Math.min(1280, aw)) / 2)), 0);
  } catch (_) { /* screen 不可用就按原样亮 */ }
  if (w.isMinimized()) w.restore();
  w.showInactive();
  w.moveTop();
}

function toRel(workingDir, file) {
  return path.relative(workingDir, file).replace(/\\/g, '/');
}

// 页面加载等待：loadURL 的 promise 在 did-finish-load 落定；SPA 常见"load 完还在渲染"，
// 再给 600ms 安顿。did-fail-load（含 ERR_NAME_NOT_RESOLVED 这类）会把 loadURL reject 掉。
async function navigate(url) {
  const w = ensureWindow();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: `这不是合法地址：${url}` };
  }
  if (!/^https?:$/.test(u.protocol)) return { error: '只支持 http/https。' };
  try {
    await w.webContents.loadURL(url);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/ERR_ABORTED/.test(msg)) return { error: '加载被页面自己中断了，重试一次或换地址。' };
    return { error: `打不开 ${url}（${msg.slice(0, 160)}）` };
  }
  await new Promise((r) => setTimeout(r, 600));
  refFps = new Map(); // 换页了，旧编号/旧指纹全部作废
  return { ok: true };
}

// 快照注入脚本：跑在页面上下文。可见的可交互元素编号 + 文字 + 中心坐标。
const SNAPSHOT_JS = `(() => {
  const sel = 'a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [onclick]';
  const out = [];
  const fps = [];
  let n = 0;
  // 标记可视化层：绿框 + 编号角标画到页面上，用户围观模型干活时直接看得见它盯着哪个编号。
  // pointer-events:none 绝不挡真实鼠标点击；position:absolute 用文档坐标（滚页面跟着走）；
  // 每次快照先拆旧层重建。样式走 CSSOM（el.style.cssText），不吃页面 CSP 的 inline-style 限制。
  const oldLayer = document.getElementById('bh-mark-layer');
  if (oldLayer) oldLayer.remove();
  const layer = document.createElement('div');
  layer.id = 'bh-mark-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(layer);
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || (r.width < 2 && r.height < 2)) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const tag = el.tagName.toLowerCase();
    let txt = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    if (!txt && !['input', 'select', 'textarea'].includes(tag)) continue;
    n += 1;
    el.setAttribute('data-bh-ref', String(n));
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;pointer-events:none;border:2px solid #22c55e;border-radius:3px;background:rgba(34,197,94,0.08);';
    box.style.left = (r.x + scrollX) + 'px';
    box.style.top = (r.y + scrollY) + 'px';
    box.style.width = Math.max(r.width, 8) + 'px';
    box.style.height = Math.max(r.height, 8) + 'px';
    const chip = document.createElement('div');
    chip.textContent = String(n);
    chip.style.cssText = 'position:absolute;left:-1px;top:-15px;background:#22c55e;color:#fff;font:bold 11px/15px system-ui,sans-serif;padding:0 4px;border-radius:3px 3px 3px 0;white-space:nowrap;';
    box.appendChild(chip);
    layer.appendChild(box);
    const id = el.id ? '#' + el.id : '';
    const tp = el.getAttribute('type') ? '[' + el.getAttribute('type') + ']' : '';
    out.push('[' + n + '] <' + tag + id + tp + '> ' + txt + ' @ (' + Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2) + ')');
    fps.push({ tag: tag, id: el.id || '', type: el.getAttribute('type') || '', aria: el.getAttribute('aria-label') || '', name: el.getAttribute('name') || '', ph: el.getAttribute('placeholder') || '', txt: txt, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    if (n >= 150) break;
  }
  return { title: document.title, url: location.href, scrollY: Math.round(scrollY), scrollH: document.documentElement.scrollHeight, viewH: innerHeight, list: out.join('\\n'), fps: fps };
})()`;

async function snapshotText() {
  let r;
  try {
    r = await wc().executeJavaScript(SNAPSHOT_JS, true);
  } catch (e) {
    return `快照失败：${String((e && e.message) || e).slice(0, 160)}`;
  }
  const head = `页面：${r.title || '(无标题)'}\n地址：${r.url}`;
  refFps = new Map(); // 本次快照的编号→指纹，供属性锚点被重渲染冲掉后找回用
  (r.fps || []).forEach((f, i) => refFps.set(i + 1, f));
  const scroll = r.scrollH > r.viewH ? `\n滚动：已滚 ${r.scrollY}/${r.scrollH}（视口 ${r.viewH}，往下还有 ${Math.max(0, r.scrollH - r.scrollY - r.viewH)}px）` : '';
  const body = r.list || '（本视口没有可交互元素。整页可能是纯文本，用 browser_snapshot 看不到正文 —— 这是快照工具只列交互件的口径）';
  return `${head}${scroll}\n\n${body}\n\n操作：browser_click/browser_type 用上面的 [序号]；页面变了我重新 snapshot 就行。`;
}

// 按编号找元素，滚进视口，回传中心坐标（sendInputEvent 用页面坐标 = 视口坐标）。
// 属性锚点被 JS 重渲染冲掉时，按快照记下的指纹重扫页面找回同一个元素（编号不变）；
// 指纹也找不回 → { gone: true }，由调用方提示模型重新 snapshot。
const RECOVER_JS_HEAD = `(() => {
  const fp = __FP__;
  const sel = 'a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [onclick]';
  let best = null, bestScore = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || (r.width < 2 && r.height < 2)) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const tag = el.tagName.toLowerCase();
    let txt = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    let s = 0;
    if (fp.id && el.id === fp.id) s += 100;                       // id 精确命中，一锤定音
    if (tag === fp.tag) s += 12;
    if ((el.getAttribute('type') || '') && el.getAttribute('type') === fp.type) s += 15;
    if ((el.getAttribute('aria-label') || '') && el.getAttribute('aria-label') === fp.aria) s += 15;
    if ((el.getAttribute('name') || '') && el.getAttribute('name') === fp.name) s += 15;
    if ((el.getAttribute('placeholder') || '') && el.getAttribute('placeholder') === fp.ph) s += 15;
    if (fp.txt) {
      if (txt === fp.txt) s += 45;
      else if (txt && (txt.indexOf(fp.txt) !== -1 || fp.txt.indexOf(txt) !== -1)) s += 22;
    }
    if (fp.x != null) {                                           // 重渲染通常原地换节点：离旧位置越近越可信
      const d = Math.hypot((r.x + r.width / 2) - fp.x, (r.y + r.height / 2) - fp.y);
      if (d < 8) s += 10; else if (d < 40) s += 6; else if (d < 150) s += 2;
    }
    if (s > bestScore) { bestScore = s; best = el; }
  }
  if (!best || bestScore < 25) return null;                       // 阈值：防"碰巧同标签的别人"被误点
  best.setAttribute('data-bh-ref', __REF__);
  best.scrollIntoView({ block: 'center' });
  const r = best.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: best.tagName.toLowerCase(), recovered: true };
})()`;

async function locate(ref) {
  const n = Number(ref);
  const js = `(() => {
    const el = document.querySelector('[data-bh-ref="${n}"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName.toLowerCase() };
  })()`;
  const pos = await wc().executeJavaScript(js, true);
  if (pos) return pos;
  const fp = refFps.get(n);
  if (!fp) return { gone: true };
  const rec = await wc().executeJavaScript(
    RECOVER_JS_HEAD.replace('__FP__', JSON.stringify(fp)).replace('__REF__', JSON.stringify(String(n))),
    true
  );
  if (rec) {
    refFps.set(n, { ...fp, x: rec.x, y: rec.y }); // 找回后刷新旧位置，连环重渲染也能追
    return rec;
  }
  return { gone: true };
}

async function realClick(x, y) {
  const w = wc();
  const move = { type: 'mouseMove', x, y, button: 'left' };
  w.sendInputEvent({ ...move, type: 'mouseEnter' });
  w.sendInputEvent(move);
  w.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  w.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

const browserOpen = {
  alias: 'browser_open',
  module: 'browser',
  risk: 'low',
  writes: false,
  description: 'Open a URL in the built-in offscreen browser (not the user-visible panel) and return a snapshot of interactive elements with [ref] numbers.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
    required: ['url'],
  },
  async run(args) {
    const nav = await navigate(String(args.url || '').trim());
    if (nav.error) return { text: nav.error, isError: true };
    showBrowser();
    return { text: await snapshotText() };
  },
};

const browserSnapshot = {
  alias: 'browser_snapshot',
  module: 'browser',
  risk: 'low',
  writes: false,
  description: 'Snapshot the current page of the built-in browser: title, URL and the visible interactive elements with [ref] numbers and coordinates.',
  parameters: { type: 'object', properties: {}, required: [] },
  async run() {
    return { text: await snapshotText() };
  },
};

const browserClick = {
  alias: 'browser_click',
  module: 'browser',
  risk: 'medium',
  writes: false,
  description: 'Click the element with the given [ref] number from the latest browser_snapshot (real mouse events at its center).',
  parameters: {
    type: 'object',
    properties: { ref: { type: 'integer', description: 'Element number from the latest snapshot' } },
    required: ['ref'],
  },
  async run(args, ctx) {
    const pos = await locate(args.ref);
    if (pos && pos.gone) return { text: `序号 ${args.ref} 的元素已从页面上消失（重渲染后没找回）—— 重新 browser_snapshot 拿新编号。`, isError: true };
    if (!pos) return { text: `序号 ${args.ref} 找不到 —— 页面可能已经跳转，重新 browser_snapshot。`, isError: true };
    await realClick(pos.x, pos.y);
    await new Promise((r) => setTimeout(r, 900)); // 等点击引发的渲染/跳转安顿
    let title = '';
    try { title = (await wc().executeJavaScript('document.title', true)) || ''; } catch { /* 页面正在跳转时读标题可能抛，忽略 */ }
    return { text: `已点击 <${pos.tag}>。页面标题「${title}」\n\n${await snapshotText()}` };
  },
};

const browserType = {
  alias: 'browser_type',
  module: 'browser',
  risk: 'medium',
  writes: false,
  description: 'Type text into the input element with the given [ref] number (clicks it first, then inserts text like an IME).',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'integer', description: 'Element number from the latest snapshot' },
      text: { type: 'string', description: 'Text to type' },
      clear: { type: 'boolean', description: 'Clear existing content first (default true for text inputs)' },
    },
    required: ['ref', 'text'],
  },
  async run(args, ctx) {
    const pos = await locate(args.ref);
    if (pos && pos.gone) return { text: `序号 ${args.ref} 的元素已从页面上消失（重渲染后没找回）—— 重新 browser_snapshot 拿新编号。`, isError: true };
    if (!pos) return { text: `序号 ${args.ref} 找不到 —— 页面可能已经跳转，重新 browser_snapshot。`, isError: true };
    await realClick(pos.x, pos.y);
    await new Promise((r) => setTimeout(r, 200));
    const clear = args.clear !== false;
    if (clear) {
      await wc().executeJavaScript(`(() => {
        const el = document.querySelector('[data-bh-ref="${Number(args.ref)}"]');
        if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
        return true;
      })()`, true);
    }
    const ok = wc().insertText(String(args.text ?? ''));
    await new Promise((r) => setTimeout(r, 300));
    return { text: `${ok ? '已输入' : '输入可能没生效（该元素不接受文本插入，试试 browser_click 后确认焦点）'}：${String(args.text ?? '').slice(0, 80)}` };
  },
};

const browserScroll = {
  alias: 'browser_scroll',
  module: 'browser',
  risk: 'low',
  writes: false,
  description: 'Scroll the built-in browser page (pixels, positive = down / negative = up) and return a fresh snapshot.',
  parameters: {
    type: 'object',
    properties: { by: { type: 'integer', description: 'Pixels to scroll, positive down negative up. Default 1200.' } },
    required: [],
  },
  async run(args) {
    const by = Number.isFinite(args.by) ? Math.max(-8000, Math.min(8000, Math.floor(args.by))) : 1200;
    await wc().executeJavaScript(`window.scrollBy(0, ${by}); true`, true);
    await new Promise((r) => setTimeout(r, 400));
    return { text: await snapshotText() };
  },
};

const browserScreenshot = {
  alias: 'browser_screenshot',
  module: 'browser',
  risk: 'low',
  writes: true,
  description: 'Save a PNG screenshot of the built-in browser page into the working directory (the user can see it in the chat; you cannot).',
  parameters: {
    type: 'object',
    properties: { save_as: { type: 'string', description: 'File base name without extension' } },
    required: [],
  },
  async run(args, ctx) {
    const img = await wc().capturePage();
    const buf = img.toPNG();
    const base = String(args.save_as || '').trim().replace(/[\\/:*?"<>|]/g, '-') || 'browser-shot-' + Date.now();
    const file = uniquePath(ctx.workingDir, base, '.png');
    fs.writeFileSync(file, buf);
    const rel = toRel(ctx.workingDir, file);
    return {
      text: `截图已保存：${rel}（${img.getSize().width}×${img.getSize().height}，${(buf.length / 1024).toFixed(0)} KB）。\n**你（模型）看不到这张图**：工具结果只能是文本；图给用户看，别声称自己看过。`,
      isError: false,
      images: [{ rel, mime: images.mimeFor(rel) || null }],
    };
  },
};

const browserClose = {
  alias: 'browser_close',
  module: 'browser',
  risk: 'low',
  writes: false,
  description: 'Close the built-in offscreen browser and release it.',
  parameters: { type: 'object', properties: {}, required: [] },
  async run() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    refFps = new Map();
    return { text: '内置浏览器已关闭。' };
  },
};

// 回合结束时收窗（agent 经 tools/index.js onTurnEnd 调用）。只 hide 不 destroy：
// 窗口和页面状态留着，模型下回合接着用不用重建；browser_close / 退出时才真销毁。
function hideBrowser() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

module.exports = {
  tools: [browserOpen, browserSnapshot, browserClick, browserType, browserScroll, browserScreenshot, browserClose],
  hideBrowser,
};
