'use strict';
// 真实鼠标巡检跑分器：起 Electron（不显示窗口），由主进程发**真实鼠标事件**，
// 读回结果并据此给退出码。
// 运行： node test/run-mouse.js [steps 模块]     默认 test/mouse-steps.js
//
// 与 run-ui.js 的分工：run-ui.js 在渲染层跑脚本、点按钮用 el.click()（快、能测业务链路，
// 但绕过命中测试）；本跑分器只发真实鼠标输入，专门测"这个控件真人点得到吗"。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
// --visible：明确表示"我知道屏幕上会冒一个置顶窗口"（npm run test:mouse:visible 走这条）
const argv = process.argv.slice(2);
const WANT_VISIBLE = argv.includes('--visible');
const STEPS = path.resolve(ROOT, argv.find((a) => !a.startsWith('--')) || 'test/mouse-steps.js');
const TMP = path.join(ROOT, 'test', '.tmp-mouse');
let DATA_DIR = path.join(TMP, 'data');
const PICK_DIR = path.join(TMP, 'probe-proj');
const OUT = path.join(TMP, 'mouse-result.json');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const TIMEOUT_MS = Number(process.env.HATCH_MOUSE_TIMEOUT || 240000);

if (!fs.existsSync(ELECTRON)) {
  console.error('找不到 Electron：' + ELECTRON);
  process.exit(1);
}
if (!fs.existsSync(STEPS)) {
  console.error('找不到 steps 模块：' + STEPS);
  process.exit(1);
}

// 干净数据目录，否则"左栏初始是展开的"这类断言会跟着上一次的状态漂。
// 删不掉就换一个全新的目录（有些环境对批量删除有保护），效果一样。
try {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
} catch (e) {
  DATA_DIR = path.join(TMP, 'data-' + Date.now());
  console.log('[run-mouse] 旧数据目录删不掉（' + e.message.split('\n')[0] + '），改用 ' + path.basename(DATA_DIR));
}
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(PICK_DIR, { recursive: true });
try { fs.rmSync(OUT, { force: true }); } catch {}

