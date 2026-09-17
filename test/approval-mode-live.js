// 「运行中切换审批模式」专项回归。跑法： node test/run-approval-mode.js
//
// 用户报的现象：会话跑着的时候改审批模式，界面提示弹了、图标也换了，
// 但接下来的工具调用仍然按老模式走 —— 看起来"切了没生效"。
// 根因在主进程：chat:send 把 loadSession() 出来的**一份内存对象**交给 runTurn，
// 而 sessions:update 会**再从磁盘 load 一份新对象**去改、去存盘；于是跑着的那一轮
// 读到的还是老对象（gate() 每次现读 session.approvalMode，读的就是老对象）。
//
// 为什么必须配桩模型（runner 会起）：这条 bug 只在"用户改模式"发生在
// "下一次工具调用过闸门"之前的时间窗里才暴露，而真模型/演示服务什么时候发下一个
// 工具调用不受我们控制。桩端点每次响应前固定等 HATCH_APPROVAL_DELAY 毫秒，把窗口撑开。
// 本脚本不关心端口：端点地址由 runner 写进 data/settings.json，这里只读出来校验。
(async () => {
  const api = window.hatch;
  const $id = (i) => document.getElementById(i);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const V = {};
  const fails = [];
  const R = {};
  const check = (name, cond, extra) => {
    V[name] = !!cond;
    if (!cond) fails.push(name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  };
  const until = async (fn, ms = 60000, step = 250) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await fn()) return true; } catch (_) {}
      await wait(step);
    }
    return false;
  };
  const running = () => !$id('btn-stop').classList.contains('hidden');
  const cardOpen = () => !$id('approval-modal').classList.contains('hidden');
  const rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    rejections.push(String((e.reason && (e.reason.message || e.reason)) || e.reason));
  });

  // 闸门决定事件里带着 reason —— 那就是"这次是按哪个模式判的"的直接证据
  const decisions = [];
  api.events.onAgentEvent((ev) => {
    if (ev && ev.type === 'approval:decision') {
      decisions.push({ tool: ev.tool, action: ev.action, reason: ev.reason });
    }
  });

  // 走真实界面路径（点触发器 → 点条目）切审批模式，和用户的操作一致
  const pickMode = async (v) => {
    const sel = '#sel-pop .sel-item[data-v="' + v + '"]';
    $id('approval-select').click();
    if (!(await until(() => !!document.querySelector(sel), 5000, 120))) return false;
    document.querySelector(sel).click();
    await wait(500);
    return true;
  };

  const st = await api.settings.get();
  R.endpoint = st.model.baseUrl;
  check('N0 端点指向桩模型（否则本测试没有判别力）',
    /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(String(st.model.baseUrl)), st.model.baseUrl);

  const proj = (await api.projects.list())[0];
  $id('btn-tab-new').click();                      // 走界面新建会话，保证 S.sessionId 与之一致
  await wait(1500);
  const cur = (await api.sessions.list(proj.id))[0];
  R.sessionId = cur && cur.id;
  check('N1 新会话建出来并挂到界面上了', !!cur && $id('session-tabs').querySelectorAll('.stab').length >= 1, R.sessionId);
  if (!cur) throw new Error('建会话失败 :: ' + JSON.stringify(R));

  // 会话级模式从会话详情里读（sessions:list 只回列表用的摘要，不带 approvalMode）
  const modeOf = async () => {
    const r = await api.sessions.load({ projectId: proj.id, sessionId: cur.id });
    return r && r.meta && r.meta.approvalMode;
  };

  await pickMode('always-ask');
  const mode1 = await modeOf();
  check('N2 审批模式已切到「每次询问」（界面路径）', mode1 === 'always-ask', mode1);

  $id('input').value = '用 shell 跑一条命令：echo HATCH_APPROVAL_MODE_PROBE';
  $id('btn-send').click();

  const asked1 = await until(cardOpen, 45000);
  check('N3 前置：第一张审批卡弹出来了（否则下面几条是空跑）', asked1, { decisions });
  if (asked1) R.card1 = $id('approval-cmd').textContent;

  if (asked1) {
    $id('approval-allow').click();                 // 批准 → 这一轮继续跑
    await wait(300);
    check('N4 批准后这一轮还在跑（测试前提：改模式发生在运行中）', running(), { running: running() });

    // —— 关键动作：这一轮**跑着**的时候把模式改成「自动放行」——
    R.switched = await pickMode('auto');
    const mode2 = await modeOf();
    check('N5 运行中把模式改成了「自动放行」（界面与落盘都变了）', mode2 === 'auto', mode2);

    // 下一次工具调用应按新模式自动放行：不弹卡，而且闸门理由变成「自动模式」
    const asked2 = await until(cardOpen, 12000);
    check('N6 切完模式后不再弹第二张卡（老代码这里会弹）', asked2 === false, { decisions: decisions.slice(-5) });
    const auto = decisions.filter((d) => d.reason === '自动模式');
    check('N7 后续工具调用确实按新模式判的（闸门理由 = 自动模式）', auto.length > 0, { auto, all: decisions });
    check('N7b 那一次决定的动作是放行', auto.length > 0 && auto[auto.length - 1].action === 'allow', auto.slice(-1));

    if (running()) $id('btn-stop').click();        // 桩模型永远要求工具调用，得手动收尾
    await until(() => !running(), 15000);
  } else {
    check('N3 前置：第一张审批卡弹出来了', false);
  }

  R.decisions = decisions;
  R.rejections = rejections;
  check('N8 全程没有未处理异常', rejections.length === 0, rejections);

  if (fails.length) throw new Error('失败 ' + fails.length + ' 项 :: ' + fails.join(' | ') + ' :: 数据 ' + JSON.stringify(R).slice(0, 1500));
  return { 通过: Object.keys(V).length, 数据: R };
})();
