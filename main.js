'use strict';
// Electron 主进程：窗口、IPC、把 core 的能力暴露给渲染进程

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./core/store');
const sessionLib = require('./core/session');
const images = require('./core/images');
const openTarget = require('./core/open-target');
const projectIndex = require('./core/project-index');
const tools = require('./core/tools');
const checkpoints = require('./core/checkpoints');
const { Agent, sessionEvent, sessionMeta } = require('./core/agent');
const { listPrograms, MODULES, PROMPTS, getProgram } = require('./core/prompts');
const skillsMod = require('./core/tools/skills');
const model = require('./core/model');
const uistate = require('./core/uistate');
const runlog = require('./core/runlog');

store.init();

// 运行日志：把一轮对话里的模型请求 / 工具调用 / 中断 / 报错落到 logs/run-YYYY-MM-DD.log。
// 必须在 agent 建起来之前 init（agent 的事件处理里会写日志）。
runlog.init({ dataDir: store.DATA_DIR, packaged: app.isPackaged });

// 绿色版：把 Chromium 自己的 userData（缓存 / Local Storage / GPU 缓存等）也塞进程序文件夹，
// 否则它会写到 %APPDATA%/One Harness —— 那样"拷走文件夹"就不算真的自包含。
// 必须在 app ready 之前设置，且开发态不动（沿用原本的位置，不惊动已有环境）。
// 用户显式给了 HATCH_USER_DATA 时以用户为准（多实例并行测试也靠它隔离）。
if (app.isPackaged || process.env.HATCH_USER_DATA) {
  const ud = process.env.HATCH_USER_DATA
    ? path.resolve(process.env.HATCH_USER_DATA)
    : path.join(store.ROOT, 'userdata');
  try { fs.mkdirSync(ud, { recursive: true }); app.setPath('userData', ud); } catch (_) { /* 权限异常就不改，退回默认 */ }
}

const WINDOW_KEY = 'main';
// 布局文件里可能留着旧字段名（对齐 Bionic 时把 rightPanelView 改成了 devRightPanelView、
// 把 workspace.activeProjectId 搬到了顶层 windowContext）。空 patch 走一遍
// 读→归一化→写盘，把用户已有的布局就地升级，不至于因为改名白丢。
uistate.patchWindow(WINDOW_KEY, {});
// 同理把 global 也回写一遍：readGlobal 现在只认白名单，这一写顺手清掉废弃字段。
uistate.patchGlobal({});
// 自动测试/截图跑：窗口不显示、不抢焦点、有副屏就扔副屏（见 createWindow 的 ready-to-show）
const BACKGROUND = !!process.env.HATCH_BACKGROUND;
// 只判定"这条东西该交给谁打开"，不真打开（自动化测试用：测试不能把浏览器/资源管理器
// 糊到用户屏幕上）。见 shell:openExternal 处理器。
const OPEN_DRYRUN = !!process.env.HATCH_OPEN_DRYRUN;
// 例外：确实需要真截图的场合（生成文档图、自检窗口可见性）才允许把窗口画出来
const SHOT_VISIBLE = !!process.env.HATCH_SHOT_VISIBLE;
// 需要真实指针输入（mouseMove / mouseWheel）时用：Chromium 只在窗口"可见"时才处理
// 非按键的指针事件 —— 实测隐藏窗口下连 document 级的 mousemove 都收不到一条，
// 而自动化又不能让窗口出现在用户眼前（用户可能正在全屏游戏里）——
// 于是显示它，然后整个挪到所有屏幕之外。
const OFFSCREEN = !!process.env.HATCH_OFFSCREEN;
// 真实鼠标/键盘/滚轮巡检（HATCH_MOUSE_FILE）：这些输入要靠"窗口真的拿到系统焦点"才可靠 ——
// 实测 focusable:false 时滚轮完全合成不出来（wheelSeen 0）、mouseMoved 被攒着不派发
// （hoverSeen 0）、连打字都只落一半（REAL_TYPED → REAL_TY）。而 BACKGROUND 的默认正是
// focusable:false，所以巡检必须显式把这个开关打开。（仅此场景；截图跑不需要焦点。）
const NEEDS_FOCUS = !!process.env.HATCH_MOUSE_FILE && !!process.env.HATCH_FOCUSABLE;
// 后台/自动化模式的统一守卫：原生窗口（系统对话框、资源管理器）**不受** -webkit-app-region
// 约束，也不吃 show:false / skipTaskbar，藏不到副屏去 —— 只要调了就糊到用户屏幕上
// （用户可能正在打游戏）。所以后台模式一律不弹，调用方看到的是"什么都没做"。
function bgBlocked(what) {
  if (!BACKGROUND) return false;
  console.log('[guard] 后台模式不弹原生窗口：' + what);
  return true;
}
let win = null;
const pendingApprovals = new Map();

const agent = new Agent({
  getSettings: () => store.getSettings(),
  // 这里只管把事件送到界面。运行日志由内核自己记（core/agent.js 的 logCoreEvent +
  // 模型/工具执行点），不再由宿主转发 —— 日志是出事后的唯一依据，不该依赖宿主。
  emit: (ev) => {
    if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
  },
  askUser: (req) =>
    new Promise((resolve) => {
      const requestId = store.newId();
      pendingApprovals.set(requestId, resolve);
      if (win && !win.isDestroyed()) win.webContents.send('approval:request', { ...req, requestId });
    }),
});

