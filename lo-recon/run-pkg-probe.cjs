'use strict';
// 通用真产物探针跑分器：把任意探针 .js 注入打包好的 exe（出包清单第 5 步）。
//
// 跑法：node lo-recon/run-pkg-probe.cjs lo-recon/pkg-probe-reopen.js [版本目录名]
// 默认版本目录 = dist/ 下最新的 semver 目录（不想默认打最新版就显式给第二个参数）。
//
// 为什么必须打真产物（不是开发目录）：包内 app/package.json 是裁剪过的、路径是 exe 相对的、
// 随包资源（config/、skills/）要靠 APP_ROOT 才读得到。开发态跑绿证明不了用户拿到的东西。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const probeArg = process.argv[2];
if (!probeArg) { console.error('用法：node lo-recon/run-pkg-probe.cjs <探针.js> [版本目录名]'); process.exit(2); }
const PROBE_SRC = path.resolve(ROOT, probeArg);
if (!fs.existsSync(PROBE_SRC)) { console.error('找不到探针：' + PROBE_SRC); process.exit(2); }

function newestDistDir() {
  const base = path.join(ROOT, 'dist');
  const num = (v) => v.split('.').map(Number);
  const newer = (a, b) => {
    const A = num(a); const B = num(b);
    for (let i = 0; i < 3; i += 1) { if (A[i] !== B[i]) return A[i] - B[i]; }
    return 0;
  };
  const dirs = fs.readdirSync(base).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort(newer);
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : null;
}

const PKG_DIR = process.argv[3]
  ? path.join(ROOT, 'dist', process.argv[3], 'win-unpacked')
  : path.join(newestDistDir() || path.join(ROOT, 'dist'), 'win-unpacked');
const EXE = path.join(PKG_DIR, 'One Harness.exe');
const PKG_JSON = path.join(PKG_DIR, 'resources', 'app', 'package.json');
for (const [name, p] of [['exe', EXE], ['包内 package.json', PKG_JSON]]) {
  if (!fs.existsSync(p)) { console.error('找不到' + name + '：' + p); process.exit(1); }
}
const pkgVersion = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')).version;

// 每次跑用一个全新的数据目录（时间戳保证是空的 —— 不做任何删除动作）
const stamp = Date.now();
const DATA = path.join(ROOT, 'test', '.tmp-pkgprobe-data-' + stamp);
const USERDATA = path.join(ROOT, 'test', '.tmp-pkgprobe-userdata-' + stamp);
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

const env = {
  ...process.env,
  HATCH_DATA_DIR: DATA,
  HATCH_USER_DATA: USERDATA,
  HATCH_EVAL_FILE: PROBE_SRC,
  HATCH_OPEN_DRYRUN: '1',
  // HATCH_SHOOT 是"注入探针 + 抓图 + 跑完退出"整段的门控；只开断言不留图，所以不设 HATCH_SHOT_VISIBLE。
  HATCH_SHOOT: path.join(USERDATA, 'unused-shot.png'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

console.log('[pkg-probe] ' + EXE);
console.log('[pkg-probe] 包内版本 ' + pkgVersion + ' / 探针 ' + path.relative(ROOT, PROBE_SRC));

const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

const timer = setTimeout(() => {
  console.log('超时，输出尾部：\n' + out.slice(-2500));
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  process.exit(1);
}, 240000);

child.on('exit', (code) => {
  clearTimeout(timer);
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });

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
      console.log('  ' + JSON.stringify(r));
    } else {
      console.log(evalLine[1].slice(0, 900));
    }
  } else {
    console.log('没拿到探针结果，输出尾部：\n' + out.slice(-2000));
  }
  if (unhandled.length) console.log('渲染层未处理异常：\n' + unhandled.join('\n'));
  console.log('exe 退出码：' + code);
  process.exit(failed || !evalLine ? 1 : 0);
});
