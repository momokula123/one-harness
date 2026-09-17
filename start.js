'use strict';
// 启动器：清掉可能让 Electron 退化成纯 Node 的环境变量后再拉起应用。
// （有些环境会预设 ELECTRON_RUN_AS_NODE=1 / NODE_OPTIONS，直接跑 electron . 会报 app 未定义）

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const electronPkg = require('electron');
const exe = typeof electronPkg === 'string' ? electronPkg : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(exe)) {
  console.error('找不到 Electron 可执行文件：' + exe + '\n先执行： npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(exe, [ROOT, ...process.argv.slice(2)], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
