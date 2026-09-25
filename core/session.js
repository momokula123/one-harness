'use strict';
// 会话模型 + 追加式事件日志（id / previousId 链，支持 fork / 回滚 / 子会话）

const os = require('os');
const path = require('path');
const store = require('./store');
const images = require('./images');
const { getProgram, toolAliasesFor, resolveModules } = require('./prompts');

const ENTRY_TYPES = [
  'message',      // 用户/助手/工具的对话消息
  'stateChange',  // 模块写入的键值状态
  'forkPoint',    // 分叉点
  'turnSummary',  // 回合摘要（耗时 + 文件 diff 统计）
  'elicitation',  // 审批问答
  'compaction',   // 上下文压缩结果
  'error',
  'interrupted',
];

function now() {
  return Date.now();
}

function createSession({ projectId, name, programId, workingDir, parentSessionId, subSessionType, readOnly, modules }) {
  const program = getProgram(programId);
  const project = store.getProject(projectId);
  const s = {
    id: store.newId(),
    projectId,
    name: name || '新会话',
    programId: program.id,
    instruction: null,              // 由 agent 层填充（PROMPTS[program.prompt]）
    promptKey: program.prompt,
    // **不冻结**：不显式传 modules = 挂非枚举 getter 跟程序预设实时走（resolveModules）——
    // 代码升级加了新模块，所有没自定义过的会话立刻用上，不用建新会话。
    // 用户在能力模块里手动改过才落成显式数组（sessions:update 的赋值触发 setter 转正）。
    // 存 null 也不行：内核/测试有直接读 .modules.length 的地方，getter 恰好把兼容层垫上。
    approvalMode: program.approvalOverride || null, // null = 用全局设置
    model: null,                    // null = 用全局设置
    // 端点来源。'fallback' = 这个会话固定走兜底那份端点（「默认模型」专用会话，见 core/prompts.js），
    // null = 跟全局设置（用户自己配的那套，没配就兜底）。它由**程序预设**决定，
    // 建完就不能改 —— sessions:update 的白名单里没有它，所以普通会话切不进来。
    modelSource: program.modelSource || null,
    workingDir: workingDir || (project ? project.cwd : process.cwd()),
    parentSessionId: parentSessionId || null,
    subSessionType: subSessionType || null,
    readOnly: !!readOnly,
    createdAt: now(),
    updatedAt: now(),
    entries: [],
    compaction: null,
  };
  if (modules) s.modules = modules; // 显式传入（如某些内部子会话）才冻结
  else resolveModules(s);           // 其余跟程序预设实时走（非枚举 getter，序列化不落盘）
  return s;
}

function appendEntry(session, entry) {
  const prev = session.entries.length ? session.entries[session.entries.length - 1] : null;
  const full = { id: store.newId(), ts: now(), previousId: prev ? prev.id : null, ...entry };
  session.entries.push(full);
  session.updatedAt = full.ts;
  return full;
}

function findEntry(session, entryId) {
  return session.entries.find((e) => e.id === entryId) || null;
}

function userMessage(session, text, opts = {}) {
  const parts = [{ type: 'text', text }];
  // 图片只记**工作目录内的相对路径**，绝不记 base64：
  // 事件日志是 append-only 的，base64 写进去之后 fork 会复制它、压缩要把历史拼成文本
  // 喂给摘要子会话、重开会话还要整个读一遍 —— 三处都会被撑爆。
  // 真正转 data URL 发生在 renderMessages（发请求那一刻现读现转）。
  for (const img of opts.images || []) {
    const rel = typeof img === 'string' ? img : (img && img.rel);
    if (!rel) continue;
    parts.push({ type: 'image', rel, mime: (img && img.mime) || images.mimeFor(rel) || null });
  }
  return appendEntry(session, {
    type: 'message',
    role: 'user',
    hidden: !!opts.hidden,
    parts,
  });
}

function assistantMessage(session, parts) {
  return appendEntry(session, { type: 'message', role: 'assistant', parts });
}

function toolMessage(session, { callId, name, text, isError, decision, images }) {
  return appendEntry(session, {
    type: 'message',
    role: 'tool',
    parts: [{
      type: 'toolCallResult', callId, name, text, isError: !!isError, decision: decision || null,
      // 工具产出的图（生图）：和用户附件一样**只记相对路径**，像素由界面按需取。
      // 注意这不是"给模型看的图" —— OpenAI 的消息格式里只有 user 能带图，
      // 所以工具产物对模型而言永远只有 text 那一份。
      images: Array.isArray(images) && images.length ? images : null,
    }],
  });
}

