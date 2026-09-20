'use strict';
// 打包树首跑探针跑分器（出包清单第 5 步）：全新数据目录 + 绿色版 exe，
// 断言"用户第一眼看到的东西"：起始页 = 默认对话 + 随包技能卡片齐全。
// 跑法：node lo-recon/run-packaged-firstrun.cjs
// 探针本体：test/pkg-first-run.js（骨架抄 run-packaged-cards.cjs，探针换成首跑断言）。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

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

const PKG_DIR = process.env.PKG_DIR
  ? path.resolve(ROOT, process.env.PKG_DIR)
  : path.join(newestDistDir() || path.join(ROOT, 'dist'), 'win-unpacked');
const EXE = path.join(PKG_DIR, 'One Harness.exe');
const PKG_JSON = path.join(PKG_DIR, 'resources', 'app', 'package.json');
const PROBE = path.join(ROOT, 'test', 'pkg-first-run.js');
// 首跑必须用**全新的空数据目录**：拿旧的跑就验不出"新装自动进默认对话"了。
// 每次跑都换新目录（时间戳后缀），不在脚本里删旧目录 —— 沙箱删除守卫按"轮"分桶，
// 大目录 rmSync 会被拦。旧目录攒多了手动清一次即可。
const RUN_TAG = new Date().toISOString().replace(/[:.]/g, '-');
const DATA = path.join(ROOT, 'test', '.tmp-firstrun-data-' + RUN_TAG);
const USERDATA = path.join(ROOT, 'test', '.tmp-firstrun-userdata-' + RUN_TAG);

for (const [name, p] of [['exe', EXE], ['探针', PROBE], ['包内 package.json', PKG_JSON]]) {
  if (!fs.existsSync(p)) { console.error('找不到' + name + '：' + p); process.exit(1); }
}
// 目录不存在才建（新目录天然是空的），不预删 —— 删除守卫会拦。
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

const pkgVersion = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')).version;

const env = {
  ...process.env,
  HATCH_DATA_DIR: DATA,
  HATCH_USER_DATA: USERDATA,
  HATCH_EVAL_FILE: PROBE,
  // ★ HATCH_EVAL_FILE 只在 HATCH_SHOOT 钩子里被执行（main.js），不设 SHOOT 探针根本不跑
  HATCH_SHOOT: path.join(ROOT, 'lo-recon', 'shot-firstrun.png'),
  HATCH_SHOOT_DELAY: '8000',
  HATCH_DEBUG: '1',              // 不开它主进程几乎不打日志，超时时两头黑
  HATCH_BACKGROUND: '1',         // 自动化不把窗口画到用户屏幕上
  HATCH_OPEN_DRYRUN: '1',        // 不许真把浏览器/资源管理器弹出来
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

console.log('[firstrun] ' + EXE);
console.log('[firstrun] 包内版本 ' + pkgVersion + '（读自 ' + path.relative(ROOT, PKG_JSON) + '）');
console.log('[firstrun] 全新数据目录 ' + DATA);
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
  console.log('包内版本：' + pkgVersion + '（' + path.relative(ROOT, PKG_JSON) + '）');
  if (ver) console.log('程序自报：' + ver);
  const evalLine = /\[eval\] (.+)/.exec(out);
  const failed = /\[eval\] failed (.+)/.exec(out);
  const unhandled = out.split('\n').filter((l) => /\[unhandled\]/.test(l));

  if (failed) {
    console.log('探针失败：' + failed[1].slice(0, 1500));
  } else if (evalLine) {
    let r = null;
    try { r = JSON.parse(evalLine[1]); } catch {}
    if (r && r.verdict) {
      const bad = Object.entries(r.verdict).filter(([, v]) => !v);
      console.log('断言 ' + (Object.keys(r.verdict).length - bad.length) + '/' + Object.keys(r.verdict).length +
        (bad.length ? '，失败：' + JSON.stringify(bad.map(([k]) => k)) : '（全绿）'));
      console.log('会话：programId=' + r.programId + ' modelSource=' + r.modelSource +
        '；项目：' + r.projectCount + ' 个 ' + JSON.stringify(r.projectNames) +
        '；技能卡 ' + r.cardCount + '/' + r.skillCount);
    } else {
      console.log(evalLine[1].slice(0, 800));
    }
  } else {
    console.log('没拿到探针结果，输出尾部：\n' + out.slice(-1500));
  }
  if (unhandled.length) console.log('渲染层未处理异常：\n' + unhandled.join('\n'));
  console.log('exe 退出码：' + code);
  process.exit(failed || !evalLine ? 1 : 0);
});
