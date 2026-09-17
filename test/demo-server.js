'use strict';
// 演示用假模型服务：在 1234 端口上假装成一个支持工具调用的 OpenAI 兼容端点。
// 用途：本机没有 GGUF 模型时，把界面喂活，完整跑「思考 → 工具 → 再思考 → 总结」。
// 运行： node test/demo-server.js [port]

const http = require('http');

const PORT = Number(process.argv[2] || 1234);
const MODELS = ['qwen3-4b-instruct', 'local-coder-7b'];

// 每个会话的脚本：按已出现的工具回执条数决定下一步
function nextStep(payload) {
  const toolMsgs = (payload.messages || []).filter((m) => m.role === 'tool');
  const available = new Set(
    (payload.tools || []).map((t) => (t.function && t.function.name) || t.name || '')
  );
  const n = toolMsgs.length;

  if (n === 0) {
    return {
      reasoning: '用户要一份说明文件。先看看工作目录里有什么，再决定写到哪儿。',
      toolCall: {
        name: available.has('list_dir') ? 'list_dir' : 'read_file',
        args: available.has('list_dir') ? { relativePath: '.' } : { relativePath: 'README.md' },
      },
    };
  }
  if (n === 1) {
    return {
      reasoning: '目录是空的。那就按用户说的，新建一个 notes 目录并把说明写进去。',
      toolCall: {
        name: 'create_folder',
        args: { relativePath: 'notes' },
      },
    };
  }
  if (n === 2) {
    return {
      reasoning: '目录建好了。现在写文件——内容要短，用 markdown。',
      toolCall: {
        name: 'write_file',
        args: {
          relativePath: 'notes/hello.md',
          content: '# One Harness 自检\n\n这个文件是模型通过 write_file 工具写出来的。\n\n- 事件链已落盘\n- 检查点已记录 sha256\n- 回滚可用「回滚到这条调用之前」\n',
        },
      },
    };
  }
  if (n === 3) {
    return {
      reasoning: '写完了，回读一遍确认内容没串行。',
      toolCall: {
        name: 'read_file_lines',
        args: { relativePath: 'notes/hello.md', startLine: 1, endLine: 20 },
      },
    };
  }
  return {
    text:
      '已经建好 `notes/hello.md` 并回读校验过了，内容一致。\n\n' +
      '**这一轮实际发生了什么**\n\n' +
      '| 步骤 | 动作 | 落盘位置 |\n|---|---|---|\n' +
      '| 1 | 列出工作目录 | 只读 |\n' +
      '| 2 | 新建 `notes/` | 目录 |\n' +
      '| 3 | 写入 `notes/hello.md` | `blobs/<sha256>` + 检查点 |\n' +
      '| 4 | 回读校验 | 只读 |\n\n' +
      '> 每一步都进了事件链，右侧「回滚」可以退到任意一条工具调用之前。',
  };
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'demo' })) }));
    return;
  }

  if (req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (_) {}
      const step = nextStep(payload);
      const model = payload.model || MODELS[0];

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const chunk = (delta, finish) => ({
        id: 'chatcmpl-demo', object: 'chat.completion.chunk', model,
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      });

      if (step.toolCall) {
        send(chunk({ role: 'assistant' }));
        if (step.reasoning) {
          // 分片吐思考过程，验证渲染层的增量拼接
          for (const part of step.reasoning.match(/.{1,12}/gs) || []) send(chunk({ reasoning_content: part }));
        }
        send(chunk({
          tool_calls: [{
            index: 0,
            id: 'call_' + Math.random().toString(36).slice(2, 10),
            type: 'function',
            function: { name: step.toolCall.name, arguments: '' },
          }],
        }));
        // 参数也分片，模拟真实模型的增量 JSON
        const raw = JSON.stringify(step.toolCall.args);
        for (const part of raw.match(/.{1,18}/gs) || []) {
          send(chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
        }
        send(chunk({}, 'tool_calls'));
      } else {
        send(chunk({ role: 'assistant' }));
        for (const part of step.text.match(/[\s\S]{1,20}/g) || []) send(chunk({ content: part }));
        send(chunk({}, 'stop'));
        const pt = Math.ceil(JSON.stringify(payload.messages || []).length / 3.6);
        send({
          id: 'chatcmpl-demo', object: 'chat.completion.chunk', model,
          choices: [],
          usage: { prompt_tokens: pt, completion_tokens: 128, total_tokens: pt + 128 },
        });
      }

      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`[demo] ${step.toolCall ? 'tool=' + step.toolCall.name : 'final answer'} (已回执 ${(payload.messages || []).filter((m) => m.role === 'tool').length} 条)`);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[demo] 假模型端点已就绪 http://127.0.0.1:' + PORT + '/v1');
  console.log('[demo] 模型：' + MODELS.join(', '));
});
