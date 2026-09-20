'use strict';
// 在**打包树**里验证 0.1.10 的新东西：出厂默认端点来自包内的 config/model.json。
//
// 为什么必须打真产物：配置文件是**靠打包清单 `files` 带进去的**（不是运行时生成的）。
// 开发态跑得再绿也证明不了它在包里 —— 开发态读的是 repo 根目录那份 config/model.json，
// 包里那份要是没进去，用户打开就是"谁都连不上"。
//
// 断言三条，且互为对照（防止"空对空"恒真）：
//   ① 全新装好（空数据目录）→ 生效端点 == 包内 config/model.json 里写的
//   ② 用户在设置里填了自己的 → 用他的（包内默认不许盖掉用户）
//   ③ 用户清空 → 回落包内默认
//
// 跑法：node lo-recon/run-packaged-model.cjs
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
const PKG_CFG = path.join(PKG_DIR, 'resources', 'app', 'config', 'model.json');

for (const [name, p] of [['exe', EXE], ['包内 package.json', PKG_JSON], ['★ 包内 config/model.json', PKG_CFG]]) {
  if (!fs.existsSync(p)) { console.error('找不到' + name + '：' + p); process.exit(1); }
}
const pkgVersion = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')).version;
const expect = JSON.parse(fs.readFileSync(PKG_CFG, 'utf8'));

// 每次跑用一个全新的数据目录（"全新装好"必须真的没有历史），用时间戳保证是空的 —— 不做删除动作
const stamp = Date.now();
const DATA = path.join(ROOT, 'test', '.tmp-pkg-model-data-' + stamp);
const USERDATA = path.join(ROOT, 'test', '.tmp-pkg-model-userdata-' + stamp);
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

const PROBE = path.join(os.tmpdir(), 'hatch-pkg-model-probe-' + stamp + '.js');
fs.writeFileSync(PROBE, `(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const EXP = ${JSON.stringify({ baseUrl: expect.baseUrl, model: expect.model })};
  for (let i = 0; i < 120 && !(window.hatch && window.hatch.settings); i++) await wait(200);
  const model = async () => (await window.hatch.settings.get()).model;
  const m0 = await model();
  out.fresh = { baseUrl: m0.baseUrl, model: m0.model };
  await window.hatch.settings.save({ model: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'probe-key', model: 'probe-custom-model' } });
  const m1 = await model();
  out.afterCustom = { baseUrl: m1.baseUrl, model: m1.model };
  await window.hatch.settings.save({ model: { baseUrl: '', apiKey: '', model: '' } });
  const m2 = await model();
  out.afterClear = { baseUrl: m2.baseUrl, model: m2.model };
  out.verdict = {
    '全新装好：端点来自包内 config/model.json': out.fresh.baseUrl === EXP.baseUrl && out.fresh.model === EXP.model,
    '反面对照：用户自己填的能顶掉默认': out.afterCustom.model === 'probe-custom-model' && out.afterCustom.baseUrl === 'http://127.0.0.1:9/v1',
    '清空后回落包内默认': out.afterClear.model === EXP.model && out.afterClear.baseUrl === EXP.baseUrl,
    '包内默认不是空的（不然前三条是空对空）': !!EXP.model && !!EXP.baseUrl,
  };
  if (!Object.values(out.verdict).every(Boolean)) throw new Error('断言失败 ' + JSON.stringify(out));
  return out;
})();`, 'utf8');

const env = {
  ...process.env,
  HATCH_DATA_DIR: DATA,
  HATCH_USER_DATA: USERDATA,
  HATCH_EVAL_FILE: PROBE,
  HATCH_OPEN_DRYRUN: '1',
  // ★ HATCH_SHOOT 是 main.js 里"注入探针 + 抓图 + 跑完退出"这整段的门控：
  //   不设它，HATCH_EVAL_FILE 根本不会被读 —— 表现是"进程活着、输出全空、最后超时"。
  //   这里只想跑断言不想留图，所以给个路径让门开、但不设 HATCH_SHOT_VISIBLE，
  //   后台模式下截图那步会自己跳过（不弹窗口）。
  HATCH_SHOOT: path.join(USERDATA, 'unused-shot.png'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

console.log('[pkg-model] ' + EXE);
console.log('[pkg-model] 包内版本 ' + pkgVersion);
console.log('[pkg-model] 包内 config/model.json → ' + JSON.stringify({ baseUrl: expect.baseUrl, model: expect.model }));
console.log('[pkg-model] 全新数据目录 ' + DATA);

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
  try { fs.unlinkSync(PROBE); } catch {}

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
      console.log(evalLine[1].slice(0, 800));
    }
  } else {
    console.log('没拿到探针结果，输出尾部：\n' + out.slice(-1500));
  }
  if (unhandled.length) console.log('渲染层未处理异常：\n' + unhandled.join('\n'));
  console.log('exe 退出码：' + code);
  process.exit(failed || !evalLine ? 1 : 0);
});
