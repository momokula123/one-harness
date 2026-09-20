'use strict';
// 在**打包好的 exe** 上跑真鼠标步骤脚本（HATCH_MOUSE_FILE 通道），并收截图。
//
// 跑法：node lo-recon/run-pkg-mouse.cjs lo-recon/mouse-repro-reopen.js [版本目录名]
//
// 为什么和 test/run-mouse.js 分开：那个跑的是开发目录的 electron + node_modules；
// 这个跑的是**用户拿到的那份产物**（路径是 exe 相对的、随包 config/skills 靠 APP_ROOT 读）。
// 窗口走 OFFSCREEN（显示后挪到所有屏幕之外）：不抢焦点、不压住用户，但指针事件照常合成。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const stepsArg = process.argv[2];
if (!stepsArg) { console.error('用法：node lo-recon/run-pkg-mouse.cjs <步骤模块.js> [版本目录名]'); process.exit(2); }
const STEPS = path.resolve(ROOT, stepsArg);
if (!fs.existsSync(STEPS)) { console.error('找不到步骤模块：' + STEPS); process.exit(2); }

function newestDistDir() {
  const base = path.join(ROOT, 'dist');
  const num = (v) => v.split('.').map(Number);
  const newer = (a, b) => { const A = num(a); const B = num(b); for (let i = 0; i < 3; i += 1) { if (A[i] !== B[i]) return A[i] - B[i]; } return 0; };
  const dirs = fs.readdirSync(base).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort(newer);
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : null;
}
const PKG_DIR = process.argv[3]
  ? path.join(ROOT, 'dist', process.argv[3], 'win-unpacked')
  : path.join(newestDistDir() || path.join(ROOT, 'dist'), 'win-unpacked');
const EXE = path.join(PKG_DIR, 'One Harness.exe');
if (!fs.existsSync(EXE)) { console.error('找不到 exe：' + EXE); process.exit(1); }

const stamp = Date.now();
const TMP = path.join(ROOT, 'test', '.tmp-pkgmouse-' + stamp);
const DATA = path.join(TMP, 'data');
const USERDATA = path.join(TMP, 'userdata');
const PICK = path.join(TMP, 'pick');
const OUT = path.join(TMP, 'mouse-result.json');
for (const d of [DATA, USERDATA, PICK]) fs.mkdirSync(d, { recursive: true });

const env = {
  ...process.env,
  HATCH_DEBUG: '1',
  HATCH_DATA_DIR: DATA,
  HATCH_USER_DATA: USERDATA,
  HATCH_PICK_FOLDER: PICK,
  HATCH_MOUSE_FILE: STEPS,
  HATCH_MOUSE_OUT: OUT,
  HATCH_OPEN_DRYRUN: '1',
  HATCH_MOUSE_DELAY: '3500',
  // 安静模式：显示后挪到所有屏幕之外。点/拖/键盘仍可靠（本项目只需要点）。
  HATCH_OFFSCREEN: '1',
  // 截图必须"窗口可见"才有内容；BACKGROUND 没设，所以 shot() 不会被跳过。
  HATCH_SHOT_VISIBLE: '1',
  HATCH_SAVE_PATH: path.join(TMP, 'idx.json'),
  HATCH_OPEN_PATH: path.join(TMP, 'idx.json'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

console.log('[pkg-mouse] ' + EXE);
console.log('[pkg-mouse] 步骤 ' + path.relative(ROOT, STEPS));
console.log('[pkg-mouse] 干净数据目录 ' + DATA);

const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

const timer = setTimeout(() => {
  console.log('超时，输出尾部：\n' + out.slice(-2500));
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  process.exit(1);
}, Number(process.env.HATCH_PKGMOUSE_TIMEOUT || 240000));

child.on('exit', (code) => {
  clearTimeout(timer);
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });

  const mouseLines = out.split('\n').filter((l) => /\[mouse\]/.test(l));
  let r = null;
  try { r = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}

  if (r && r.summary && r.summary.verdict) {
    const bad = Object.entries(r.summary.verdict).filter(([, v]) => !v);
    console.log('断言 ' + (Object.keys(r.summary.verdict).length - bad.length) + '/' +
      Object.keys(r.summary.verdict).length + (bad.length ? '，失败：' + JSON.stringify(bad.map(([k]) => k)) : ''));
    console.log('  状态 ' + JSON.stringify(r.summary));
  } else {
    console.log('没拿到步骤结果，输出尾部：\n' + out.slice(-2000));
  }
  console.log('--- 步骤脚本日志 ---\n' + mouseLines.join('\n'));
  if (r && r.clickTargets) {
    console.log('--- 每次点击的命中测试（topmost = 那个点上最顶层的元素）---');
    for (const c of r.clickTargets) {
      console.log('  ' + c.target + ' → ' + (c.clicked ? 'clicked' : 'NOT clicked') +
        '  topmost=' + c.topmost + ' reachable=' + c.reachable +
        (c.note ? '  note=' + c.note : ''));
    }
  }
  if (r && r.unhandled && r.unhandled.length) console.log('渲染层未处理异常：\n' + r.unhandled.join('\n'));
  if (r && r.error) console.log('步骤脚本异常：\n' + r.error);
  console.log('exe 退出码：' + code);
  const ok = r && r.summary && r.summary.verdict && Object.values(r.summary.verdict).every(Boolean);
  process.exit(ok ? 0 : 1);
});