function createWindow() {
  // 布局完全由 ui-state/*.json 决定：窗口几何取自 global.json 的 lastActiveWindowBounds
  uistate.registerWindow(WINDOW_KEY);
  const saved = uistate.readGlobal().lastActiveWindowBounds || {};
  const opts = {
    width: Number(saved.width) || 1360,
    height: Number(saved.height) || 880,
    minWidth: 980,
    minHeight: 620,
    // 无边框 + 自绘顶栏：标题栏、窗口按钮都由渲染层画（对照参考图），
    // 拖拽区靠 CSS 的 -webkit-app-region 划出来。
    frame: false,
    backgroundColor: '#ffffff',
    show: false,
    title: 'One Harness',
    // 任务栏/窗口图标。Windows 认 .ico（多尺寸，任务栏那几档才清晰）；
    // 非 Windows 退回 256 的 PNG。生成脚本：tools/make-icon.js
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    // 自动测试/后台跑（HATCH_BACKGROUND=1）：不可获得焦点、不进任务栏，
    // 并且几何不落盘（别把测试窗口的位置覆盖掉用户自己的窗口记忆）。
    // 例外见 NEEDS_FOCUS：真实输入巡检必须能拿到焦点，否则滚轮/悬停/键盘全是假数据。
    focusable: !BACKGROUND || NEEDS_FOCUS,
    skipTaskbar: BACKGROUND,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 右栏内置浏览器用 <webview>。它默认是关的，必须显式打开；
      // webview 有自己的进程与 webPreferences，**不受这里影响**（下面 will-attach-webview 里再收紧）。
      webviewTag: true,
    },
  };
  // x/y 为 null 时不传，交给系统决定位置；否则严格按上次的坐标还原
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    opts.x = saved.x;
    opts.y = saved.y;
  }
  win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 无边框窗口用 show:false 建，等首帧渲染好再显示，避免白屏闪一下。
  // 上次关窗时是最大化的就还原成最大化（几何仍按 getNormalBounds 记，别把最大化尺寸存成"常规尺寸"）。
  const rememberedMax = !!uistate.readWindow(WINDOW_KEY).windowMaximized;
  win.once('ready-to-show', () => {
    if (BACKGROUND && !SHOT_VISIBLE && !OFFSCREEN) {
      // 自动测试：**一个像素都不要画到用户屏幕上**。
      // showInactive() 只是不抢焦点，窗口还是实打实画出来了 —— 用户在全屏游戏里照样被打断。
      // 测试断言全走 executeJavaScript 读 DOM，本来就不需要窗口真的可见。
    } else if (OFFSCREEN) {
      // 先挪到屏幕外再显示：这样既满足"Chromium 认为窗口可见"（指针事件才会派发），
      // 又不会在用户眼前闪一下。
      const b = win.getBounds();
      const primary = screen.getPrimaryDisplay();
      win.setBounds({ x: primary.bounds.x - b.width - 120, y: primary.bounds.y, width: b.width, height: b.height });
      win.showInactive();
    } else if (BACKGROUND) {
      // 需要真截图时才显示，而且有副屏就扔副屏去
      const primary = screen.getPrimaryDisplay();
      const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
      if (other) win.setPosition(other.bounds.x + 60, other.bounds.y + 60);
      // 真实输入巡检：必须**真的激活**（showInactive 只是画出来，拿不到系统焦点，
      // 于是滚轮合成不出来、mouseMoved 被攒着、打字掉字符）。其余场合一律不动焦点。
      // 还要置顶：被别的窗口盖住时 Chromium 会判定"遮挡"并暂停合成，鼠标移动/滚轮
      // 这类走合成器队列的事件就一条都派发不出来（按键不走队列，所以照样能收到）。
      if (NEEDS_FOCUS) { win.show(); win.focus(); win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); }
      else win.showInactive();
    } else {
      if (rememberedMax) win.maximize();
      win.show();
    }
    // 无边框 + show:false 的组合下，漏了这次 show() 就是"程序起来了但看不见窗口"，
    // 所以把可见性打进日志，启动自检会断言这一行。
    // （show() 之后 OS 侧要一拍才把 isVisible() 刷成 true，所以延后一点再读。）
    if (process.env.HATCH_DEBUG) {
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        const tag = OFFSCREEN ? 'offscreen-shown' : (BACKGROUND && !SHOT_VISIBLE ? 'background-hidden' : 'shown');
        const d = screen.getDisplayNearestPoint(win.getBounds());
        const which = OFFSCREEN ? '屏幕外' : (d.id === screen.getPrimaryDisplay().id ? '主屏' : '副屏');
        console.log(`[win] ${tag} visible=${win.isVisible()} focused=${win.isFocused()} display=${which}`);
      }, 400);
    }
  });

  const pushMaxState = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:state', { maximized: win.isMaximized() });
  };
  win.on('maximize', () => {
    uistate.patchWindow(WINDOW_KEY, { windowMaximized: true });
    pushMaxState();
  });
  win.on('unmaximize', () => {
    uistate.patchWindow(WINDOW_KEY, { windowMaximized: false });
    pushMaxState();
  });
  win.webContents.on('did-finish-load', pushMaxState);

  // 窗口几何回写。拖动/缩放过程中节流，窗口关闭前强制落一次。
  let boundsTimer = null;
  let lastBounds = null;
  const flushBounds = () => {
    if (BACKGROUND) return; // 测试窗口别把用户自己的窗口位置记忆覆盖掉
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized() || win.isFullScreen()) return;
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    lastBounds = uistate.saveWindowBounds(b);
    uistate.patchWindow(WINDOW_KEY, { windowBounds: b });
  };
  const queueBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      flushBounds();
    }, 400);
  };
  win.on('resize', queueBounds);
  win.on('move', queueBounds);
  win.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    flushBounds();
  });

  if (process.env.HATCH_DEBUG) {
    win.webContents.on('console-message', (...args) => {
      const e = args[0];
      if (e && typeof e === 'object' && 'message' in e) console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId || ''}:${e.lineNumber || ''})`);
      else console.log('[renderer]', args[2]);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[renderer] did-fail-load', code, desc));
    win.webContents.on('render-process-gone', (_e, details) => console.log('[renderer] gone', JSON.stringify(details)));
  }
  win.on('closed', () => { win = null; });

  // 右栏内置浏览器的 guest 守卫。
  // <webview> 的 webPreferences **不受**主窗口那份影响（它是独立进程），所以必须单独收紧：
  //   · 不给 preload、关掉 node 集成 —— 网页拿不到本应用的任何能力（这是安全底线）；
  //   · 只允许 http / https / file —— 挡掉 about:blank 之外的奇怪协议与自定义 scheme。
  // 注意别把 file: 也拦掉：预览 agent 生成的本地 HTML 正是这个面板的主要用途。
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    const src = String(params && params.src ? params.src : '');
    if (src && !/^(https?|file):/i.test(src)) {
      console.log('[browser] 拦下不允许的协议：' + src);
      e.preventDefault();
    }
  });
  // guest 里点开新窗口（target=_blank）时，别另开原生窗口——直接把当前 view 导航过去。
  // 应用没开原生窗口管理，真弹出来就是个管不住的白框。
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^(https?|file):/i.test(url) && win && !win.isDestroyed()) {
        win.webContents.send('browser:navigate', url);
      }
      return { action: 'deny' };
    });
  });

  // 截图钩子：HATCH_SHOOT=<png 路径> 时在窗口出现后抓一张图。
  // 默认抓完退出；HATCH_KEEP_OPEN=1 则保留窗口（方便人手看/手动试）。
  // HATCH_EVAL=<js> 可在抓图前先在页面里跑一段脚本（用来验证交互与落盘）。
  if (process.env.HATCH_SHOOT) {
    const delay = Number(process.env.HATCH_SHOOT_DELAY || 4500);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // HATCH_EVAL_FILE 优先（脚本里有引号/反引号时命令行不好转义）
        let evalSrc = process.env.HATCH_EVAL;
        if (process.env.HATCH_EVAL_FILE) {
          try {
            evalSrc = fs.readFileSync(process.env.HATCH_EVAL_FILE, 'utf8');
          } catch (e) {
            console.log('[eval] 读脚本失败 ' + e.message);
          }
        }
        if (evalSrc) {
          // HATCH_UI_STATE 让同一个截图脚本能切状态（test/ui-shot.js 用）
          if (process.env.HATCH_UI_STATE) {
            evalSrc = `var HATCH_UI_STATE = ${JSON.stringify(process.env.HATCH_UI_STATE)};\n${evalSrc}`;
          }
          try {
            const r = await win.webContents.executeJavaScript(evalSrc, true);
            console.log('[eval] ' + JSON.stringify(r));
          } catch (e) {
            console.log('[eval] failed ' + e.message);
          }
          await new Promise((r) => setTimeout(r, 900));
        }
        try {
          if (BACKGROUND && !SHOT_VISIBLE) {
            // 隐藏窗口在 Windows 上 capturePage 只能抓到空白，干脆别写假图骗自己
            console.log('[shoot] skipped 自动化模式不显示窗口，跳过截图（要图请设 HATCH_SHOT_VISIBLE=1）');
          } else {
            // 窗口是 show:false 建的，抓图前必须先显示，否则 Windows 上抓到的是空白
            if (!win.isVisible()) win.show();
            await new Promise((r) => setTimeout(r, 350));
            const img = await win.webContents.capturePage();
            fs.writeFileSync(process.env.HATCH_SHOOT, img.toPNG());
            console.log('[shoot] saved ' + process.env.HATCH_SHOOT);
          }
        } catch (e) {
          console.log('[shoot] failed ' + e.message);
        }
        if (!process.env.HATCH_KEEP_OPEN) app.quit();
      }, delay);
    });
  }

  // ---- 真实鼠标钩子 ----
  // HATCH_MOUSE_FILE=<模块路径>：页面就绪后由主进程用 webContents.sendInputEvent 发
  // **真的鼠标按下/抬起**。它会走 Chromium 的命中测试，因此能被 -webkit-app-region
  // 拖拽区吃掉、也点不到 visibility:hidden / 零宽 / 被遮挡的元素 —— 这正是
  // el.click() 测不出来的那一类问题（"侧栏收起后按钮点不回来"就是这么漏掉的）。
  // 模块签名：module.exports = async (api) => summary，api 见下。
  if (process.env.HATCH_MOUSE_FILE) {
    const delay = Number(process.env.HATCH_MOUSE_DELAY || 3000);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const result = { clickTargets: [], summary: null, error: null, unhandled: [] };
        const js = (expr) => win.webContents.executeJavaScript(expr, true);
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        try {
          await js(`window.__mouseRejections = [];
            if (!window.__mouseRejHooked) { window.__mouseRejHooked = 1;
              window.addEventListener('unhandledrejection', (e) => window.__mouseRejections.push(String((e.reason && (e.reason.message || e.reason)) || e.reason)));
            }`);
        } catch (e) { result.error = '注入异常收集器失败：' + e.message; }
        // 取元素中心点，并顺带把"这个点最顶层是谁"一起带回来（命中测试）
        const probe = (sel) => js(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return { found: false };
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const x = Math.round(r.left + r.width / 2);
          const y = Math.round(r.top + r.height / 2);
          const top = (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) ? document.elementFromPoint(x, y) : null;
          const name = (n) => n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
            (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).join('.') : '') : null;
          return {
            found: true, x, y, w: Math.round(r.width), h: Math.round(r.height),
            visible: cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0 && r.height > 0,
            pointerEvents: cs.pointerEvents,
            appRegion: cs.webkitAppRegion || cs['-webkit-app-region'] || 'none',
            topmost: name(top),
            reachable: !!(top && (top === el || el.contains(top) || top.contains(el))),
          };
        })()`);
        // 输入一律走 CDP 的 Input.*：实测 webContents.sendInputEvent **不派发**
        // mouseMove / mouseWheel（去掉 button 也一样，连 document 级的 mousemove 都是 0 条），
        // 而 CDP 走的是标准输入管线 —— 命中测试、-webkit-app-region 拖拽区、DOM 事件全都齐，
        // 和真人操作同一套路径。
        let cdpOn = false;
        try { win.webContents.debugger.attach('1.3'); cdpOn = true; } catch (e) { result.cdpError = e.message; }
        // 每条 CDP 命令都套一层超时：实测某些命令会一直不返回，
        // 没有这道保险整场测试会静默挂死到跑分器超时，什么信息都留不下。
        const cdp = (method, params) => {
          if (!cdpOn) return Promise.resolve(null);
          return Promise.race([
            win.webContents.debugger.sendCommand(method, params).catch((e) => '__err:' + e.message),
            wait(4000).then(() => '__timeout'),
          ]);
        };
        async function send(type, x, y, clickCount) {
          const n = clickCount || 1;
          if (type === 'mouseMove') await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
          else if (type === 'mouseDown') await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n });
          else if (type === 'mouseUp') await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n });
        }
        // 先把指针挪到"别处"、再挪到目标：Chromium 只在位置**真的变化**时才派发 mousemove，
        // 而第一次移动往往只被用来建立基准位置 —— 实测原地单点移动时 DOM 一条 mousemove 都收不到。
        async function moveTo(x, y) {
          await send('mouseMove', 3, 3);
          await wait(130);
          await send('mouseMove', x, y);
          // 屏幕外的窗口合成帧率极低，mouseMoved 会被 MouseEventQueue 攒着，
          // 等到下一个合成时机才一次派发 —— 等太短会读到 0（实测过）。
          await wait(260);
        }
        // 双击：clickCount 要真的走到 2，很多实现（含本项目的分隔条折叠）认的是 dblclick 事件
        async function dblclick(sel, label) {
          const c = await probe(sel);
          const rec = Object.assign({ target: 'dblclick:' + (label || sel), sel, action: 'dblclick' }, c);
          result.clickTargets.push(rec);
          if (!c.found) { rec.note = '元素不存在'; return rec; }
          await moveTo(c.x, c.y);
          await send('mouseDown', c.x, c.y, 1);
          await send('mouseUp', c.x, c.y, 1);
          await wait(60);
          await send('mouseDown', c.x, c.y, 2);
          await send('mouseUp', c.x, c.y, 2);
          await wait(340);
          rec.clicked = true;
          return rec;
        }
        // 键盘：CDP 的 dispatchKeyEvent，keyDown 带 text 即插入字符
        const VK = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
        const keyDown = (k) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, text: k.length === 1 ? k : undefined, unmodifiedText: k.length === 1 ? k : undefined, windowsVirtualKeyCode: VK[k] || 0 });
        const keyUp = (k) => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: VK[k] || 0 });
        const input = (e) => {
          if (e.type === 'mouseWheel') return cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: e.x, y: e.y, deltaX: e.deltaX || 0, deltaY: e.deltaY || 0 });
          if (e.type === 'mouseMove') return send('mouseMove', e.x, e.y);
          if (e.type === 'mouseDown') return send('mouseDown', e.x, e.y, e.clickCount);
          if (e.type === 'mouseUp') return send('mouseUp', e.x, e.y, e.clickCount);
          if (e.type === 'keyDown' || e.type === 'char') return keyDown(e.keyCode);
          if (e.type === 'keyUp') return keyUp(e.keyCode);
          return null;
        };
        // 悬停：只移动指针、不按键（验 :hover 类效果）
        async function hover(sel, label) {
          const c = await probe(sel);
          const rec = Object.assign({ target: 'hover:' + (label || sel), sel, action: 'hover' }, c);
          result.clickTargets.push(rec);
          if (c.found) { await send('mouseMove', c.x, c.y); rec.clicked = true; }
          // mouseMoved 会被 MouseEventQueue 攒到下一个合成时机才派发，等太短读到的就是 0
          // （调用的断言还要再轮询一次，见 mouse-steps.js）。这里给足一次合成的余量。
          await wait(320);
          return rec;
        }
        // 拖拽：按下 → **分步**移动 → 抬起。必须分步，一步到位很多拖拽实现收不到中间态。
        async function drag(sel, dx, dy, label) {
          const c = await probe(sel);
          const rec = Object.assign({ target: 'drag:' + (label || sel), sel, action: 'drag', dx, dy }, c);
          result.clickTargets.push(rec);
          if (!c.found) { rec.note = '元素不存在'; return rec; }
          const parts = 8;
          await moveTo(c.x, c.y);
          await send('mouseDown', c.x, c.y);
          for (let i = 1; i <= parts; i += 1) {
            await send('mouseMove', Math.round(c.x + (dx * i) / parts), Math.round(c.y + (dy * i) / parts));
            await wait(24);
          }
          await wait(40);
          await send('mouseUp', Math.round(c.x + dx), Math.round(c.y + dy));
          await wait(340);
          rec.clicked = true;
          return rec;
        }
        // 滚轮：deltaY 正数向下滚
        async function wheel(sel, deltaX, deltaY, label) {
          const c = await probe(sel);
          const rec = Object.assign({ target: 'wheel:' + (label || sel), sel, action: 'wheel', deltaX, deltaY }, c);
          result.clickTargets.push(rec);
          if (!c.found) { rec.note = '元素不存在'; return rec; }
          await moveTo(c.x, c.y); // 先把指针挪到目标上，滚轮事件才有落点
          const parts = 6;
          for (let i = 0; i < parts; i += 1) {
            await input({ type: 'mouseWheel', x: c.x, y: c.y, deltaX: Math.round(deltaX / parts), deltaY: Math.round(deltaY / parts) });
            await wait(40);
          }
          await wait(220);
          rec.clicked = true;
          return rec;
        }
        // 键盘输入：先真实点击聚焦，再逐字符发 keyDown/keyUp（keyDown 带 text 即插入字符）。
        // 中文没法这么发（CDP 的 text 要能落到键盘布局上），所以用 ASCII 测。
        async function type(sel, text, label) {
          const c = await probe(sel);
          const rec = Object.assign({ target: 'type:' + (label || sel), sel, action: 'type', text }, c);
          result.clickTargets.push(rec);
          if (!c.found) { rec.note = '元素不存在'; return rec; }
          await moveTo(c.x, c.y);
          await send('mouseDown', c.x, c.y);
          await wait(40);
          await send('mouseUp', c.x, c.y);
          await wait(170);
          for (const ch of text) {
            await keyDown(ch);
            await keyUp(ch);
            await wait(30);
          }
          await wait(220);
          rec.clicked = true;
          return rec;
        }
        // 特殊键：Enter / Escape / Tab / Backspace / Delete / ArrowDown ...
        async function key(k, label) {
          await keyDown(k);
          await keyUp(k);
          await wait(220);
          const rec = { target: 'key:' + (label || k), action: 'key', keyCode: k };
          result.clickTargets.push(rec);
          return rec;
        }
        async function click(sel, label) {
          const c = await probe(sel);
          const rec = Object.assign({ target: label || sel, sel }, c);
          result.clickTargets.push(rec);
          if (!c.found) { rec.clicked = false; rec.note = '元素不存在'; return rec; }
          await moveTo(c.x, c.y);
          await send('mouseDown', c.x, c.y);
          await wait(50);
          await send('mouseUp', c.x, c.y);
          await wait(300);
          rec.clicked = true;
          if (!c.reachable) rec.note = '真实鼠标点不到（命中测试落在 ' + c.topmost + '）';
          return rec;
        }
        // 原始指针移动 / 指定坐标点击。
        // 为什么需要它们：`click(sel)` 内部固定走 moveTo（先到 (3,3) 再到目标），也就是
        // **只能从左上方向接近目标**。用户报过一个"从右上方移进去点不动、从左下方移进去就好"
        // 的 bug —— 那种问题只有在能自己控制接近路径时才能复现和验证。
        async function move(x, y) {
          await send('mouseMove', x, y);
          await wait(260);
          return { x, y };
        }
        async function clickAt(x, y, label) {
          const top = await js(`(() => {
            const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
            if (!el) return null;
            return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
              (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
          })()`);
          const rec = { target: 'clickAt:' + (label || x + ',' + y), action: 'clickAt', x, y, topmost: top };
          await send('mouseDown', x, y);
          await wait(50);
          await send('mouseUp', x, y);
          await wait(300);
          result.clickTargets.push(rec);
          rec.clicked = true;
          return rec;
        }
        // 预热：Chromium 要先有一次移动来建立基准位置（那一次不派发任何 DOM 事件），
        // 不预热的话测试里的第一次 hover 什么都读不到。顺手把 webContents 聚焦 ——
        // 滚轮事件需要 renderer 处于聚焦态才会被合成出来。
        try { win.webContents.focus(); } catch (e) { /* 屏幕外的窗口可能拒绝聚焦，不影响点击/键盘 */ }
        await send('mouseMove', 3, 3);
        await wait(80);
        await send('mouseMove', 40, 40);
        await wait(80);

        const api = {
          click, dblclick, probe, js, wait, out: result, input,
          hover, drag, wheel, type, key, move, clickAt,
          // 屏幕外模式：非按键指针事件（mouseMoved/wheel）在这里根本合成不出来，
          // 步骤脚本据此**主动跳过**那两条断言，而不是干等到整场超时（实测踩过）。
          offscreen: OFFSCREEN,
          log: (...a) => console.log('[mouse]', ...a),
          shot: async (p) => {
            if (BACKGROUND && !SHOT_VISIBLE) return null;
            if (!win.isVisible()) win.show();
            await wait(320);
            fs.writeFileSync(p, (await win.webContents.capturePage()).toPNG());
            return p;
          },
        };
        try {
          result.summary = await require(path.resolve(process.env.HATCH_MOUSE_FILE))(api);
        } catch (e) {
          result.error = e.message + '\n' + (e.stack || '');
        }
        try { result.unhandled = await js('window.__mouseRejections'); } catch {}
        if (process.env.HATCH_MOUSE_OUT) {
          try { fs.writeFileSync(process.env.HATCH_MOUSE_OUT, JSON.stringify(result, null, 2)); }
          catch (e) { console.log('[mouse] 写结果失败 ' + e.message); }
        }
        console.log('[mouse] ' + JSON.stringify({ error: result.error, summary: result.summary }));
        if (!process.env.HATCH_KEEP_OPEN) app.quit();
      }, delay);
    });
  }
}