const env = {
  ...process.env,
  HATCH_DEBUG: '1',
  // 不显示窗口、不抢焦点、不进任务栏：用户可能正在用主屏干别的（见 main.js 的 BACKGROUND）
  HATCH_BACKGROUND: '1',
  HATCH_DATA_DIR: DATA_DIR,
  // 系统文件夹对话框是原生的、没法自动化，桩掉它；这条链路的其余部分是真的。
  // （main.js 里还有一道保险：BACKGROUND 模式下没桩就直接不弹，见 bgBlocked）
  HATCH_PICK_FOLDER: PICK_DIR,
  HATCH_MOUSE_FILE: STEPS,
  HATCH_MOUSE_OUT: OUT,
  HATCH_MOUSE_DELAY: '3000',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

// 窗口要**真显示出来**，而且要获得焦点：
//   - 屏幕外的窗口合成帧率极低，mouseMoved 会被 MouseEventQueue 攒着慢慢派发（读到 0），
//     滚轮事件甚至完全合成不出来；
//   - 滚轮还需要 renderer 处于聚焦态。
// 代价是测试期间屏幕上会出现一个 One Harness 窗口。要安静跑就设 HATCH_MOUSE_OFFSCREEN=1
// （点/拖拽/键盘仍然可靠，hover 与滚轮会不准）。
if (process.env.HATCH_MOUSE_OFFSCREEN) {
  env.HATCH_OFFSCREEN = '1';
  // 屏幕外只求"安静跑"：点/拖/键盘仍可靠，悬停与滚轮本来就不准（见 main.js 的 OFFSCREEN），
  // 所以不申请焦点 —— 屏幕外的窗口拿焦点只会平白打断用户。
} else {
  env.HATCH_SHOT_VISIBLE = '1';
  // 巡检必须让窗口真拿到系统焦点：focusable:false 或 showInactive 时滚轮完全合成不出来、
  // mouseMoved 被攒着不派发、打字掉字符（见 main.js 的 NEEDS_FOCUS）。
  env.HATCH_FOCUSABLE = '1';
}

// ★ 用户在场时的保护闸 ★
// 这个巡检开的是**抢焦点 + 置顶**的窗口（NEEDS_FOCUS 那套），跑一次屏幕上就冒出一个
// 40 秒的窗口压在别人所有窗口上面。2026-09-17 的教训：我连跑 6 次回归，恰好用户在
// 点自己那个确认框的「确定」—— 他那一击落在我的测试窗口上，现象就是"点了没反应"，
// 查了半天以为是应用 bug。同类事故以前也发生过（用户在打游戏被弹窗打断）。
//
// 规矩：**默认不许在用户在场时弹这种窗口**。要跑真实输入巡检，必须显式说清楚：
//   HATCH_ALLOW_STEAL_FOCUS=1  →  我（或用户）明确知道屏幕上会冒一个置顶窗口
//   HATCH_MOUSE_OFFSCREEN=1    →  安静模式（屏幕外，不抢焦点；悬停/滚轮那两条允许不准）
// 两者都没给就直接拒绝启动，并把两条出路打出来 —— 免得下次又有人"顺手跑一下回归"。
const ALLOW_STEAL = WANT_VISIBLE || process.env.HATCH_ALLOW_STEAL_FOCUS === '1';
if (!ALLOW_STEAL && !process.env.HATCH_MOUSE_OFFSCREEN) {
  console.error([
    '拒绝启动：真实鼠标巡检会弹出一个「抢焦点 + 置顶」的窗口，可能打断你正在做的事',
    '（2026-09-17 踩过：连跑几次回归，用户的点击落在测试窗口上，被误判成"按钮点了没反应"）。',
    '',
    '两条出路，选一条：',
    '  1) 屏幕外安静跑（不抢焦点；悬停与滚轮那两条允许不准）：',
    '       HATCH_MOUSE_OFFSCREEN=1 node test/run-mouse.js',
    '  2) 明确接受"屏幕上会冒一个置顶窗口"：',
    '       HATCH_ALLOW_STEAL_FOCUS=1 node test/run-mouse.js',
    '',
    '（批量回归请走第 1 条；要验悬停/滚轮才用第 2 条，且**跑一次就够，别连着跑多次**。）',
  ].join('\n'));
  process.exit(2);
}

const child = spawn(ELECTRON, ['.'], {
  cwd: ROOT,
  windowsHide: false, // 同 launch-check.js：设 true 会影响窗口可见性判断
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('close', resolve);
      k.on('error', resolve);
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      resolve();
    }
  });
}

function report(code) {
  const all = out + err;
  try { fs.writeFileSync(path.join(TMP, 'electron.log'), all); } catch {}
  const winLine = all.split('\n').filter((l) => /^\[win\] /.test(l));
  if (winLine.length) console.log('窗口状态：' + winLine.join(' | '));

  let res = null;
  try { res = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  console.log('--- 真实鼠标巡检：' + path.relative(ROOT, STEPS) + ' ---');
  if (!res) {
    console.log('没拿到巡检结果，输出尾部：\n' + all.slice(-2000));
    process.exit(1);
  }

  const s = res.summary || {};
  const detail = s['明细'] || [];
  for (const it of detail) {
    console.log((it.ok ? '  ✓ ' : '  ✗ ') + it.name + (it.ok ? '' : '  ← ' + JSON.stringify(it.extra)));
  }
  console.log('通过 ' + (s['通过'] ?? '?') + '/' + (s['总数'] ?? '?'));
  if (s['失败'] && s['失败'].length) console.log('失败项：\n  - ' + s['失败'].join('\n  - '));
  if (res.unhandled && res.unhandled.length) console.log('渲染层未处理异常：\n' + res.unhandled.join('\n'));
  if (res.error) console.log('巡检异常：' + res.error);
  console.log('electron 退出码：' + code);
  process.exit(res.error || (s['失败'] && s['失败'].length) ? 1 : 0);
}

const timer = setTimeout(async () => {
  console.log('超时，输出尾部：\n' + (out + err).slice(-2000));
  await killTree(child.pid);
  process.exit(1);
}, TIMEOUT_MS);

child.on('exit', async (code) => {
  clearTimeout(timer);
  await killTree(child.pid);
  report(code);
});
