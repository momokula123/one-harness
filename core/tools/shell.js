'use strict';
// 终端工具：风险分级 + 硬拒绝清单。真正的"该不该跑"交给审批子会话判断。

const { spawn } = require('child_process');
const path = require('path');

const MAX_OUTPUT = 30000;

const TOO_DESTRUCTIVE = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME)(\s|$)/i, why: '递归删除根目录或家目录' },
  { re: /\brm\s+-rf\s+\/?(c:|\/)\s*$/i, why: '递归删除盘根目录' },
  // 审计 P1：老清单是 Unix 中心的，反斜杠盘符路径一个都不命中。补 Windows 分支。
  // 注意只硬拒"盘根 / 用户目录根"这一层 —— 项目本身就在 C:\Users\<名>\ 下，
  // 连项目里的文件一起拦的话，正常删除全废。深层路径仍走分级 + 评审。
  { re: /\brm\s+(-\w+\s+)*-\w*[rf]\w*\s+["']?[a-zA-Z]:[\\/]?["']?\s*$/i, why: '递归删除盘根目录' },
  { re: /\brm\s+(-\w+\s+)*-\w*[rf]\w*\s+["']?[a-zA-Z]:[\\/]Users([\\/][^\\/"']*)?[\\/]?["']?\s*$/i, why: '递归删除用户目录' },
  { re: /\b(format|diskpart|mkfs(\.\w+)?)\b/i, why: '格式化/分区操作' },
  { re: /\bdd\s+if=.*of=\/dev\/(sd|nvme|hd)/i, why: '直接写裸设备' },
  { re: /\b(Remove-Item|del|rmdir)\s+.*(C:\\\\?Windows|C:\\\\?Program Files|C:\\\\?Users\\\\?[^\\]*\\)\s*$/i, why: '删除系统目录' },
  { re: /\b(Remove-Item|del|rd|rmdir)\b[^|;&]*["']?[a-zA-Z]:[\\/]Users([\\/][^\\/"']*)?[\\/]?["']?\s*$/i, why: '删除用户目录' },
  { re: /\b(shutdown|Restart-Computer|Stop-Computer)\b.*\/(f|s|r)\b/i, why: '关机/重启' },
  { re: /\b(vssadmin|bcdedit|cipher\s+\/w)\b/i, why: '系统级破坏性操作' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh\b/i, why: '管道执行远程脚本' },
];

const HIGH_RISK = [
  { re: /\brm\s+(-\w+\s+)*-\w*r\w*(\s|$)/i, why: '递归删除' },
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: '递归强制删除' },
  { re: /\bgit\s+push\b.*--force|\bgit\s+push\s+-f\b/i, why: '强制推送覆盖远端历史' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fd]|checkout\s+--\s)/i, why: '丢弃本地改动' },
  { re: /\b(Remove-Item|rd|rmdir)\b[^|]*(-Recurse|-r)\b/i, why: '递归删除' },
  { re: /\b(sudo|runas|Start-Process\s+-Verb\s+RunAs)\b/i, why: '提权执行' },
  { re: /\b(chmod\s+777|chown\s+-R|takeown|icacls)\b/i, why: '权限/所有权变更' },
  { re: /\b(reg\s+(add|delete)|Set-ItemProperty\s+.*HK(LM|CU))/i, why: '修改注册表' },
  { re: />\s*(\/etc\/|C:\\\\(Windows|Program Files))/i, why: '覆盖系统文件' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b/i, why: '发布到公共仓库' },
];

const MEDIUM_RISK = [
  { re: /\b(npm|pnpm|yarn|pip|pip3|uv)\s+(install|add|uninstall|remove)\b/i, why: '安装/卸载依赖' },
  { re: /\bgit\s+(commit|merge|rebase|cherry-pick|tag)\b/i, why: '改写版本历史' },
  { re: /\b(mv|move|ren|rename)\b/i, why: '移动/重命名文件' },
  { re: /\b(cp|copy|xcopy|robocopy)\b/i, why: '复制文件' },
  { re: /(^|[^<>])>\s*[^>]/i, why: '重定向写入文件' },
  { re: /\b(Set-Content|Add-Content|Out-File|New-Item)\b/i, why: '写入文件' },
  { re: /\b(curl|Invoke-WebRequest|iwr|wget)\b/i, why: '网络请求' },
  { re: /\b(taskkill|Stop-Process|kill)\b/i, why: '结束进程' },
];