function ensureDefaultProject() {
  const projects = store.listProjects();
  if (projects.length) return projects[0];
  return store.createProject('默认项目', null);
}

function loadSession(projectId, sessionId) {
  const s = store.loadSession(projectId, sessionId);
  if (!s) throw new Error('会话不存在：' + sessionId);
  if (!s.instruction) s.instruction = PROMPTS[s.promptKey || getProgram(s.programId).prompt];
  return s;
}

// 正在跑的那一轮持有的是**内存里的 session 对象**（chat:send 里 loadSession() 出来的），
// 而 sessions:update 会再从磁盘 load 一份**新对象**去改、去存盘 —— 跑着的那一轮读的还是老对象。
// 表现就是用户报的「审批模式不能真正切换」：点了、图标换了、提示也弹了，
// 可下一个工具调用仍然按老模式走（gate() 每次现读 session.approvalMode，读的是老对象）。
// 所以本轮运行期间把这份对象登记下来，更新时就地改同一份。
const liveSessions = new Map();  // 'projectId:sessionId' -> session（只在本轮运行期间存在）
const liveKey = (projectId, sessionId) => projectId + ':' + sessionId;
// 会话上可被会话级 patch 改动的字段（与 sessions:update 的白名单保持一致）
const SESSION_PATCH_KEYS = ['modules', 'model', 'approvalMode', 'readOnly', 'workingDir',
  'instruction', 'programId', 'promptKey'];

