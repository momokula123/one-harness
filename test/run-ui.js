'use strict';
// UI 测试跑分器：真起 Electron，把一段脚本注入渲染层点击/断言，按结果给退出码。
// 运行： node test/run-ui.js [脚本路径]      默认 test/ui-click.js
//
// 为什么需要它：内核冒烟（test/smoke.js）测不到"按钮点了没反应"这类问题，
// 而渲染层 async 事件处理器里的异常不会打 error 日志、也没有任何界面反馈，
// 只有真的点一遍并收集 unhandledrejection 才看得见。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.resolve(ROOT, process.argv[2] || 'test/ui-click.js');
const TMP = path.join(ROOT, 'test', '.tmp-ui');
let DATA_DIR = process.env.HATCH_UI_DATA_DIR ? path.resolve(ROOT, process.env.HATCH_UI_DATA_DIR) : path.join(TMP, 'data');
const PICK_DIR = path.join(TMP, 'probe-proj');
const SHOT = path.join(TMP, 'shot.png');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const TIMEOUT_MS = Number(process.env.HATCH_UI_TIMEOUT || 480000); // 全功能巡检会上真模型，给足 5 分钟

if (!fs.existsSync(ELECTRON)) {
  console.error('找不到 Electron：' + ELECTRON);
  process.exit(1);
}
if (!fs.existsSync(SCRIPT)) {
  console.error('找不到测试脚本：' + SCRIPT);
  process.exit(1);
}

// 每次跑都从干净的数据目录开始，否则"新建了一个项目"这种计数断言会随历史累积失真。
// 删不掉就换一个全新的目录（有些环境对批量删除有保护），效果一样。
//
// HATCH_UI_KEEP_DATA=1 时不清理：有些探针要验的是**盘上已有数据**的情形，而且那种状态
// 往往无法用 API 造出来（例："工程目录里有会话正文、但 projects.json 里没有这一行"
// —— 走 API 建会话必然同时写索引，造不出这个不一致状态）。这类探针自己准备目录，
// 用这个开关请跑分器别清。默认仍然是清，别改默认值。
if (process.env.HATCH_UI_KEEP_DATA) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('[run-ui] HATCH_UI_KEEP_DATA=1 → 保留既有数据目录：' + DATA_DIR);
} else {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (e) {
    DATA_DIR = path.join(TMP, 'data-' + Date.now());
    console.log('[run-ui] 旧数据目录删不掉（' + e.message.split('\n')[0] + '），改用 ' + path.basename(DATA_DIR));
  }
}
fs.mkdirSync(PICK_DIR, { recursive: true });
// 内置浏览器那条断言要真加载一个本机页面（证明 guest 真的渲染了，而不是只有一个空元素），
// 页面就写在这里；features.js 从应用自身 URL 反推出它的地址。
try {
  fs.writeFileSync(path.join(TMP, 'bw-probe.html'),
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>BW 探针页</title></head>' +
    '<body><h1>内置浏览器加载成功</h1><p>hello from local file</p></body></html>');
} catch (e) { console.log('[run-ui] 写探针页失败：' + e.message); }

const env = {
  ...process.env,
  HATCH_DEBUG: '1',
  // 窗口不抢焦点、有副屏就扔副屏：用户可能正在用主屏干别的
  HATCH_BACKGROUND: '1',
  HATCH_DATA_DIR: DATA_DIR,
  // 系统文件夹对话框是原生的、没法自动化，桩掉它；这条链路的其余部分是真的
  HATCH_PICK_FOLDER: PICK_DIR,
  HATCH_EVAL_FILE: SCRIPT,
  HATCH_SHOOT: SHOT,
  HATCH_SHOOT_DELAY: '3000',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(ELECTRON, ['.'], {
  cwd: ROOT,
  windowsHide: false, // 见 launch-check.js：设 true 会影响窗口可见性判断
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
  // 主进程/渲染层的完整输出留着，失败时好看现场
  const rawPath = path.join(TMP, 'electron.log');
  try { fs.writeFileSync(rawPath, all); } catch {}
  const evalLine = /\[eval\] (.+)/.exec(all);
  const failed = /\[eval\] failed (.+)/.exec(all);
  const unhandled = all.split('\n').filter((l) => /\[unhandled\]/.test(l));
  const winLine = all.split('\n').filter((l) => /^\[win\] /.test(l));
  if (winLine.length) console.log('窗口状态：' + winLine.join(' | '));

  console.log('--- 渲染层注入脚本：' + path.relative(ROOT, SCRIPT) + ' ---');
  if (failed) {
    console.log('测试失败：' + failed[1]);
    if (evalLine) {
      try { console.log(JSON.stringify(JSON.parse(evalLine[1]), null, 2)); } catch {}
    }
    console.log('--- 进程输出尾部（完整见 ' + rawPath + '） ---\n' + all.slice(-1500));
  } else if (evalLine) {
    try {
      console.log(JSON.stringify(JSON.parse(evalLine[1]), null, 2));
    } catch {
      console.log(evalLine[1]);
    }
  } else {
    console.log('没有拿到断言结果，输出尾部：\n' + all.slice(-2000));
  }
  if (unhandled.length) console.log('渲染层未处理异常：\n' + unhandled.join('\n'));
  if (fs.existsSync(SHOT)) console.log('截图：' + SHOT);
  console.log('electron 退出码：' + code);
  process.exit(failed || !evalLine ? 1 : 0);
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
