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
const images = require('./images');
const runlog = require('./runlog');
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

/**
 * 把内核事件挑重要的记进运行日志（`logs/run-YYYY-MM-DD.log`）。
 * 只记事后排查用得上的：轮次边界、闸门裁决、压缩。
 * **不记** assistant:delta —— 逐字流，量极大，且正文本来就在会话文件里。
 * 模型调用与工具调用不在这里记：那两处有事件里没有的信息（耗时、token、完整结果），
 * 在各自执行点顺手记更准。
 */
function logCoreEvent(ev) {
  if (!ev || !ev.type) return;
  const sessionId = ev.sessionId || null;
  switch (ev.type) {
    case 'turn:start':
      runlog.turn({ phase: 'start', sessionId });
      break;
    case 'turn:end':
      runlog.turn({ phase: 'end', sessionId, aborted: !!ev.aborted, files: (ev.files || []).length });
      break;
    case 'approval:decision':
      runlog.log('gate.decision', {
        sessionId, callId: ev.callId, tool: ev.tool, risk: ev.risk,
        action: ev.action, reason: ev.reason, args: ev.args,
      });
      break;
    case 'compaction':
      runlog.log('compaction', { sessionId, dropped: ev.dropped });
      break;
    default:
      break;
  }
}

class Agent {
  constructor({ getSettings, emit, askUser }) {
    this.getSettings = getSettings;
    this.askUser = askUser;
    this.running = new Map(); // sessionId -> AbortController
    // 事件 → 运行日志的桥放在**内核**里，而不是宿主里：
    // 日志是出事之后唯一的依据，不能因为换了个宿主（无界面跑、测试、别的壳）就断掉。
    // 宿主照旧收到完整事件，这里只是在转发前顺手挑几条记下来。
    const hostEmit = typeof emit === 'function' ? emit : () => {};
    this.emit = (ev) => { logCoreEvent(ev); hostEmit(ev); };
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
    // 这个会话该打哪个端点：普通会话 = 生效设置那一套（用户自己的，没配就是兜底）；
    // 「默认模型」专用会话（session.modelSource === 'fallback'）**整组**换成兜底那份 ——
    // 换地址、钥匙、模型名、上下文大小、思考强度一起换，不单个字段去借。
    // 判定只有一处实现（store.endpointFor），压缩阈值/界面占用条用的是同一个。
    const ep = store.endpointFor(s, session && session.modelSource);
    const base = {
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      model: ep.model,
      temperature: ep.temperature,
      maxTokens: ep.maxTokens,
      // 思考强度：普通会话走用户自己那套时这里恒为空串（store.getSettings 已经清掉），
      // 于是"调兜底的思考强度"绝不会跑到用户正在用的模型上去。
      reasoning: ep.reasoning || '',
    };
    // 这个模型能不能吃图。和模型名/温度一样支持**会话级覆盖**
    // （session.model 是既有的覆盖口），所以这里和它一起算，不另开一套。
    const vision = (session.model && typeof session.model.supportsVision === 'boolean')
      ? session.model.supportsVision
      : !!s.model.supportsVision;
    return { ...base, ...(session.model || {}), vision, settings: s };
  }