/** 把 undici 藏在 e.cause 里的真实原因挖出来（否则只会看到没用的 "fetch failed"） */
function reasonOf(e) {
  const c = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : '';
  return `${(e && e.message) || e}${c ? ' [' + c + ']' : ''}`;
}

/**
 * 决定"用哪个模型"：设置里填了且端点确实有，就照用；
 * 没填、或填的模型在这个端点上不存在，就用端点 /v1/models 推荐的第一个并落盘。
 * 这样换了端点不用先去设置里手填模型名，界面上的模型 chip 也会立刻显示实际在用的那个。
 *
 * **写回哪一侧**：正在用的是用户自己那组就写 model，正在用的是兜底就写兜底 ——
 * 绝不能一律写进 model：那等于把兜底那套的模型名"钉"成用户自己填的，
 * 之后用户改兜底卡片就再也不生效了（而他还以为自己在用兜底）。
 */
async function resolveModel() {
  const s = store.getSettings();
  const cfg = { ...s.model };
  const ownInUse = store.hasOwnEndpoint(s.modelOwn);
  let models = [];
  try {
    models = await model.listModels(cfg);
  } catch (e) {
    return { ok: false, error: reasonOf(e) + ' @ ' + (cfg.baseUrl || '') + '/models', models: [], model: cfg.model || '' };
  }
  if (!models.length) return { ok: true, models: [], model: cfg.model || '' };
  if (cfg.model && models.includes(cfg.model)) return { ok: true, models, model: cfg.model };
  const picked = models[0];
  store.saveSettings(ownInUse ? { model: { model: picked } } : { fallback: { llm: { model: picked } } });
  return { ok: true, models, model: picked, replaced: cfg.model || null };
}

