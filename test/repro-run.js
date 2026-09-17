'use strict';
// 复现用跑分器：跟 run-ui.js 同思路，但**不删除数据目录**、也不建默认项目，
// 直接把一份已有数据快照（通常是用户真实 data 的副本）喂给应用，
// 这样能精确复现"点几下就报错"的现场。
//
// 运行： node test/repro-run.js <数据目录> <注入脚本>
//   node test/repro-run.js test/.tmp-repro/data test/repro-tabs.probe.js

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(ROOT, process.argv[2] || 'test/.tmp-repro/data');
const SCRIPT = path.resolve(ROOT, process.argv[3] || 'test/repro-tabs.probe.js');
const TMP = path.join(ROOT, 'test', '.tmp-repro');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const TIMEOUT_MS = Number(process.env.HATCH_UI_TIMEOUT || 120000);

for (const [what, p] of [['Electron', ELECTRON], ['数据目录', DATA_DIR], ['注入脚本', SCRIPT]]) {
  if (!fs.existsSync(p)) {
    console.error(`找不到${what}：${p}`);
    process.exit(1);
  }
}
fs.mkdirSync(TMP, { recursive: true });

const env = {
  ...process.env,
  HATCH_DEBUG: '1',
  // 复现也不能弹窗打扰人
  HATCH_BACKGROUND: '1',
  HATCH_DATA_DIR: DATA_DIR,
  HATCH_EVAL_FILE: SCRIPT,
  HATCH_SHOOT: path.join(TMP, 'repro.png'), // 必须设，主进程才会去执行注入脚本
  HATCH_SHOOT_DELAY: '2200',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

// --user-data-dir 单独指一份：用户手上可能正开着同一个应用（同一份 Electron userData），
// 两个实例抢 Chromium 缓存目录会起不来。数据目录（HATCH_DATA_DIR）本来就已经隔离了。
const USER_DATA = path.join(TMP, 'userdata');
fs.rmSync(USER_DATA, { recursive: true, force: true });
const child = spawn(ELECTRON, ['.', '--user-data-dir=' + USER_DATA], {
  cwd: ROOT,
  windowsHide: false,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

function killTree(pid) {
  return new Promise((resolve) => {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    k.on('close', resolve);
    k.on('error', resolve);
  });
}

const timer = setTimeout(async () => {
  console.log('超时，输出尾部：\n' + out.slice(-2000));
  await killTree(child.pid);
  process.exit(1);
}, TIMEOUT_MS);

child.on('exit', async () => {
  clearTimeout(timer);
  await killTree(child.pid);
  fs.writeFileSync(path.join(TMP, 'repro.log'), out);
  // 数据目录被复现脚本改过，留一份写回结果方便对照
  const log = out.split('\n').filter((l) => /^\[(eval|unhandled|renderer|win)\]/.test(l));
  console.log(log.join('\n'));
  console.log('--- 完整输出见 ' + path.join(TMP, 'repro.log'));
  process.exit(0);
});
