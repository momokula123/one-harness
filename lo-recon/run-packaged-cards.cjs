'use strict';
// 在**打包树**里真跑一次关键功能（出包清单第 5 步）：绿色版 exe + 指定的数据目录，
// 注入 UI 探针，断言设置里的技能卡片，并抓一张图。
//
// 为什么必须在打包树里跑：开发态跑得再好也说明不了包里的东西 —— 包内 app/package.json
// 是被裁剪过的、路径是 exe 相对的、asar 关掉后目录形态也不同。历史上就出过
// "文件名承诺的功能，包里没有"（0.1.0 那个 zip 里根本没有引擎）。
//
// 两个环境变量**必须同时给**（只给一个会走到 exe 旁边那套目录，等于没隔离）：
//   HATCH_DATA_DIR   —— 程序数据（settings / projects 索引 / skills）
//   HATCH_USER_DATA  —— Chromium 的 userData
//
// 跑法：node lo-recon/run-packaged-cards.cjs
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ★ 默认就打**真产物**：dist/<版本>/win-unpacked。版本从**包内**的 package.json 读
//   （"提交了 ≠ 包里有"，仓库里那份不算数），路径也全部从包目录推出来。
//   想换成别的目录（例：临时铺的探针数据）必须显式传 PKG_DATA —— 那种跑法只能当补充，
//   不能当"这个包能跑"的证据：2026-09-19 我就拿拷贝出来的数据目录当替身跑绿了，
//   用户打开真产物只有 2 张卡（技能压根没进包），被指着鼻子骂"用中间态做测试"。
function newestDistDir() {
  const base = path.join(ROOT, 'dist');
  const num = (v) => v.split('.').map(Number);
  const newer = (a, b) => {                       // 逐段比大小，别用加权求和（更别取排序后的第 0 个）
    const A = num(a); const B = num(b);
    for (let i = 0; i < 3; i += 1) { if (A[i] !== B[i]) return A[i] - B[i]; }
    return 0;
  };
  const dirs = fs.readdirSync(base).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort(newer);
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : null;   // ← 最后一个才是最新
}

const PKG_DIR = process.env.PKG_DIR
  ? path.resolve(ROOT, process.env.PKG_DIR)
  : path.join(newestDistDir() || path.join(ROOT, 'dist'), 'win-unpacked');
const EXE = path.join(PKG_DIR, 'One Harness.exe');
const PKG_JSON = path.join(PKG_DIR, 'resources', 'app', 'package.json');
const PROBE = path.join(ROOT, 'test', 'settings-cards.js');
const DATA = process.env.PKG_DATA
  ? path.resolve(ROOT, process.env.PKG_DATA)
  : path.join(PKG_DIR, 'data');                                    // ← 真产物的数据目录
const USERDATA = path.join(ROOT, 'test', '.tmp-pkg-userdata');
const SHOT = process.env.PKG_SHOT
  ? path.resolve(ROOT, process.env.PKG_SHOT)
  : path.join(ROOT, 'lo-recon', 'packaged-skills-cards.png');

for (const [name, p] of [['exe', EXE], ['探针', PROBE], ['包内 package.json', PKG_JSON]]) {
  if (!fs.existsSync(p)) { console.error('找不到' + name + '：' + p); process.exit(1); }
}
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

// 版本一律读**包内**那份：仓库里的 package.json 说 0.1.8 不代表这个包里是 0.1.8
const pkgVersion = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')).version;

const env = {
  ...process.env,
  HATCH_DATA_DIR: DATA,
  HATCH_USER_DATA: USERDATA,
  HATCH_EVAL_FILE: PROBE,
  HATCH_SHOOT: SHOT,
  HATCH_SHOT_VISIBLE: '1',       // 不显示窗口的话 Windows 上 capturePage 只能抓到空白
  HATCH_SHOOT_DELAY: '3000',
  HATCH_OPEN_DRYRUN: '1',        // 不许真把浏览器/资源管理器弹出来
};
// 本机 shell 预设了这两个：不删掉，exe 会退化成纯 Node（app 未定义）
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

console.log('[pkg-probe] ' + EXE);
console.log('[pkg-probe] 包内版本 ' + pkgVersion + '（读自 ' + path.relative(ROOT, PKG_JSON) + '）');
console.log('[pkg-probe] 数据目录 ' + DATA);
const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

const timer = setTimeout(() => {
  console.log('超时，输出尾部：\n' + out.slice(-2000));
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  process.exit(1);
}, 180000);

child.on('exit', (code) => {
  clearTimeout(timer);
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });

  const ver = (/\[app\.start\][^\n]*/.exec(out) || [''])[0];
  // 版本一律以**包内**那份为准（日志在打包版里不一定进 stdout，靠它容易得出"没拿到"）
  console.log('包内版本：' + pkgVersion + '（' + path.relative(ROOT, PKG_JSON) + '）');
  if (ver) console.log('程序自报：' + ver);
  const evalLine = /\[eval\] (.+)/.exec(out);
  const failed = /\[eval\] failed (.+)/.exec(out);
  const unhandled = out.split('\n').filter((l) => /\[unhandled\]/.test(l));

  if (failed) {
    console.log('探针失败：' + failed[1]);
    console.log(out.slice(-1500));
  } else if (evalLine) {
    let r = null;
    try { r = JSON.parse(evalLine[1]); } catch {}
    if (r && r.verdict) {
      const bad = Object.entries(r.verdict).filter(([, v]) => !v);
      console.log('断言 ' + (Object.keys(r.verdict).length - bad.length) + '/' + Object.keys(r.verdict).length +
        (bad.length ? '，失败：' + JSON.stringify(bad.map(([k]) => k)) : ''));
      console.log('卡片数：' + r.cardCount + ' / 预期 ' + r.expectedCount + '；' + JSON.stringify(r.cardNames));
    } else {
      console.log(evalLine[1].slice(0, 800));
    }
  } else {
    console.log('没拿到探针结果，输出尾部：\n' + out.slice(-1500));
  }
  if (unhandled.length) console.log('渲染层未处理异常：\n' + unhandled.join('\n'));
  if (fs.existsSync(SHOT)) console.log('截图：' + SHOT);
  console.log('exe 退出码：' + code);
  process.exit(failed || !evalLine ? 1 : 0);
});
