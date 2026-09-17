'use strict';
// 启动自检：真的拉起 Electron，等渲染层打出 READY，然后干净地把进程树杀掉。
// 运行： node test/launch-check.js
// 用独立的 HATCH_DATA_DIR，不碰正式数据。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP_DATA = path.join(ROOT, 'test', '.tmp-launch', 'data');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const TIMEOUT_MS = 40000;

if (!fs.existsSync(ELECTRON)) {
  console.error('找不到 Electron：' + ELECTRON);
  process.exit(1);
}

// 窗口不抢焦点（用户可能正在同一台机器上干别的），但必须真的"显示"出来，
// 否则 isVisible() 断言就失去意义了 —— showInactive() 同样会把 isVisible 刷成 true。
const env = { ...process.env, HATCH_DEBUG: '1', HATCH_BACKGROUND: '1', HATCH_DATA_DIR: TMP_DATA };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(ELECTRON, ['.'], {
  cwd: ROOT,
  // 不能设 windowsHide:true —— 那会把 Electron 的主窗口按 SW_HIDE 起，
  // 于是 win.show() 也刷不出可见状态，自检就查不出"窗口没显示"这类问题。
  windowsHide: false,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let ready = false;
let rendererErrors = [];
child.stdout.on('data', (d) => {
  const s = d.toString();
  out += s;
  if (s.includes('HATCH_RENDERER_READY')) ready = true;
});
child.stderr.on('data', (d) => {
  const s = d.toString();
  out += s;
  rendererErrors.push(s.trim());
});

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('close', () => resolve());
      k.on('error', () => resolve());
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      resolve();
    }
  });
}

const timer = setTimeout(async () => {
  console.log('超时未收到 READY，输出如下：\n' + out.slice(-4000));
  await killTree(child.pid);
  process.exit(1);
}, TIMEOUT_MS);

child.on('exit', async (code) => {
  clearTimeout(timer);
  console.log('electron 退出码：' + code);
  console.log('--- 输出 ---\n' + out.slice(-4000));
  await killTree(child.pid);
  process.exit(ready ? 0 : 1);
});

// 每 500ms 检查一次是否 READY，就绪后等 1.5s 收尾日志再杀
const poll = setInterval(async () => {
  if (!ready) return;
  clearInterval(poll);
  clearTimeout(timer);
  setTimeout(async () => {
    console.log('检测到渲染层就绪。');
    console.log('--- 输出 ---\n' + out.slice(-4000));
    await killTree(child.pid);
    const bad = rendererErrors.filter((l) => /error|Error|uncaught|Failed/.test(l) && !/DevTools|GPU|gpu/.test(l));
    if (bad.length) {
      console.log('渲染层疑似报错：\n' + bad.join('\n'));
      process.exit(1);
    }
    // 无边框窗口用 show:false 建，必须自己 show()。漏了就是"进程活着但看不见窗口"。
    // 自动化模式故意不显示窗口（不许弹到用户屏幕上），所以这里断言的是
    // "ready-to-show 这条路径确实执行了、并且明确地选择了隐藏"；
    // 要严格验证可见性就设 HATCH_SHOT_VISIBLE=1 跑（会真的显示窗口）。
    const visibleRun = !!process.env.HATCH_SHOT_VISIBLE;
    const ok = visibleRun
      ? /\[win\] shown visible=true/.test(out)
      : /\[win\] background-hidden visible=false/.test(out); // 自动化：必须确认屏幕上什么都没画
    if (!ok) {
      console.log('窗口状态不符合预期（自动化模式应出现 [win] background-hidden visible=false）');
      process.exit(1);
    }
    console.log(
      visibleRun
        ? '启动自检通过：主进程 + preload + 渲染层都正常，窗口已显示。'
        : '启动自检通过：主进程 + preload + 渲染层都正常（自动化模式，未显示窗口）。'
    );
    process.exit(0);
  }, 1500);
}, 500);
