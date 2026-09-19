'use strict';
// 上下文压缩：接近上限时，把旧事件交给一次独立调用做结构化摘要，再替换掉原文

const model = require('./model');
const sessionLib = require('./session');
const images = require('./images');
const store = require('./store');

const COMPACT_SYSTEM = `You compress agent transcripts so work can continue in a smaller context window.

Produce a dense briefing for the assistant that will keep working on this task. Keep:
- the user's goal and every explicit instruction or constraint so far;
- decisions made and why, including rejected options;
- files touched, with what changed and their current state;
- commands run and the results that matter;
- open questions, blockers and the immediate next step.

Drop: chit-chat, repeated tool output, intermediate reasoning that led nowhere, and anything already superseded.

Write plain Markdown with short sections. Never invent facts that are not in the transcript.`;

/**
 * 估算一组消息占多少 token。
 * `content` 可能是字符串（纯文本消息），也可能是数组（带图的消息）——
 * 数组这一支**必须**单独处理：`estimateTokens` 会把整个数组 `String()` 成
 * `[object Object],[object Object]`，于是带图的消息估算值骤降、自动压缩永远不触发，
 * 上下文一路涨到端点报错为止。这是那种"不报错但静默算错"的坏法，比崩了更难查。
 */
function contentTokens(content) {
  if (Array.isArray(content)) {
    let n = 0;
    for (const p of content) {
      if (!p) continue;
      if (p.type === 'image_url') n += images.tokensForDataUrl(p.image_url && p.image_url.url);
      else n += sessionLib.estimateTokens(p.text || '');
    }
    return n;
  }
  return sessionLib.estimateTokens(content || '');
}

function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of messages) {
    n += contentTokens(m.content);
    if (m.tool_calls) n += sessionLib.estimateTokens(JSON.stringify(m.tool_calls));
  }
  return n;
}

function shouldCompact(settings, session, messages) {
  // 容量按**这个会话实际在用的端点**算（store.endpointFor）—— 「默认模型」专用会话走兜底那份，
  // 它自带 512K。拿全局那套的 16384 去卡它，等于每 1.5 万 token 就白砍一次上下文。
  const limit = store.endpointFor(settings, session && session.modelSource).contextLength || 16384;
  const used = estimateMessagesTokens(messages);
  return used / limit >= (settings.agent.autoCompactRatio || 0.9375);
}

function transcriptToText(session, upToTs) {
  const lines = [];
  for (const e of session.entries) {
    if (upToTs && e.ts > upToTs) break;
    if (e.type === 'message' && e.role === 'user') {
      // 图片只留一行占位符。entryPlainText 只取 text part，图会被无声丢掉 ——
      // 不崩，但摘要里连"这里曾经有张图"的痕迹都没有，压缩之后模型就再也想不起来
      // 图里是什么了。宁可留个名字，也不要让历史凭空少一块。
      const pics = (e.parts || []).filter((p) => p.type === 'image');
      lines.push('USER: ' + sessionLib.entryPlainText(e)
        + (pics.length ? `\n  [附图 ${pics.length} 张：${pics.map((p) => p.rel).join('、')}（图片内容不在摘要里）]` : ''));
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
  // 摘要这次调用也走**这个会话实际在用的端点**，与主循环同一口径：
  // 否则专用会话会出现"对话打 agnes、摘要拿用户那套打"的分叉（地址与钥匙错配）。
  const ep = store.endpointFor(settings, session && session.modelSource);
  const cfg = {
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: ep.model,
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
