'use strict';
// 上下文压缩：接近上限时，把旧事件交给一次独立调用做结构化摘要，再替换掉原文

const model = require('./model');
const sessionLib = require('./session');

const COMPACT_SYSTEM = `You compress agent transcripts so work can continue in a smaller context window.

Produce a dense briefing for the assistant that will keep working on this task. Keep:
- the user's goal and every explicit instruction or constraint so far;
- decisions made and why, including rejected options;
- files touched, with what changed and their current state;
- commands run and the results that matter;
- open questions, blockers and the immediate next step.

Drop: chit-chat, repeated tool output, intermediate reasoning that led nowhere, and anything already superseded.

Write plain Markdown with short sections. Never invent facts that are not in the transcript.`;

function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of messages) {
    n += sessionLib.estimateTokens(m.content || '');
    if (m.tool_calls) n += sessionLib.estimateTokens(JSON.stringify(m.tool_calls));
  }
  return n;
}

function shouldCompact(settings, session, messages) {
  const limit = settings.model.contextLength || 16384;
  const used = estimateMessagesTokens(messages);
  return used / limit >= (settings.agent.autoCompactRatio || 0.9375);
}

function transcriptToText(session, upToTs) {
  const lines = [];
  for (const e of session.entries) {
    if (upToTs && e.ts > upToTs) break;
    if (e.type === 'message' && e.role === 'user') {
      lines.push('USER: ' + sessionLib.entryPlainText(e));
    } else if (e.type === 'message' && e.role === 'assistant') {
      const text = sessionLib.entryPlainText(e);
      const calls = (e.parts || []).filter((p) => p.type === 'toolCallRequest');
      lines.push('ASSISTANT: ' + text + (calls.length ? '\n  [tools] ' + calls.map((c) => c.name + ' ' + String(c.argsText || '').slice(0, 300)).join('; ') : ''));
    } else if (e.type === 'message' && e.role === 'tool') {
      for (const p of e.parts || []) {
        if (p.type === 'toolCallResult') lines.push(`TOOL ${p.name}${p.isError ? ' (error)' : ''}: ` + String(p.text || '').slice(0, 2000));
      }
    } else if (e.type === 'turnSummary') {
      lines.push('TURN SUMMARY: ' + (e.files || []).map((f) => `${f.path} +${f.added}/-${f.removed}`).join(', '));
    }
  }
  return lines.join('\n\n');
}

/**
 * 需要时压缩。返回 {compacted:boolean, summary?, dropped:number}
 */
async function maybeCompact(settings, session, messages, { signal } = {}) {
  if (!shouldCompact(settings, session, messages)) return { compacted: false };
  // 保留最近的若干条消息事件，其余压掉
  const messageEntries = session.entries.filter((e) => e.type === 'message');
  const keep = Math.min(8, Math.max(2, Math.floor(messageEntries.length * 0.25)));
  const cutIdx = messageEntries.length - keep;
  if (cutIdx <= 0) return { compacted: false };
  const lastOld = messageEntries[cutIdx - 1];
  const text = transcriptToText(session, lastOld.ts);
  const cfg = {
    baseUrl: settings.model.baseUrl,
    apiKey: settings.model.apiKey,
    model: settings.model.model,
    temperature: 0.2,
  };
  const prior = session.compaction && session.compaction.summary ? session.compaction.summary + '\n\n---\n\n' : '';
  const r = await model.completeOnce(cfg, {
    messages: [
      { role: 'system', content: COMPACT_SYSTEM },
      { role: 'user', content: prior + text },
    ],
    signal,
  });
  const summary = (r.text || '').trim();
  if (!summary) return { compacted: false };
  session.compaction = { summary, upToEntryId: lastOld.id, ts: Date.now(), droppedEntries: cutIdx };
  sessionLib.appendEntry(session, {
    type: 'compaction',
    summary,
    upToEntryId: lastOld.id,
    droppedEntries: cutIdx,
    note: '压缩子会话产出',
  });
  return { compacted: true, summary, dropped: cutIdx };
}

module.exports = { maybeCompact, shouldCompact, estimateMessagesTokens, transcriptToText };