function entryPlainText(entry) {
  if (!entry || entry.type !== 'message') return '';
  return (entry.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// ---- token 估算：拉丁字符 /4，CJK 与其它全角约 1 token/字符 ----
function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3000 && c <= 0x303f)) cjk++;
  }
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

function estimateChars(session) {
  let n = 0;
  for (const e of session.entries) {
    if (e.type === 'message') {
      for (const p of e.parts || []) {
        if (p.text) n += p.text.length;
        if (p.argsText) n += p.argsText.length;
      }
    } else if (e.type === 'turnSummary') {
      n += 200;
    }
  }
  return n;
}

/**
 * 累计模型返回的真实 token 用量（OpenAI 兼容的 usage 字段）。
 * 一轮 agent 里每个工具步都会把全量上下文重发一次，所以「累计」和「上下文占用」
 * 是两个不同的量：累计 = 所有调用的总和（算钱用），last* = 最后一次调用的量
 * （= 当前上下文真正占了多少）。两个都记下来，界面各取所需。
 * 本地模型不回传 usage 时这里一直是 0，界面会退回用字符数估算。
 */
function addUsage(session, usage) {
  if (!usage) return session.usage || null;
  const u = session.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  const p = Number(usage.prompt_tokens || 0);
  const c = Number(usage.completion_tokens || 0);
  u.promptTokens += p;
  u.completionTokens += c;
  u.totalTokens += Number(usage.total_tokens || 0) || p + c;
  u.calls += 1;
  u.lastPromptTokens = p;
  u.lastCompletionTokens = c;
  session.usage = u;
  return u;
}

// 审计 P1：os.userInfo() 在受限/容器账号下会抛错，它裸写在每轮都要跑的 environmentBlock
// 里 —— 一抛整轮对话就发不出去。回退到环境变量，再不行给占位串。
function safeUserName() {
  try { return os.userInfo().username; }
  catch { return process.env.USERNAME || process.env.USER || 'unknown'; }
}

function environmentBlock(session) {
  const lines = [
    '  <cwd>' + session.workingDir + '</cwd>',
    '  <current_date>' + new Date().toISOString().slice(0, 10) + '</current_date>',
    '  <timezone>' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown') + '</timezone>',
    '  <operating_system>' + os.platform() + ' ' + os.release() + '</operating_system>',
    '  <username>' + safeUserName() + '</username>',
    '  <shell>' + (process.platform === 'win32' ? 'powershell' : 'bash') + '</shell>',
  ];
  return '<environment>\n' + lines.join('\n') + '\n</environment>';
}

/**
 * 组装一条带图片的 user 消息（content 数组形）。
 * 读盘失败的图**不整轮失败**，退化成一行中文说明放在文本 part 里 ——
 * 拖进来的图后来被改名或删掉是很正常的事，不该让整轮对话因此发不出去。
 */
function userContentWithImages(session, entry, pics) {
  const notes = [];
  const content = [];
  for (const p of pics) {
    const r = images.inspect(path.resolve(session.workingDir || '.', p.rel));
    if (!r.ok) { notes.push(`[图片不可用：${p.rel}（${r.error}）]`); continue; }
    content.push({ type: 'image_url', image_url: { url: r.dataUrl } });
  }
  const head = [entryPlainText(entry), ...notes].filter(Boolean).join('\n\n');
  // 文本 part 不能省、也不能是空串：用户只拖了图没打字时给它一句占位，
  // 否则会发出一个"只有 image part"的消息，各家端点对它的接受度并不一致。
  return [{ type: 'text', text: head || (content.length ? '（见附图）' : '（图片不可用）') }, ...content];
}

/**
 * 消息数组的总字符数（运行日志的 promptChars 用）。
 * 为什么不用 `JSON.stringify(messages).length`：消息里一旦有图，那行会先把几 MB 的
 * base64 拼成一个完整字符串再取长度 —— agent 每步都来一次，纯属白烧内存。
 */
function messagesChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (!m) continue;
    if (typeof m.content === 'string') n += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p) continue;
        if (typeof p.text === 'string') n += p.text.length;
        else if (p.image_url && typeof p.image_url.url === 'string') n += p.image_url.url.length;
      }
    }
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

// 补出来的那条 tool 消息的正文（给模型看的"事实"：这轮被打断，这个调用没跑）
const MISSING_TOOL_TEXT = '（未执行：那一轮被用户中断）';

/**
 * 工具组自愈：组装好的消息里，assistant(tool_calls) 后面**必须紧跟它每个 call 的 tool 消息**——
 * 中间不能夹别的角色，也不能少任何一个；少一个上游就整轮 400：
 *   An assistant message with 'tool_calls' must be followed by tool messages
 *   responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
 *
 * 缺口是哪儿来的：① 用户按「停止」正好打断一个"一次返回多个调用"的工具组
 * （agent.js 的中断补齐只管新事件）；② 压缩切点落在组中间。事件日志是 append-only 的，
 * 老缺口改不掉，所以在**发请求这一刻**把它修成合法的：日志一个字节不动。
 *   - 组里有 call 没收到回应 → 在该组末尾补一条 tool 消息（内容见 MISSING_TOOL_TEXT）；
 *   - 没有所属组的 tool 消息（压缩切点留下的孤儿）、以及重复 id → 丢掉，否则上游同样 400。
 * 合法的输入原样返回（不多一条、不少一条），所以正常会话的请求与改前逐字节一致。
 */
function normalizeToolGroups(messages) {
  const out = [];
  let group = null; // { ids, seen }
  const closeGroup = () => {
    if (!group) return;
    for (const id of group.ids) {
      if (group.seen.has(id)) continue;
      out.push({ role: 'tool', tool_call_id: id, content: MISSING_TOOL_TEXT });
    }
    group = null;
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      if (group && group.ids.has(m.tool_call_id) && !group.seen.has(m.tool_call_id)) {
        group.seen.add(m.tool_call_id);
        out.push(m);
      }
      continue;
    }
    closeGroup();
    out.push(m);
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      group = { ids: new Set(m.tool_calls.map((c) => c.id)), seen: new Set() };
    }
  }
  closeGroup();
  return out;
}

// ---- 把事件日志渲染成模型消息 ----
// vision=true 且这条 user 消息带 image part 时，content 用**数组**形
// （`[{type:'text'},{type:'image_url',image_url:{url}}]`，OpenAI /chat/completions 的规范）；
// 否则一律维持原来的字符串形 —— 没开视觉开关时，图退化成一行 `[附件] x` 文本，
// 行为和接图片之前完全一致。
function renderMessages(session, { systemSuffix, vision } = {}) {
  const system = [session.instruction || '', '\n# Environment\n', environmentBlock(session)];
  if (systemSuffix) system.push('\n', systemSuffix);
  if (session.readOnly) system.push('\nThis session is read-only. You may inspect files but must not modify them.');
  if (session.compaction && session.compaction.summary) {
    system.push('\n# Earlier context (compacted)\n', session.compaction.summary);
  }

  const messages = [{ role: 'system', content: system.join('\n') }];
  const startIdx = session.compaction && session.compaction.upToEntryId
    ? session.entries.findIndex((e) => e.id === session.compaction.upToEntryId) + 1
    : 0;

  for (const e of session.entries.slice(startIdx)) {
    if (e.type !== 'message') continue;
    if (e.role === 'user') {
      const pics = (e.parts || []).filter((p) => p.type === 'image');
      if (vision && pics.length) {
        messages.push({ role: 'user', content: userContentWithImages(session, e, pics) });
      } else {
        // 没开视觉开关，或这条消息里根本没有图 → 维持原来的字符串形。
        // 注意这里是**补齐** [附件] 行而不是丢弃：image part 是 main.js 写的，
        // 它写的时候并没有同时写 [附件] 文本行（否则开着视觉会两处重复），
        // 所以关掉开关/端点不吃图时，那几行必须在这里补出来，
        // 模型才仍然知道"有个 chart.png 在工作目录里"。
        const text = entryPlainText(e);
        messages.push({
          role: 'user',
          content: pics.length ? text + '\n\n' + pics.map((p) => `[附件] ${p.rel}`).join('\n') : text,
        });
      }
    } else if (e.role === 'assistant') {
      const text = entryPlainText(e);
      const calls = (e.parts || []).filter((p) => p.type === 'toolCallRequest');
      const msg = { role: 'assistant', content: text || '' };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.callId,
          type: 'function',
          function: { name: c.name, arguments: c.argsText || '{}' },
        }));
      }
      messages.push(msg);
    } else if (e.role === 'tool') {
      for (const p of e.parts || []) {
        if (p.type === 'toolCallResult') {
          messages.push({ role: 'tool', tool_call_id: p.callId, content: String(p.text ?? '') });
        }
      }
    }
  }
  return normalizeToolGroups(messages);
}

