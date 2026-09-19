'use strict';
// 模型客户端：OpenAI 兼容（LM Studio / llama-server / 任何兼容端点），SSE 流式 + 工具调用增量解析

function joinUrl(base, suffix) {
  return normalizeBase(base) + suffix;
}

/**
 * 把用户可能填进来的 BaseURL 归一化成"根"。
 * OpenAI 兼容客户端的 BaseURL 只该填到 /v1，路径（/chat/completions、/models）由客户端自己拼；
 * 但 PCswitch 之类的面板给出的文档常写全路径（…/v1/chat/completions），照抄就会拼成
 * …/v1/chat/completions/chat/completions。这里统一剥掉尾部多出来的那截。
 * 生图那条也一样：文档给的是 …/v1/images/generations，照抄进 image.json 也得能跑。
 */
function normalizeBase(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '');
  b = b.replace(/\/models$/i, '').replace(/\/responses$/i, '');
  b = b.replace(/\/images\/generations$/i, '').replace(/\/images$/i, '');
  return b.replace(/\/+$/, '');
}

async function httpJson(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 30000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
  const onAbort = () => ac.abort(signal && signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function listModels(cfg) {
  const data = await httpJson(joinUrl(cfg.baseUrl, '/models'), {
    headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {},
    timeoutMs: 8000,
  });
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
}

/**
 * 流式对话。
 * onEvent: ({type, ...}) => void
 *   type: 'reasoning' | 'text' | 'toolName' | 'toolArgs' | 'finish' | 'usage'
 * 返回: { text, reasoning, toolCalls:[{callId,name,argsText}], finishReason, usage }
 */
async function streamChat(cfg, { messages, tools, signal, onEvent = () => {}, idleTimeoutMs = 180000, timeoutMs = 600000 }) {
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: cfg.temperature ?? 0.3,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (cfg.maxTokens && cfg.maxTokens > 0) body.max_tokens = cfg.maxTokens;
  // 思考强度。取值只有 core/store.js 里那份白名单（实测自端点）能进来，
  // 而且**只有"生效端点 = 兜底那份"时 cfg.reasoning 才有值** —— 用户自己那组永远被清空，
  // 所以这里不必再判一次是不是兜底（判两次就会有第二个口径）。
  if (cfg.reasoning) body.reasoning_effort = cfg.reasoning;

  const ac = new AbortController();
  let idleTimer = null;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(new Error('流式响应空闲超时')), idleTimeoutMs);
  };
  const hardTimer = setTimeout(() => ac.abort(new Error('整体请求超时')), timeoutMs);
  const onOuterAbort = () => ac.abort(signal && signal.reason);
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
  bumpIdle();

  const acc = { text: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };

  try {
    const res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`模型接口返回 ${res.status} ${res.statusText}${detail ? '：' + detail.slice(0, 600) : ''}`);
    }

    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      bumpIdle();
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw || raw.startsWith(':')) continue;
        if (!raw.startsWith('data:')) continue;
        const payload = raw.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json.usage) acc.usage = json.usage;
        const choice = (json.choices || [])[0];
        if (!choice) continue;
        if (choice.finish_reason) acc.finishReason = choice.finish_reason;
        const d = choice.delta || {};
        const reasoning = d.reasoning_content ?? d.reasoning;
        if (reasoning) {
          acc.reasoning += reasoning;
          onEvent({ type: 'reasoning', delta: reasoning });
        }
        if (d.content) {
          acc.text += d.content;
          onEvent({ type: 'text', delta: d.content });
        }
        for (const tc of d.tool_calls || []) {
          const idx = tc.index ?? 0;
          if (!acc.toolCalls[idx]) acc.toolCalls[idx] = { callId: tc.id || 'call_' + idx, name: '', argsText: '' };
          const slot = acc.toolCalls[idx];
          if (tc.id) slot.callId = tc.id;
          if (tc.function && tc.function.name) {
            slot.name += tc.function.name;
            onEvent({ type: 'toolName', index: idx, name: tc.function.name });
          }
          if (tc.function && tc.function.arguments) {
            slot.argsText += tc.function.arguments;
            onEvent({ type: 'toolArgs', index: idx, delta: tc.function.arguments });
          }
        }
        if (choice.message && choice.message.tool_calls) {
          // 某些实现只在最后一条给出非流式 tool_calls
          for (const tc of choice.message.tool_calls) {
            const idx = tc.index ?? acc.toolCalls.length;
            acc.toolCalls[idx] = { callId: tc.id || 'call_' + idx, name: tc.function?.name || '', argsText: tc.function?.arguments || '{}' };
          }
        }
      }
    }
    acc.toolCalls = acc.toolCalls.filter(Boolean);
    onEvent({ type: 'finish', finishReason: acc.finishReason });
    return acc;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

async function completeOnce(cfg, { messages, tools, signal }) {
  const r = await streamChat(cfg, { messages, tools, signal, onEvent: () => {} });
  return r;
}

module.exports = { listModels, streamChat, completeOnce, httpJson, joinUrl };