  ctx(session, turn, signal) {
    return {
      session,
      projectId: session.projectId,
      workingDir: session.workingDir,
      settings: this.getSettings(),
      // 本轮的取消信号：工具里那些"几秒到几十秒"的网络请求（生图就是）要能跟着"停止"一起断，
      // 否则用户按了停止还得干等几百秒。可选：没有 signal 的工具照旧。
      signal: signal || null,
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
    // 计时基准必须放在 try **外面**：catch 里要记 elapsedMs，而 turn 是在 try 内部建的 ——
    // 万一 getSettings() 就抛错（turn 还没建），catch 里读 turn.startedAt 会再抛一个
    // ReferenceError，把"折成失败结果"的路径炸穿（曾实测：3 条用例因此变红）。
    const turnStart = Date.now();
    try {
      // 这三行必须留在 try 里面：它们如果抛错（比如设置文件损坏、programId 对不上），
      // 而 try 还没开始，finally 就永远跑不到 → running 锁不释放，
      // 这个会话之后每一次发送都会被判成"正在运行中"，界面和内核一起永久卡死。
      const settings = this.getSettings();
      session.instruction = session.instruction || PROMPTS[session.promptKey || getProgram(session.programId).prompt];
      const turn = { startedAt: turnStart, snapshots: [] };
      // 视觉开关在**这一轮内**是可变的：勾了"支持图片输入"但端点实际不吃图时，
      // 下面会把它降级成 false 并重发一次；降级后这一轮剩下的每一步都按纯文本走，
      // 不再每步都去撞一次 400。
      let vision = !!this.modelConfig(session).vision;
      this.emit({ type: 'turn:start', sessionId: session.id });
      while (steps < (settings.agent.maxSteps || 40)) {
        if (ac.signal.aborted) throw new Error('已停止');
        steps++;

        // 1) 压缩（需要时）
        let messages = sessionLib.renderMessages(session, { systemSuffix: skillsMod.systemSuffix(), vision });
        if (session.modules.includes('compaction')) {
          const c = await compact.maybeCompact(settings, session, messages, { signal: ac.signal });
          if (c.compacted) {
            this.emit({ type: 'compaction', sessionId: session.id, dropped: c.dropped });
            messages = sessionLib.renderMessages(session, { systemSuffix: skillsMod.systemSuffix(), vision });
          }
        }

        // 2) 调模型
        const aliases = toolAliasesFor({ modules: session.modules }, session.modules);
        const schemas = aliases.length ? tools.schemasFor(aliases) : [];
        const mcfg = this.modelConfig(session);
        const assistantId = newId();
        this.emit({ type: 'assistant:start', sessionId: session.id, entryId: assistantId });

        const modelStarted = Date.now();
        runlog.log('model.start', {
          sessionId: session.id, step: steps, model: mcfg.model, stream: true,
          messages: messages.length, tools: (schemas || []).length,
          promptChars: sessionLib.messagesChars(messages),
          images: images.hasImageParts(messages) ? 1 : 0,
        });
        const onModelEvent = (ev) => {
          if (ev.type === 'text') this.emit({ type: 'assistant:delta', sessionId: session.id, kind: 'text', delta: ev.delta });
          else if (ev.type === 'reasoning') this.emit({ type: 'assistant:delta', sessionId: session.id, kind: 'reasoning', delta: ev.delta });
          else if (ev.type === 'toolName') this.emit({ type: 'tool:announce', sessionId: session.id, name: ev.name });
        };
        // 这一步最多发两次请求。第一次按当前 vision 走；只有"端点明确因为图片报错"时才
        // 剥掉图重发一次。重发的那次如果也失败，两个错都要报出来 —— 只报第二次会掩盖
        // "其实是图片引起的"这个最关键的信息。
        let acc = null;
        let imageError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            acc = await model.streamChat(mcfg, {
              messages,
              tools: schemas,
              signal: ac.signal,
              timeoutMs: settings.agent.requestTimeoutMs,
              idleTimeoutMs: settings.agent.streamIdleTimeoutMs,
              onEvent: onModelEvent,
            });
            break;
          } catch (e) {
            if (attempt === 0 && vision && images.hasImageParts(messages) && images.looksLikeImageRejection(e)) {
              imageError = e;
              vision = false;
              // 勾了"支持图片输入"但端点其实不吃图 —— 不能整轮崩在这里，也不能只丢一句
              // 英文堆栈。剥图重发，并明确告诉用户下一步该做什么。这条经验来自
              // DeepSeek-Reasonix（internal/agent/imageinput.go）：失败时报的不该只是
              // "失败了"，而是"别重试、该怎么办"，否则人和模型都会反复撞同一堵墙。
              runlog.log('vision.fallback', { sessionId: session.id, step: steps, error: String((e && e.message) || e).slice(0, 400) });
              sessionLib.appendEntry(session, {
                type: 'error',
                critical: false,
                message: '这个模型拒绝了图片输入，已按纯文本重发（图片仍留在工作目录里，需要的话可以用文档工具处理）。'
                  + '请在 设置 → 常规 里取消勾选「支持图片输入」。　原报错：' + String((e && e.message) || e).slice(0, 300),
              });
              this.emit(sessionEvent(session));
              messages = sessionLib.renderMessages(session, { systemSuffix: skillsMod.systemSuffix(), vision: false });
              continue;
            }
            if (imageError) {
              throw new Error('剥掉图片重发仍然失败：' + ((e && e.message) || e)
                + '　（带图片时报的是：' + String((imageError && imageError.message) || imageError).slice(0, 200) + '）');
            }
            throw e;
          }
        }
        // 模型调用的开销是排查"请求停不下来"的关键证据：耗时异常长 / token 暴涨都在这里
        runlog.modelCall({
          sessionId: session.id, step: steps, model: mcfg.model, ok: true,
          durationMs: Date.now() - modelStarted,
          promptTokens: (acc.usage && acc.usage.prompt_tokens) ?? null,
          completionTokens: (acc.usage && acc.usage.completion_tokens) ?? null,
          toolCalls: acc.toolCalls.length,
          finishReason: acc.finishReason || null,
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
          const ctx = this.ctx(session, turn, ac.signal);
          ctx.approvedByUser = gate.action === 'ask';
          const started = Date.now();
          const result = await tools.execute(call.name, call.argsText, ctx);
          const durationMs = Date.now() - started;
          // 每次工具调用都落日志，**成功失败的都记**。
          // 排查"请求停不下来"靠的正是"同一类调用反复出现、每次耗时 20 秒"这种模式，
          // 而这类证据的主体恰恰是那些没报错但很慢的调用 —— 只记失败会看不见它。
          // 写在**内核**而不是宿主（main.js 的 emit 桥）里：日志是排障的最后依据，
          // 不能因为换了宿主、或跑在测试里就断掉。
          runlog.toolCall({
            sessionId: session.id, callId: call.callId, tool: tool.alias,
            ok: !(result && result.isError),
            durationMs, outChars: ((result && result.text) || '').length,
            args,
            // 失败时留下完整结果：超时/堆栈都在结果文本里，而 emit 出去的事件只带前 300 字
            error: result && result.isError ? String(result.text || '').slice(0, 1200) : undefined,
          });
          // 把闸门的决定一起落盘：这样工具卡上能显示「谁放行的、评审怎么判的」，
          // 重开会话也还在（不然这块信息只活在事件里，一刷新就没了）。
          sessionLib.toolMessage(session, {
            callId: call.callId,
            name: tool.alias,
            text: result.text,
            isError: result.isError,
            // 工具产出的图（生图）—— 给人看的，落进事件日志的只有相对路径
            images: result.images,
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
      // 中断与报错都落日志：这是"为什么停了"最直接的证据（用户手动停 / 超时 / 接口报错分开）
      runlog.log('turn.abort', {
        sessionId: session.id, aborted, steps,
        error: e && e.message ? String(e.message).slice(0, 400) : String(e),
        elapsedMs: Date.now() - turnStart,
      });
      sessionLib.appendEntry(session, aborted
        ? { type: 'interrupted' }
        : { type: 'error', message: e && e.message ? e.message : String(e), critical: true });
      this.emit(sessionEvent(session));
      this.emit({ type: 'turn:end', sessionId: session.id, aborted });
      return { ok: false, reason: aborted ? 'aborted' : 'error', message: e && e.message ? e.message : String(e) };
    } finally {
      this.running.delete(session.id);
      store.saveSession(session.projectId, session);
      // 回合统一收尾：浏览器窗口是这轮亮给用户看的，答完就收回去（只 hide，状态保留）
      try { tools.onTurnEnd(); } catch (_) { /* 收尾失败不影响回合结果 */ }
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
    // 界面上要据此显示"这个会话用的是兜底那份模型"，也让"普通会话不许切到它"能自证
    modelSource: session.modelSource || null,
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