// 供 UI 显示用：把事件日志转成"看起来像聊天"的行
function renderTranscript(session) {
  const rows = [];
  for (const e of session.entries) {
    if (e.type === 'message' && e.role === 'user') {
      rows.push({
        kind: 'user', id: e.id, ts: e.ts, text: entryPlainText(e), hidden: !!e.hidden,
        // 界面要能看见自己拖了什么。只带相对路径，像素由渲染层按需向主进程要
        // （见 main.js 的 files:preview）—— transcript 是每轮都会重发的一份数据，
        // 把 data URL 塞进来等于每次会话更新都搬一遍图。
        images: (e.parts || []).filter((p) => p.type === 'image').map((p) => ({ rel: p.rel, mime: p.mime || null })),
      });
    } else if (e.type === 'message' && e.role === 'assistant') {
      rows.push({
        kind: 'assistant',
        id: e.id,
        ts: e.ts,
        text: entryPlainText(e),
        reasoning: (e.parts || []).filter((p) => p.type === 'reasoning').map((p) => p.text).join('\n'),
        toolCalls: (e.parts || []).filter((p) => p.type === 'toolCallRequest').map((p) => ({ callId: p.callId, name: p.name, argsText: p.argsText })),
      });
    } else if (e.type === 'message' && e.role === 'tool') {
      for (const p of e.parts || []) {
        if (p.type === 'toolCallResult') rows.push({ kind: 'tool', id: e.id, ts: e.ts, callId: p.callId, name: p.name, text: p.text, isError: p.isError, decision: p.decision || null, images: p.images || [] });
      }
    } else if (e.type === 'turnSummary') {
      rows.push({ kind: 'summary', id: e.id, ts: e.ts, durationMs: e.durationMs, files: e.files || [] });
    } else if (e.type === 'elicitation') {
      rows.push({ kind: 'elicitation', id: e.id, ts: e.ts, request: e.request, response: e.response, reviewer: e.reviewer });
    } else if (e.type === 'error') {
      rows.push({ kind: 'error', id: e.id, ts: e.ts, message: e.message, critical: e.critical });
    } else if (e.type === 'interrupted') {
      rows.push({ kind: 'interrupted', id: e.id, ts: e.ts });
    } else if (e.type === 'compaction') {
      rows.push({ kind: 'compaction', id: e.id, ts: e.ts, summary: e.summary });
    } else if (e.type === 'forkPoint') {
      rows.push({ kind: 'forkPoint', id: e.id, ts: e.ts, at: e.at });
    }
  }
  return rows;
}

// 从某个分叉点复制出一个新会话
function forkSession(session, entryId) {
  const idx = session.entries.findIndex((e) => e.id === entryId);
  const clone = JSON.parse(JSON.stringify(session));
  clone.id = store.newId();
  clone.parentSessionId = session.id;
  clone.name = session.name + '（分叉）';
  clone.createdAt = now();
  clone.entries = idx >= 0 ? session.entries.slice(0, idx + 1) : session.entries.slice();
  clone.compaction = null;
  const last = clone.entries[clone.entries.length - 1];
  if (last) clone.entries.push({ id: store.newId(), ts: now(), previousId: last.id, type: 'forkPoint', at: 'manual' });
  return clone;
}

module.exports = {
  ENTRY_TYPES, now, createSession, appendEntry, findEntry,
  userMessage, assistantMessage, toolMessage,
  entryPlainText, estimateTokens, estimateChars, addUsage, environmentBlock,
  renderMessages, renderTranscript, forkSession, messagesChars,
  normalizeToolGroups, MISSING_TOOL_TEXT,
  toolAliasesFor,
};