function registerIpc() {
  ipcMain.handle('app:boot', () => {
    ensureDefaultProject();
    const settings = store.getSettings();
    return {
      settings,
      programs: listPrograms(),
      modules: Object.values(MODULES),
      catalog: tools.catalog(),
      projects: store.listProjects(),
      roots: { dataDir: store.DATA_DIR, appDir: store.ROOT, uiStateDir: uistate.UI_STATE_DIR },
      catalogModes: ['auto', 'reviewer', 'always-ask'],
      // 思考强度的合法取值：**只在内核那份白名单里定义**（core/store.js，实测自端点），
      // 界面只是照它画下拉。界面自己再抄一份字面值，迟早会和内核的口径走散。
      reasoningLevels: store.REASONING_LEVELS,
      ui: { global: uistate.readGlobal(), window: uistate.readWindow(WINDOW_KEY), windowKey: WINDOW_KEY },
    };
  });

  // 布局状态：渲染层拖完分隔条 / 切面板 / 折叠侧栏都会打到这两个口
  ipcMain.handle('ui:state', () => ({ global: uistate.readGlobal(), window: uistate.readWindow(WINDOW_KEY), windowKey: WINDOW_KEY }));
  ipcMain.handle('ui:patch', (_e, patch) => uistate.patchWindow(WINDOW_KEY, patch));
  ipcMain.handle('ui:patchGlobal', (_e, patch) => uistate.patchGlobal(patch));
  ipcMain.handle('ui:reset', () => {
    uistate.patchWindow(WINDOW_KEY, uistate.defaultWindowState());
    return uistate.readWindow(WINDOW_KEY);
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, patch) => store.saveSettings(patch));
  ipcMain.handle('settings:userDataPath', () => app.getPath('userData'));

  // 无边框窗口：最小化 / 最大化切换 / 关闭，都由自绘顶栏的按钮打进来
  ipcMain.handle('win:minimize', () => {
    if (win && !win.isDestroyed()) win.minimize();
    return true;
  });
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => {
    if (win && !win.isDestroyed()) win.close();
    return true;
  });
  ipcMain.handle('win:isMaximized', () => !!(win && !win.isDestroyed() && win.isMaximized()));

  ipcMain.handle('models:list', async (_e, override) => {
    // 带 override = 设置页在"测这个地址通不通"，那就别动已保存的模型选择
    if (override) {
      const cfg = { ...store.getSettings().model, ...override };
      try {
        return { ok: true, models: await model.listModels(cfg), model: cfg.model || '' };
      } catch (e) {
        return { ok: false, error: reasonOf(e) + ' @ ' + (cfg.baseUrl || '') + '/models', models: [], model: '' };
      }
    }
    return resolveModel();
  });

  ipcMain.handle('projects:list', () => store.listProjects());
  ipcMain.handle('projects:create', (_e, { name, cwd }) => store.createProject(name, cwd));
  ipcMain.handle('projects:update', (_e, { id, patch }) => store.updateProject(id, patch));
  // 删除项目 = **只摘索引**（见 core/store.js 的 deleteProject）：从项目列表里移除这一条，
  // 磁盘上的记录目录、会话、检查点、工作目录一律不动。界面会拿 deleteInfo 写确认文案。
  ipcMain.handle('projects:deleteInfo', (_e, { projectId }) => store.projectDeleteInfo(projectId));
  ipcMain.handle('projects:delete', (_e, { projectId }) => {
    const info = store.projectDeleteInfo(projectId);
    if (!info) return { ok: false, message: '项目不存在：' + projectId };
    // 还有会话在跑就不给删：删掉的索引会让"正在跑的那一轮"的落点变得没头没尾
    const running = store.listSessions(projectId).filter((s) => agent.isRunning(s.id));
    if (running.length) {
      return { ok: false, message: '这个项目还有 ' + running.length + ' 个会话正在跑，先停掉再删。' };
    }
    const ok = store.deleteProject(projectId);
    console.log('[projects] 删除（只摘索引）' + JSON.stringify({ name: info.name, id: projectId }) +
      '；磁盘保留：' + info.recordDir + '；工作目录：' + (info.cwd || '—'));
    return { ok, info, message: ok ? '' : '删除失败：项目不在列表里' };
  });
  ipcMain.handle('projects:pickFolder', async () => {
    // 测试缝：HATCH_PICK_FOLDER 存在时直接返回该路径，不弹系统对话框。
    // （原生文件对话框没法自动化，但"新建项目"这条链路的其余部分必须能真点着测）
    if (process.env.HATCH_PICK_FOLDER) return process.env.HATCH_PICK_FOLDER;
    if (bgBlocked('系统文件夹对话框')) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // 工程索引的导出 / 导入。**只动 projects.json 那几行**，会话正文与工作目录一律不碰，
  // 与「删除项目只摘索引」是同一套保守语义。合并规则在 core/project-index.js（只增不减）。
  //
  // 测试缝：HATCH_SAVE_PATH / HATCH_OPEN_PATH 存在时直接当作用户选好的路径，不弹对话框
  // （原生对话框没法自动化，见 HATCH_PICK_FOLDER 的同款注释）。用备份文件自己的往返
  // 做端到端验证就是靠这条缝 —— 导出到该路径，再把它导入回来。
  ipcMain.handle('projects:exportIndex', async () => {
    let dest = process.env.HATCH_SAVE_PATH || null;
    if (!dest) {
      if (bgBlocked('系统保存对话框')) return { ok: false, message: '后台模式不弹系统对话框' };
      const r = await dialog.showSaveDialog(win, {
        title: '导出工程索引',
        defaultPath: path.join(app.getPath('documents'), projectIndex.defaultFileName()),
        filters: [{ name: 'One Harness 工程索引', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true, message: '已取消' };
      dest = r.filePath;
    }
    try {
      const r = store.exportProjectIndex(projectIndex.ensureJsonExt(dest), { version: app.getVersion() });
      console.log('[projects] 导出索引 ' + JSON.stringify({ path: r.path, count: r.count, bytes: r.bytes }));
      return { ok: true, path: r.path, count: r.count, bytes: r.bytes };
    } catch (e) {
      return { ok: false, message: '写不进去：' + String((e && e.message) || e) };
    }
  });

  ipcMain.handle('projects:importIndex', async () => {
    let src = process.env.HATCH_OPEN_PATH || null;
    if (!src) {
      if (bgBlocked('系统打开对话框')) return { ok: false, message: '后台模式不弹系统对话框' };
      const r = await dialog.showOpenDialog(win, {
        title: '导入工程索引',
        properties: ['openFile'],
        filters: [{ name: 'One Harness 工程索引', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, message: '已取消' };
      src = r.filePaths[0];
    }
    let r;
    try {
      r = store.importProjectIndex(src);
    } catch (e) {
      return { ok: false, message: '导入失败：' + String((e && e.message) || e) };
    }
    if (!r.ok) return { ok: false, message: r.error };
    console.log('[projects] 导入索引 ' + JSON.stringify({
      path: r.path, added: r.added, skipped: r.skipped, total: r.total,
      gone: r.gone, empty: r.empty, invalid: r.invalid,
    }));
    return {
      ok: true, path: r.path, added: r.added, skipped: r.skipped, total: r.total,
      gone: r.gone, empty: r.empty, invalid: r.invalid,
    };
  });

  ipcMain.handle('sessions:list', (_e, projectId) => store.listSessions(projectId));
  ipcMain.handle('sessions:create', (_e, input) => {
    const s = sessionLib.createSession({
      projectId: input.projectId,
      name: input.name,
      programId: input.programId,
      modules: input.modules,
      workingDir: input.workingDir,
    });
    s.instruction = PROMPTS[getProgram(s.programId).prompt];
    store.saveSession(s.projectId, s);
    return { session: s, meta: sessionMeta(s), transcript: sessionLib.renderTranscript(s) };
  });
  ipcMain.handle('sessions:load', (_e, { projectId, sessionId }) => {
    const s = loadSession(projectId, sessionId);
    return { session: s, meta: sessionMeta(s), transcript: sessionLib.renderTranscript(s) };
  });
  ipcMain.handle('sessions:rename', (_e, { projectId, sessionId, name }) => {
    const s = loadSession(projectId, sessionId);
    s.name = name;
    store.saveSession(projectId, s);
    return sessionMeta(s);
  });
  ipcMain.handle('sessions:update', (_e, { projectId, sessionId, patch }) => {
    const s = loadSession(projectId, sessionId);
    for (const k of SESSION_PATCH_KEYS) {
      if (k in patch) s[k] = patch[k];
    }
    if (patch.programId) {
      const p = getProgram(patch.programId);
      s.programId = p.id;
      s.promptKey = p.prompt;
      s.instruction = PROMPTS[p.prompt];
      if (!patch.modules) s.modules = p.modules;
    }
    store.saveSession(projectId, s);
    // 这一轮正在跑的话，把同样的字段就地补给它（见 liveSessions 的说明）：
    // 审批模式是每个工具调用现读的，所以能立刻对这个会话接下来的调用生效。
    const live = liveSessions.get(liveKey(projectId, sessionId));
    if (live && live !== s) for (const k of SESSION_PATCH_KEYS) live[k] = s[k];
    return { meta: sessionMeta(s) };
  });
  ipcMain.handle('sessions:delete', (_e, { projectId, sessionId }) => {
    const file = store.sessionFile(projectId, sessionId);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    return true;
  });
  ipcMain.handle('sessions:fork', (_e, { projectId, sessionId, entryId }) => {
    const s = loadSession(projectId, sessionId);
    const clone = sessionLib.forkSession(s, entryId);
    store.saveSession(projectId, clone);
    return { session: clone, meta: sessionMeta(clone), transcript: sessionLib.renderTranscript(clone) };
  });

  ipcMain.handle('chat:send', async (_e, { projectId, sessionId, text, attachments }) => {
    // 兜底：模型还没定下来（比如启动时端点没通）就先按端点推荐选一个，别把空模型名发出去
    if (!store.getSettings().model.model) await resolveModel();
    const s = loadSession(projectId, sessionId);
    // 附件按类型分流：图片进 image part，其余仍是 `[附件] x` 文本行。
    // 判定只有一处实现（core/images.js），渲染层只管把相对路径丢上来。
    // 这里**不看** supportsVision 开关 —— 图先按图记下来，发请求那一刻再由
    // renderMessages 决定走数组还是退化成一行文本。这样用户事后把开关打开，
    // 之前拖进来的图立刻就能用，不必重拖一遍。
    const list = (attachments || []).filter(Boolean);
    const pics = list.filter((a) => images.isImage(a)).map((a) => ({ rel: a, mime: images.mimeFor(a) }));
    const others = list.filter((a) => !images.isImage(a));
    // 非图片附件仍然是老规矩：拼成 `[附件] x` 几行跟在正文后面。
    // 这一行是**唯一**的拼接处，渲染层拿它覆盖本地回声（见下面的 return）。
    const body = others.length ? text + '\n\n' + others.map((a) => `[附件] ${a}`).join('\n') : text;
    sessionLib.userMessage(s, body, { images: pics });
    if (s.name === '新会话') {
      // 只拖图不打字时正文是空的，拿第一张图的名字当会话名，总比叫"新会话"好找
      const seed = body.replace(/\s+/g, ' ').trim() || (pics.length ? pics[0].rel : '');
      s.name = seed.slice(0, 24) || '新会话';
    }
    store.saveSession(projectId, s);
    // 不等待整轮结束：进度通过 agent:event 推给渲染层
    // 不等待整轮结束：进度通过 agent:event 推给渲染层。
    // 登记这份对象（见 liveSessions）：本轮跑着的时候，sessions:update 要能找到它、就地改，
    // 否则运行中切审批模式只会改到磁盘上那份，本轮读的还是老值。
    liveSessions.set(liveKey(projectId, sessionId), s);
    runlog.turn({ phase: 'request', sessionId, projectId, model: (store.getSettings().model || {}).model, chars: String(body || '').length, text: String(body || '').slice(0, 200), images: pics.length, vision: !!store.getSettings().model.supportsVision });
    agent.runTurn(s).catch((e) => {
      runlog.log('turn.failed', { sessionId: s.id, error: reasonOf(e), stack: (e && e.stack || '').split('\n').slice(0, 4).join(' | ') });
      if (!win || win.isDestroyed()) return;
      win.webContents.send('agent:event', { type: 'log', sessionId: s.id, message: '本轮异常：' + e.message });
      // runTurn 有"连 try 都没进就抛"的路径（同会话重入：'这个会话正在运行中。'），
      // 这些路径自己不发 turn:end，而渲染层的运行状态是被 turn:end 复位的 → 会永久停在"运行中"。
      // 但重入时**另一个本轮还持有这个会话**，它的 turn:end 迟早会来，这时替他补发
      // 会让界面误判成"没在运行"（用户再点发送就又是重入）。
      // 所以只在"内核确认这个会话确实没在跑"时才补发，让界面自愈。
      if (!agent.isRunning(s.id)) {
        win.webContents.send('agent:event', { type: 'turn:end', sessionId: s.id, aborted: true, failed: true });
      }
    }).finally(() => {
      // 本轮结束（正常/异常/被停）都注销：别让"跑着的那份对象"长期占着位置，
      // 之后 sessions:update 应该继续走磁盘那份。
      liveSessions.delete(liveKey(projectId, sessionId));
    });
    // body 回给渲染层：界面上那条"已发出"的本地回声要和真正发出去的字节一致，
    // 而拼接规则只应该有一处实现（就是上面这行）—— 别让渲染层再抄一遍。
    // images 一并回：回声气泡要立刻显示缩略图，不能等下一轮 session:update 才蹦出来。
    return { started: true, body, images: pics.map((p) => p.rel), meta: sessionMeta(s), transcript: sessionLib.renderTranscript(s) };
  });
  ipcMain.handle('chat:stop', (_e, { sessionId }) => {
    const ok = agent.stop(sessionId);
    runlog.log('turn.stop', { sessionId, hit: ok });
    return ok;
  });

  ipcMain.handle('approval:answer', (_e, { requestId, approved, note, always }) => {
    const resolve = pendingApprovals.get(requestId);
    if (!resolve) return false;
    pendingApprovals.delete(requestId);
    resolve({ approved: !!approved, note: note || '', always: !!always });
    return true;
  });

  // 面板要的是"每个文件一行"（不是原始日志行：同一个文件改 5 次会出 5 行，
  // 而且 'restored'（恢复动作本身）也混在里面 —— 那一行的「恢复」按钮点下去
  // 就是用户报的 ERR_INVALID_ARG_TYPE：restored 的 sha 是 null，被当成 blob 文件名）。
  ipcMain.handle('checkpoints:list', (_e, projectId) => checkpoints.listFiles(projectId, 80));
  ipcMain.handle('checkpoints:rollback', (_e, { projectId, sessionId, entryId }) => {
    const s = loadSession(projectId, sessionId);
    const entry = sessionLib.findEntry(s, entryId);
    if (!entry) return { ok: false, message: '找不到这条消息。' };
    const r = checkpoints.rollbackTo(projectId, sessionId, entry.ts);
    return { ok: true, ...r, message: `已恢复 ${r.restored.length} 个文件，删除 ${r.deleted.length} 个新建文件${r.skipped.length ? `，跳过 ${r.skipped.length} 个` : ''}` };
  });
  ipcMain.handle('checkpoints:revertFile', (_e, { projectId, sessionId, absPath }) => checkpoints.revertFile(projectId, sessionId, absPath));

  ipcMain.handle('skills:list', () => skillsMod.listSkills());
  ipcMain.handle('skills:openDir', () => {
    const dir = store.ensureDir(path.join(store.DATA_DIR, 'skills'));
    if (bgBlocked('打开技能目录 ' + dir)) return '';
    return shell.openPath(dir);
  });
  ipcMain.handle('skills:read', (_e, name) => {
    const s = skillsMod.findSkill(name);
    if (!s) return null;
    return { ...s, content: fs.readFileSync(s.path, 'utf8') };
  });
  ipcMain.handle('skills:save', (_e, { dir, name, content }) => {
    const target = path.join(dir || path.join(store.DATA_DIR, 'skills'), name, 'SKILL.md');
    store.ensureDir(path.dirname(target));
    fs.writeFileSync(target, content, 'utf8');
    return { path: target };
  });

  ipcMain.handle('fs:readText', (_e, { projectId, sessionId, absPath }) => {
    try {
      const buf = fs.readFileSync(absPath);
      if (buf.includes(0)) return { ok: false, error: '这是二进制文件。' };
      const text = buf.toString('utf8');
      return { ok: true, text: text.length > 200000 ? text.slice(0, 200000) + '\n…[截断]' : text, size: buf.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // 拖进来的文件：搬一份进这个会话的工作目录，把**相对路径**还给渲染层。
  // 为什么非搬不可：core/tools/fs.js 的 resolveIn() 拒绝工作目录外的路径
  // （实测把 Downloads 下的绝对路径交给文档工具，直接判「路径越界」）。
  // 所以拖入的语义 = 本地复制（不上传、不联网），落点就是 session.workingDir。
  ipcMain.handle('files:attach', (_e, { projectId, sessionId, absPath }) => {
    try {
      const s = loadSession(projectId, sessionId);
      const root = s.workingDir;
      if (!root) return { ok: false, error: '这个会话没有工作目录，先在项目里选一个文件夹' };
      const src = path.resolve(String(absPath || ''));
      const st = fs.statSync(src); // 不存在会抛，下面统一兜成文案
      if (st.isDirectory()) return { ok: false, error: '这是个文件夹，一次拖一个文件进来' };
      const rel0 = path.relative(root, src);
      const inside = rel0 !== '' && !rel0.startsWith('..') && !path.isAbsolute(rel0);
      // 本来就在工作目录里 → 不复制，直接用（拖一次就多一份副本反而脏）
      const dest = inside ? src : store.uniquePath(root, path.basename(src, path.extname(src)), path.extname(src));
      if (!inside) {
        store.ensureDir(root);
        fs.copyFileSync(src, dest);
      }
      const rel = path.relative(root, dest).split(path.sep).join('/');
      runlog.log('file.attach', { sessionId, from: src, to: dest, copied: !inside, bytes: st.size });
      // 图片顺手量一下宽高：附件小条上要显示尺寸，超长边的要能给"太大"的提示。
      // 这里**不**塞 data URL —— 要看像素是 files:preview 的事，两个语义别混在一起。
      const info = images.isImage(dest) ? images.inspect(dest) : null;
      return {
        ok: true, rel, name: path.basename(dest), copied: !inside, bytes: fs.statSync(dest).size, from: src,
        image: info ? {
          ok: info.ok, error: info.ok ? null : info.error,
          width: info.width || null, height: info.height || null,
          tokens: info.tokens || 0, oversize: !!info.oversize,
        } : null,
      };
    } catch (e) {
      const msg = e.code === 'ENOENT' ? '源文件不在了（可能已被移动或删除）'
        : e.code === 'EPERM' || e.code === 'EACCES' ? '没权限读写（源文件被占用，或工作目录不可写）'
        : e.code === 'ENOSPC' ? '磁盘空间不够'
        : (e.message || String(e));
      return { ok: false, error: msg };
    }
  });
  // 渲染层要一张图的像素（气泡缩略图）。transcript 里只带相对路径，像素按需来取。
  // 只认工作目录内的路径 —— 和 core/tools/fs.js 的 resolveIn 同一条规矩：
  // 凡是"用户给的路径"，都必须在会话工作目录里，否则一律拒绝。
  ipcMain.handle('files:preview', (_e, { projectId, sessionId, rel }) => {
    try {
      const s = loadSession(projectId, sessionId);
      const root = s.workingDir;
      if (!root) return { ok: false, error: '这个会话没有工作目录' };
      const abs = path.resolve(root, String(rel || ''));
      const out = path.relative(root, abs);
      if (out === '' || out.startsWith('..') || path.isAbsolute(out)) return { ok: false, error: '路径越界' };
      const r = images.inspect(abs);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, dataUrl: r.dataUrl, abs, width: r.width, height: r.height, mime: r.mime, bytes: r.bytes };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
  ipcMain.handle('shell:openPath', (_e, target) => (bgBlocked('打开路径 ' + target) ? '' : shell.openPath(target)));
  // "用系统默认浏览器/默认程序打开" —— 只能走 openExternal，走 openPath 必然失败
  // （openPath 只吃文件系统路径，且失败是 resolve 出来的字符串、不抛异常 → 旧代码静默不动，
  //  表现就是用户报的"按了没反应"，详见 core/open-target.js 开头的说明）。
  // 返回值统一带 kind/target，渲染层据此给成功/失败提示：不再有"什么都不发生"这条路径。
  ipcMain.handle('shell:openExternal', async (_e, raw) => {
    const r = openTarget.resolve(raw);
    if (r.kind === 'empty') return { ok: false, error: '地址是空的' };
    // HATCH_OPEN_DRYRUN：只判定不打开。自动化测试要用它 —— 测试不能真把浏览器/资源管理器
    // 糊到用户屏幕上（同 HATCH_PICK_FOLDER 的道理）。放在 bgBlocked 之前：dry-run 不碰系统，
    // 后台守卫管不着它。
    if (OPEN_DRYRUN) {
      console.log('[open] dry-run ' + r.kind + ' → ' + r.target);
      return { ok: true, dryRun: true, kind: r.kind, target: r.target };
    }
    if (bgBlocked('用系统程序打开 ' + r.target)) return { ok: false, error: '后台模式不打开外部程序' };
    try {
      await shell.openExternal(r.target);
      return { ok: true, kind: r.kind, target: r.target };
    } catch (e) {
      // 本地文件再退一步：交给系统按关联程序打开（浏览器处理不了的 .docx 之类）
      if (r.kind === 'path') {
        const msg = await shell.openPath(r.abs);
        if (!msg) return { ok: true, kind: 'path-fallback', target: r.abs };
        return { ok: false, error: msg, target: r.target };
      }
      return { ok: false, error: (e && e.message) || String(e), target: r.target };
    }
  });
  ipcMain.handle('shell:showItem', (_e, target) => (bgBlocked('在文件夹中显示 ' + target) ? undefined : shell.showItemInFolder(target)));
  ipcMain.handle('app:openDataDir', () => (bgBlocked('打开数据目录') ? '' : shell.openPath(store.DATA_DIR)));
  ipcMain.handle('agent:event', (_e, payload) => { /* 占位：渲染层主动推送用不到 */ return true; });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(store.DATA_DIR) },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