function classifyCommand(command) {
  const cmd = String(command || '');
  for (const p of TOO_DESTRUCTIVE) if (p.re.test(cmd)) return { risk: 'too_destructive', reason: p.why };
  for (const p of HIGH_RISK) if (p.re.test(cmd)) return { risk: 'high', reason: p.why };
  for (const p of MEDIUM_RISK) if (p.re.test(cmd)) return { risk: 'medium', reason: p.why };
  return { risk: 'low', reason: '' };
}

function clipOut(label, s) {
  const str = String(s ?? '');
  if (!str) return '';
  if (str.length <= MAX_OUTPUT) return str;
  return str.slice(0, MAX_OUTPUT) + `\n…[${label} 被截断，共 ${str.length} 字符]`;
}

function runCommand({ command, cwd, shellPath, timeoutMs }) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command];
    const child = spawn(shellPath || (isWin ? 'powershell.exe' : '/bin/bash'), args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, HATCH_SESSION: '1' },
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ exitCode: null, stdout: clipOut('stdout', stdout), stderr: clipOut('stderr', stderr), timedOut: true, durationMs: Date.now() - started });
    }, Math.min(timeoutMs || 120000, 600000));
    const started = Date.now();
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finish({ exitCode: -1, stdout: '', stderr: '启动失败：' + e.message, timedOut: false, durationMs: Date.now() - started }));
    child.on('close', (code) => finish({ exitCode: code, stdout: clipOut('stdout', stdout), stderr: clipOut('stderr', stderr), timedOut: false, durationMs: Date.now() - started }));
  });
}

const shellCommand = {
  alias: 'shell_command',
  module: 'shell',
  risk: 'varies',
  writes: true,
  description:
    'Run a terminal command in the working directory and return its stdout/stderr/exit code. Prefer read-only inspection commands. Dangerous commands may be blocked or require approval.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      cwd: { type: 'string', description: 'Optional subdirectory of the working directory to run in' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds. Default 120000.' },
    },
    required: ['command'],
  },
  classify(args) {
    return classifyCommand(args && args.command);
  },
  async run(args, ctx) {
    if (!args || !args.command) return { text: '缺少 command 参数。', isError: true };
    const root = ctx.workingDir;
    let cwd = root;
    if (args.cwd) {
      cwd = path.resolve(root, args.cwd);
      const rel = path.relative(root, cwd);
      if (rel.startsWith('..')) return { text: 'cwd 越界：只能在工作目录内执行命令。', isError: true };
    }
    const cls = classifyCommand(args.command);
    if (cls.risk === 'too_destructive' && !ctx.approvedByUser) {
      return {
        text: `命令被拒绝执行：检测到极高破坏性操作（${cls.reason}）。如果确实需要，请让用户手动在终端执行。`,
        isError: true,
      };
    }
    const r = await runCommand({
      command: args.command,
      cwd,
      shellPath: ctx.settings.shell.shellPath,
      timeoutMs: args.timeoutMs || ctx.settings.shell.timeoutMs,
    });
    const parts = [];
    parts.push(`$ ${args.command}`);
    if (r.stdout) parts.push('--- stdout ---\n' + r.stdout);
    if (r.stderr) parts.push('--- stderr ---\n' + r.stderr);
    parts.push(`--- exit code: ${r.exitCode ?? 'null'}${r.timedOut ? '（超时已终止）' : ''}，耗时 ${r.durationMs} ms ---`);
    return { text: parts.join('\n'), isError: r.exitCode !== 0 && r.exitCode !== null };
  },
};

module.exports = { tools: [shellCommand], classifyCommand, runCommand, TOO_DESTRUCTIVE, HIGH_RISK, MEDIUM_RISK };
