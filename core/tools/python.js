'use strict';
// Python 执行：把代码写进会话的 scratch 目录再解释执行（不内嵌 Pyodide，用本机解释器）

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('../store');

const CANDIDATES = [
  '', // 占位：先试设置里的可执行文件
  'python',
  'python3',
  'py',
  'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe',
  'C:/Program Files/python/python.exe',
];

let cachedPython = null;

function tryVersion(exe) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, ['--version'], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

async function resolvePython(configured) {
  const list = [configured, ...CANDIDATES].filter((x) => x !== undefined && x !== null);
  for (const exe of list) {
    if (exe === '') continue;
    if (exe.includes('/') || exe.includes('\\')) {
      if (!fs.existsSync(exe)) continue;
    }
    const v = await tryVersion(exe);
    if (v) return { exe, version: v };
  }
  return null;
}

const runPython = {
  alias: 'run_python',
  module: 'python',
  risk: 'medium',
  writes: true,
  description:
    'Execute a Python script with the local Python interpreter and return stdout/stderr. Use it for data crunching, file transforms and calculations instead of long shell one-liners. The script runs in a scratch folder inside the session directory.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python source code to run' },
      cwd: { type: 'string', description: 'Optional subdirectory of the working directory to run in' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds. Default 120000.' },
    },
    required: ['code'],
  },
  classify() {
    return { risk: 'medium', reason: '执行本地 Python 代码' };
  },
  async run(args, ctx) {
    if (!args || !args.code) return { text: '缺少 code 参数。', isError: true };
    const py = await resolvePython(ctx.settings.python.executable);
    if (!py) {
      return { text: '没有找到可用的 Python 解释器。请在设置里填写 python 可执行文件的完整路径。', isError: true };
    }
    if (!cachedPython) cachedPython = py;
    const scratch = store.ensureDir(path.join(store.projectDataDir(ctx.session.projectId), 'sessions', 'scratch'));
    const file = path.join(scratch, `run_${Date.now()}.py`);
    fs.writeFileSync(file, args.code, 'utf8');
    const root = ctx.workingDir;
    let cwd = root;
    if (args.cwd) {
      cwd = path.resolve(root, args.cwd);
      const rel = path.relative(root, cwd);
      if (rel.startsWith('..')) return { text: 'cwd 越界：只能在工作目录内运行。', isError: true };
    }
    const started = Date.now();
    const timeoutMs = Math.min(args.timeoutMs || 120000, 600000);
    const r = await new Promise((resolve) => {
      const child = spawn(py.exe, ['-u', file], { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ code: null, stdout, stderr, timedOut: true }); }, timeoutMs);
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (e) => finish({ code: -1, stdout: '', stderr: e.message, timedOut: false }));
      child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
    });
    const clip = (s) => (s.length > 20000 ? s.slice(0, 20000) + `\n…[截断，共 ${s.length} 字符]` : s);
    const parts = [`# ${py.exe} (${py.version})`, `# 脚本：${path.relative(root, file).split(path.sep).join('/')}`];
    if (r.stdout) parts.push('--- stdout ---\n' + clip(r.stdout));
    if (r.stderr) parts.push('--- stderr ---\n' + clip(r.stderr));
    parts.push(`--- exit code: ${r.code ?? 'null'}${r.timedOut ? '（超时已终止）' : ''}，耗时 ${Date.now() - started} ms ---`);
    return { text: parts.join('\n'), isError: r.code !== 0 };
  },
};

module.exports = { tools: [runPython], resolvePython };
