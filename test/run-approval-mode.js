'use strict';
// 「运行中切换审批模式」专项跑分器。运行： node test/run-approval-mode.js
//
// 为什么不能复用 run-ui.js：那条 bug 只在"用户改模式"发生在"下一次工具调用过闸门"之前
// 的时间窗里才暴露，窗口大小由**模型什么时候回下一个工具调用**决定 —— 真模型和演示服务
// 都不受我们控制。所以这里自带一个桩端点：每次响应前固定等 HATCH_APPROVAL_DELAY 毫秒
// （默认 2500），每次都回一个 shell_command 工具调用，把时间窗稳稳撑开。
// 端点地址写进数据目录的 settings.json（渲染层脚本读不到环境变量，走文件最省事）。
//
// 桩模型只回工具调用、永远不给终局回答，所以脚本最后会自己按停止。

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp-approval-mode');
const DATA_DIR = path.join(TMP, 'data');
const SCRIPT = path.resolve(ROOT, 'test', 'approval-mode-live.js');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MODEL = 'stub-approval-model';
const DELAY = Number(process.env.HATCH_APPROVAL_DELAY || 2500);
const TIMEOUT_MS = Number(process.env.HATCH_APPROVAL_TIMEOUT || 240000);

if (!fs.existsSync(ELECTRON)) { console.error('找不到 Electron：' + ELECTRON); process.exit(1); }
if (!fs.existsSync(SCRIPT)) { console.error('找不到测试脚本：' + SCRIPT); process.exit(1); }

let stubResponses = 0;

// 桩端点：/v1/models 回一个模型；/v1/chat/completions 每次都回一个 shell_command 工具调用。
// 每次响应前等 DELAY 毫秒 —— 那就是"用户改模式"能插进去的时间窗。
function startStub() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => {
        let n = 0;
        const server = http.createServer((req, res) => {
          if (req.url.startsWith('/v1/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'stub' }] }));
            return;
          }
          if (!req.url.startsWith('/v1/chat/completions')) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'not found' } }));
            return;
          }
          let body = '';
          req.on('data', (d) => { body += d; });
          req.on('end', () => {
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (_) {}
            const receipts = (payload.messages || []).filter((m) => m.role === 'tool').length;
            n += 1;
            stubResponses += 1;
            setTimeout(() => {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
              const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
              const chunk = (delta, finish) => ({
                id: 'chatcmpl-stub', object: 'chat.completion.chunk', model: payload.model || MODEL,
                choices: [{ index: 0, delta, finish_reason: finish || null }],
              });
              send(chunk({ role: 'assistant' }));
              send(chunk({
                tool_calls: [{
                  index: 0, id: 'call_' + Math.random().toString(36).slice(2, 8), type: 'function',
                  function: { name: 'shell_command', arguments: '' },
                }],
              }));
              const raw = JSON.stringify({ command: 'echo HATCH_APPROVAL_MODE_PROBE' });
              for (const part of raw.match(/.{1,18}/gs) || []) {
                send(chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
              }
              send(chunk({}, 'tool_calls'));
              res.write('data: [DONE]\n\n');
              res.end();
              console.log('[stub] 第 ' + n + ' 次响应（本轮已回执 ' + receipts + ' 条）→ shell_command');
            }, DELAY);
          });
        });
        server.listen(port, '127.0.0.1', () => resolve({ server, port }));
      });
    });
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('close', resolve);
      k.on('error', resolve);
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
      resolve();
    }
  });
}

(async () => {
  const { server, port } = await startStub();
  console.log('[run-approval-mode] 桩端点 http://127.0.0.1:' + port + '/v1（每次响应前等 ' + DELAY + 'ms）');

  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({
    model: { baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', model: MODEL },
    approval: { mode: 'auto' },              // 全局先设自动；本测试要验的是**会话级**覆盖
  }, null, 2));

  const env = {
    ...process.env,
    HATCH_DEBUG: '1',
    HATCH_BACKGROUND: '1',                   // 不给用户画窗口、不抢焦点
    HATCH_DATA_DIR: DATA_DIR,
    HATCH_PICK_FOLDER: path.join(TMP, 'probe-proj'),
    // HATCH_EVAL_FILE 是挂在截图钩子下面的（见 main.js 的 `if (process.env.HATCH_SHOOT)`），
    // 不设 HATCH_SHOOT 脚本根本不会跑 —— 实测漏了它就一直挂到超时、什么输出都没有。
    HATCH_SHOOT: path.join(TMP, 'shot.png'),
    HATCH_SHOOT_DELAY: '2500',
    HATCH_EVAL_FILE: SCRIPT,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const child = spawn(ELECTRON, ['.'], { cwd: ROOT, windowsHide: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });

  const finish = async (code) => {
    server.close();
    const all = out + err;
    try { fs.writeFileSync(path.join(TMP, 'electron.log'), all); } catch (_) {}
    const evalLine = /\[eval\] (.+)/.exec(all);
    const failed = /\[eval\] failed (.+)/.exec(all);
    console.log('--- 运行中切换审批模式：test/approval-mode-live.js ---');
    if (failed) console.log('测试失败：' + failed[1]);
    if (evalLine) { try { console.log(evalLine[1]); } catch (_) { console.log(evalLine[1]); } }
    if (!failed && !evalLine) console.log('没有拿到断言结果，输出尾部：\n' + all.slice(-2000));
    const stubLines = all.split('\n').filter((l) => /\[stub\] /.test(l));
    console.log('桩端点响应次数：' + stubResponses + (stubLines.length ? '（最后一次：' + stubLines[stubLines.length - 1].trim() + '）' : ''));
    console.log('electron 退出码：' + code);
    process.exit(failed || !evalLine ? 1 : 0);
  };

  const timer = setTimeout(async () => {
    console.log('超时，输出尾部：\n' + (out + err).slice(-2000));
    await killTree(child.pid);
    server.close();
    process.exit(1);
  }, TIMEOUT_MS);

  child.on('exit', async (code) => {
    clearTimeout(timer);
    await killTree(child.pid);
    await finish(code);
  });
})();
