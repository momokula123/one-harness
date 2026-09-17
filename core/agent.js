'use strict';
// Agent 主循环：组装消息 → 流式调用 → 审批 → 执行工具 → 回填 → 循环

const path = require('path');
const store = require('./store');
const sessionLib = require('./session');
const tools = require('./tools');
const checkpoints = require('./checkpoints');
const approvals = require('./approvals');
const compact = require('./compact');
const model = require('./model');
const { PROMPTS, getProgram, toolAliasesFor } = require('./prompts');
const skillsMod = require('./tools/skills');

function newId() {
  return store.newId();
}

function diffStat(beforeText, afterText) {
  if (beforeText == null || afterText == null) {
    const added = afterText ? afterText.split('\n').length : 0;
    const removed = beforeText ? beforeText.split('\n').length : 0;
    return { added, removed };
  }
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  const count = (arr) => {
    const m = new Map();
    for (const l of arr) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const bm = count(before);
  const am = count(after);
  let added = 0;
  let removed = 0;
  for (const [l, n] of am) {
    const b = bm.get(l) || 0;
    if (n > b) added += n - b;
  }
  for (const [l, n] of bm) {
    const a = am.get(l) || 0;
    if (n > a) removed += n - a;
  }
  return { added, removed };
}

class Agent {
  constructor({ getSettings, emit, askUser }) {
    this.getSettings = getSettings;
    this.emit = emit;
    this.askUser = askUser;
    this.running = new Map(); // sessionId -> AbortController
  }

  isRunning(sessionId) {
    return this.running.has(sessionId);
  }

  stop(sessionId) {
    const ac = this.running.get(sessionId);
    if (ac) ac.abort(new Error('用户停止了本轮'));
    return !!ac;
  }

  modelConfig(session) {
    const s = this.getSettings();
    const base = {
      baseUrl: s.model.baseUrl,
      apiKey: s.model.apiKey,
      model: s.model.model,
      temperature: s.model.temperature,
      maxTokens: s.model.maxTokens,
    };
    return { ...base, ...(session.model || {}), settings: s };
  }

  ctx(session, turn) {
    return {
      session,
      projectId: session.projectId,
      workingDir: session.workingDir,
      settings: this.getSettings(),
      approvedByUser: false,
      snapshot: (absPath) => {
        const rec = checkpoints.snapshot(session.projectId, session.id, absPath);
        turn.snapshots.push({ path: absPath, before: rec.beforeText, beforeSize: rec.size });
        return rec;
      },
      log: (msg) => this.emit({ type: 'log', sessionId: session.id, message: msg }),
    };
  }

  // ---- 一轮对话（可被多次工具调用拆成多步）----
  async runTurn(session) {
    if (this.running.has(session.id)) throw new Error('这个会话正在运行中。');
    const ac = new AbortController();
    this.running.set(session.id, ac);
    let steps = 0;
    try {
      // 这三行必须留在 try 里面：它们如果抛错（比如设置文件损坏、programId 对不上），
      // 而 try 还没开始，finally 就永远跑不到 → running 锁不释放，
      // 这个会话之后每一次发送都会被判成"正在运行中"，界面和内核一起永久卡死。
      const settings = this.getSettings();
      session.instruction = session.instruction || PROMPTS[session.promptKey || getProgram(session.programId).prompt];
      const turn = { startedAt: Date.now(), snapshots: [] };
      this.emit({ type: 'turn:start', sessionId: session.id });
      while (steps < (settings.agent.maxSteps || 40)) {
        if (ac.signal.aborted) throw new Error('已停止');
        steps++;

        // 1) 压缩（需要时）
        let messages = sessionLib.renderMessages(session, { systemSuffix: skillsMod.skillsIndex() });
        if (session.modules.includes('compaction')) {
          const c = await compact.maybeCompact(settings, session, messages, { signal: ac.signal });
          if (c.compacted) {
            this.emit({ type: 'compaction', sessionId: session.id, dropped: c.dropped });
            messages = sessionLib.renderMessages(session, { systemSuffix: skillsMod.skillsIndex() });
          }
        }

        // 2) 调模型
        const aliases = toolAliasesFor({ modules: session.modules }, session.modules);
        const schemas = aliases.length ? tools.schemasFor(aliases) : [];
        const mcfg = this.modelConfig(session);
        const assistantId = newId();
        this.emit({ type: 'assistant:start', sessionId: session.id, entryId: assistantId });

        const acc = await model.streamChat(mcfg, {
          messages,
          tools: schemas,
          signal: ac.signal,
          timeoutMs: settings.agent.requestTimeoutMs,
          idleTimeoutMs: settings.agent.streamIdleTimeoutMs,
          onEvent: (ev) => {
            if (ev.type === 'text') this.emit({ type: 'assistant:delta', sessionId: session.id, kind: 'text', delta: ev.delta });
            else if (ev.type === 'reasoning') this.emit({ type: 'assistant:delta', sessionId: session.id, kind: 'reasoning', delta: ev.delta });
            else if (ev.type === 'toolName') this.emit({ type: 'tool:announce', sessionId: session.id, name: ev.name });
          },
        });

        // 3) 落盘这条 assistant 消息
        if (acc.usage) sessionLib.addUsage(session, acc.usage);
        const parts = [];
        if (acc.reasoning) parts.push({ type: 'reasoning', text: acc.reasoning });
        if (acc.text) parts.push({ type: 'text', text: acc.text });
        for (const c of acc.toolCalls) {
          let parsed = null;
          try { parsed = JSON.parse(c.argsText || '{}'); } catch {}
          parts.push({ type: 'toolCallRequest', callId: c.callId, name: c.name, argsText: c.argsText, args: parsed });
        }
        const assistantEntry = sessionLib.appendEntry(session, { type: 'message', role: 'assistant', parts, id: assistantId });
        this.emit({ type: 'assistant:end', sessionId: session.id, entryId: assistantEntry.id });
        this.emit(sessionEvent(session));

        if (!acc.toolCalls.length) {
          this.finishTurn(session, turn, settings);
          return { ok: true, steps };
        }

        // 4) 逐个执行工具
        for (const call of acc.toolCalls) {
          if (ac.signal.aborted) throw new Error('已停止');
          const tool = tools.resolveTool(call.name);
          if (!tool) {
            sessionLib.toolMessage(session, { callId: call.callId, name: call.name, text: `未知工具 "${call.name}"`, isError: true });
            continue;
          }
          let args = {};
          try {
            args = call.argsText ? JSON.parse(call.argsText) : {};
          } catch (e) {
            sessionLib.toolMessage(session, { callId: call.callId, name: call.name, text: `参数 JSON 解析失败：${e.message}`, isError: true });
            continue;
          }

          // 闸门现读一次设置，而不是用本轮开头那份快照：`settings` 在 runTurn 开头取一次，
          // 而用户在「设置 → 会话」里改**全局**审批模式是在轮次运行中发生的 —— 用快照的话
          // 改了也白改（会话级 approveMode 同理，那条走 main.js 的 liveSessions）。
          // 每次工具调用重读的代价可以忽略（settings 有缓存），换来"改了就真的生效"。
          let gateSettings = settings;
          try { gateSettings = this.getSettings() || settings; } catch (e) { /* 设置文件坏了就退回快照 */ }
          const gate = await approvals.gate(gateSettings, { tool, args, session, signal: ac.signal });
          this.emit({ type: 'approval:decision', sessionId: session.id, callId: call.callId, tool: tool.alias, args, risk: gate.risk, action: gate.action, reason: gate.reason });

          if (gate.action === 'deny') {
            sessionLib.appendEntry(session, {
              type: 'elicitation',
              request: { kind: 'tool', tool: tool.alias, args, risk: gate.risk },
              response: 'denied',
              reviewer: gate.reviewer || null,
              reason: gate.reason,
            });
            sessionLib.toolMessage(session, {
              callId: call.callId,
              name: call.name,
              text: `拒绝执行：${gate.reason}。请改用别的做法，或向用户说明为什么必须这么做。`,
              isError: true,
            });
            this.emit(sessionEvent(session));
            continue;
          }

          if (gate.action === 'ask') {
            const answer = await this.askUser({
              sessionId: session.id,
              callId: call.callId,
              tool: tool.alias,
              args,
              risk: gate.risk,
              reason: gate.reason,
              reviewer: gate.reviewer || null,
            });
            sessionLib.appendEntry(session, {
              type: 'elicitation',
              request: { kind: 'tool', tool: tool.alias, args, risk: gate.risk, reason: gate.reason },
              response: answer.approved ? 'approved' : 'denied',
              reviewer: gate.reviewer || null,
            });
            this.emit(sessionEvent(session));
            if (!answer.approved) {
              sessionLib.toolMessage(session, {
                callId: call.callId,
                name: call.name,
                text: `用户拒绝执行：${answer.note || '未说明原因'}。不要重试同样的命令，先和用户确认需求。`,
                isError: true,
                decision: {
                  action: 'deny',
                  risk: gate.risk,
                  reason: '用户拒绝了这次调用' + (answer.note ? '：' + answer.note : ''),
                  reviewer: gate.reviewer ? { ok: gate.reviewer.ok !== false, risk: gate.reviewer.risk || null, authorization: gate.reviewer.authorization || null, correct: gate.reviewer.correct !== false, steps: gate.reviewer.steps || 0 } : null,
                },
              });
              continue;
            }
          }

          this.emit({ type: 'tool:start', sessionId: session.id, callId: call.callId, name: tool.alias, args, risk: gate.risk, reason: gate.reason });
          const ctx = this.ctx(session, turn);
          ctx.approvedByUser = gate.action === 'ask';
          const started = Date.now();
          const result = await tools.execute(call.name, call.argsText, ctx);
          const durationMs = Date.now() - started;
          // 把闸门的决定一起落盘：这样工具卡上能显示「谁放行的、评审怎么判的」，
          // 重开会话也还在（不然这块信息只活在事件里，一刷新就没了）。
          sessionLib.toolMessage(session, {
            callId: call.callId,
            name: tool.alias,
            text: result.text,
            isError: result.isError,
            decision: {
              action: gate.action,
              risk: gate.risk,
              reason: gate.reason || '',
              reviewerFailed: !!gate.reviewerFailed,
              reviewer: gate.reviewer
                ? { ok: gate.reviewer.ok !== false, risk: gate.reviewer.risk || null, authorization: gate.reviewer.authorization || null, correct: gate.reviewer.correct !== false, steps: gate.reviewer.steps || 0 }
                : null,
            },
          });
          this.emit({ type: 'tool:end', sessionId: session.id, callId: call.callId, name: tool.alias, isError: result.isError, durationMs, text: result.text });
          this.emit(sessionEvent(session));
        }
      }
      sessionLib.appendEntry(session, { type: 'error', message: `达到最大步数（${settings.agent.maxSteps}）已停止。`, critical: false });
      this.finishTurn(session, turn, settings);
      return { ok: false, reason: 'max-steps', steps };
    } catch (e) {
      const aborted = ac.signal.aborted;
      sessionLib.appendEntry(session, aborted
        ? { type: 'interrupted' }
        : { type: 'error', message: e && e.message ? e.message : String(e), critical: true });
      this.emit(sessionEvent(session));
      this.emit({ type: 'turn:end', sessionId: session.id, aborted });
      return { ok: false, reason: aborted ? 'aborted' : 'error', message: e && e.message ? e.message : String(e) };
    } finally {
      this.running.delete(session.id);
      store.saveSession(session.projectId, session);
    }
  }

  finishTurn(session, turn, settings) {
    const files = [];
    const seen = new Set();
    for (const s of turn.snapshots) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      const after = checkpoints.afterState(s.path);
      const stat = diffStat(s.before, after.text);
      files.push({
        path: path.relative(session.workingDir, s.path).split(path.sep).join('/') || s.path,
        absPath: s.path,
        beforeSizeBytes: s.before == null ? null : s.beforeSize,
        afterSizeBytes: after.exists ? after.size : null,
        added: stat.added,
        removed: stat.removed,
      });
    }
    sessionLib.appendEntry(session, { type: 'turnSummary', durationMs: Date.now() - turn.startedAt, files });
    this.emit(sessionEvent(session));
    this.emit({ type: 'turn:end', sessionId: session.id, files });
    store.saveSession(session.projectId, session);
  }
}

function sessionEvent(session) {
  return {
    type: 'session:update',
    sessionId: session.id,
    transcript: sessionLib.renderTranscript(session),
    meta: sessionMeta(session),
  };
}

function sessionMeta(session) {
  return {
    id: session.id,
    name: session.name,
    programId: session.programId,
    modules: session.modules,
    model: session.model,
    workingDir: session.workingDir,
    approvalMode: session.approvalMode,
    readOnly: session.readOnly,
    entryCount: session.entries.length,
    chars: sessionLib.estimateChars(session),
    usage: session.usage || null,
    compaction: session.compaction ? { ts: session.compaction.ts, dropped: session.compaction.droppedEntries } : null,
    updatedAt: session.updatedAt,
  };
}

module.exports = { Agent, sessionMeta, sessionEvent, diffStat };
