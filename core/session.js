'use strict';
// 会话模型 + 追加式事件日志（id / previousId 链，支持 fork / 回滚 / 子会话）

const os = require('os');
const path = require('path');
const store = require('./store');
const { getProgram, toolAliasesFor } = require('./prompts');

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
    modules: modules || program.modules,
    approvalMode: program.approvalOverride || null, // null = 用全局设置
    model: null,                    // null = 用全局设置
    workingDir: workingDir || (project ? project.cwd : process.cwd()),
    parentSessionId: parentSessionId || null,
    subSessionType: subSessionType || null,
    readOnly: !!readOnly,
    createdAt: now(),
    updatedAt: now(),
    entries: [],
    compaction: null,
  };
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
  return appendEntry(session, {
    type: 'message',
    role: 'user',
    hidden: !!opts.hidden,
    parts: [{ type: 'text', text }],
  });
}

function assistantMessage(session, parts) {
  return appendEntry(session, { type: 'message', role: 'assistant', parts });
}

function toolMessage(session, { callId, name, text, isError, decision }) {
  return appendEntry(session, {
    type: 'message',
    role: 'tool',
    parts: [{ type: 'toolCallResult', callId, name, text, isError: !!isError, decision: decision || null }],
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

function environmentBlock(session) {
  const lines = [
    '  <cwd>' + session.workingDir + '</cwd>',
    '  <current_date>' + new Date().toISOString().slice(0, 10) + '</current_date>',
    '  <timezone>' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown') + '</timezone>',
    '  <operating_system>' + os.platform() + ' ' + os.release() + '</operating_system>',
    '  <username>' + os.userInfo().username + '</username>',
    '  <shell>' + (process.platform === 'win32' ? 'powershell' : 'bash') + '</shell>',
  ];
  return '<environment>\n' + lines.join('\n') + '\n</environment>';
}

// ---- 把事件日志渲染成模型消息 ----
function renderMessages(session, { systemSuffix } = {}) {
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
      messages.push({ role: 'user', content: entryPlainText(e) });
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
  return messages;
}

// 供 UI 显示用：把事件日志转成"看起来像聊天"的行
function renderTranscript(session) {
  const rows = [];
  for (const e of session.entries) {
    if (e.type === 'message' && e.role === 'user') {
      rows.push({ kind: 'user', id: e.id, ts: e.ts, text: entryPlainText(e), hidden: !!e.hidden });
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
        if (p.type === 'toolCallResult') rows.push({ kind: 'tool', id: e.id, ts: e.ts, callId: p.callId, name: p.name, text: p.text, isError: p.isError, decision: p.decision || null });
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
  renderMessages, renderTranscript, forkSession,
  toolAliasesFor,
};
