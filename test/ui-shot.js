'use strict';
// 界面截图驱动：在页面里摆好某个状态，配合 HATCH_SHOOT 抓图。
//
//   HATCH_EVAL_FILE=test/ui-shot.js HATCH_UI_STATE=thread \
//   HATCH_SHOOT=docs/x.png node start.js
//
// HATCH_UI_STATE：
//   thread   打开消息最多的会话，工具卡全展开，消息操作图标常显（默认）
//   panel    同上，并把右栏拉开停在文件页
//   settings 弹出设置模态框（HATCH_UI_STATE=settings:<分区 id> 可指定停在哪个分区）
//   approval 弹出审批卡片（用假的评审结果，不花真模型调用）
//   menu     打开输入框「+」的新建会话菜单
//   geom     不抓观感，回报各块的实际几何（栏宽/居中是否生效）
//
// 返回值会打到 [eval] 那一行，方便断言。
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = (typeof HATCH_UI_STATE !== 'undefined' ? HATCH_UI_STATE : '') || 'thread';

  for (let i = 0; i < 60; i++) {
    if (typeof S !== 'undefined' && S.programs && S.programs.length && document.querySelector('#project-tree .node')) break;
    await wait(150);
  }

  // 挑会话：消息最多那个，图里内容才够看
  let best = null;
  for (const p of S.projects) {
    for (const s of S.tree[p.id] || []) if (!best || s.entryCount > best.s.entryCount) best = { p, s };
  }
  if (best) {
    if (best.p.id !== S.projectId) await setProject(best.p.id);
    await loadSession(best.s.id);
    await wait(600);
  }

  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.width)];
  };

  if (state === 'geom') {
    const row = document.querySelector('.row.assistant');
    return {
      win: [innerWidth, innerHeight],
      sideLeft: rect(document.getElementById('side-left')),
      mainCol: rect(document.getElementById('main-col')),
      row: rect(row),
      composerBox: rect(document.querySelector('.composer-box')),
      rowMaxW: row ? getComputedStyle(row).maxWidth : '-',
      rowMarginLeft: row ? getComputedStyle(row).marginLeft : '-',
    };
  }

  document.querySelectorAll('.tool').forEach((el) => el.classList.add('open'));
  document.querySelectorAll('.msg-actions').forEach((el) => el.classList.add('keep'));
  // 从头看：截图里能同时出现用户消息、正文和工具卡
  document.getElementById('transcript').scrollTop = 0;

  if (state === 'panel') {
    document.getElementById('app-root').classList.remove('no-right');
    switchPanel('files', { persist: false });
    document.getElementById('transcript').scrollTop = 0;
  }

  if (state === 'settings' || state.startsWith('settings:')) {
    const sec = state.includes(':') ? state.slice(state.indexOf(':') + 1) : 'general';
    openSettings(sec);
    await wait(400);
  }

  if (state === 'select' || state.startsWith('select:')) {
    const which = state.includes(':') ? state.slice(state.indexOf(':') + 1) : 'approval';
    if (which === 'model') openModelSelect();
    else openApprovalSelect();
    await wait(400);
  }

  if (state === 'approval') {
    document.getElementById('transcript').scrollTop = 0;
    showApproval({
      requestId: 'demo',
      tool: 'shell_command',
      reason: '评审子会话判定：这条命令会改动工作目录之外的文件，需要你确认。',
      args: { command: 'npm install lodash 2>&1; echo "EXIT=$LASTEXITCODE"', timeoutMs: 300000 },
      reviewer: {
        ok: true,
        risk: 'medium',
        authorization: 'not_required',
        correct: true,
        steps: 2,
        risk_reason: '命令里出现了工作目录之外的写入路径（..\\..\\package.json），并且会修改依赖锁文件。',
      },
    });
  }

  if (state === 'menu') {
    document.getElementById('transcript').scrollTop = 0;
    document.getElementById('btn-plus').click();
  }

  await wait(500);
  return {
    state,
    picked: best ? best.p.name + ' / ' + best.s.name : null,
    rows: document.querySelectorAll('.row').length,
    tools: document.querySelectorAll('.tool').length,
    treeNodes: document.querySelectorAll('#project-tree .node').length,
    activeNodes: document.querySelectorAll('#project-tree .node.sub.active').length,
    hasProjectNameInMeta: !!document.querySelector('.composer-meta .wd'),
    model: (document.getElementById('model-name') || {}).textContent,
    usage: (document.getElementById('usage-hint') || {}).textContent,
    pills: Array.from(document.querySelectorAll('#session-pills .pill')).map((x) => x.textContent),
    modal: !document.getElementById('approval-modal').classList.contains('hidden'),
    menuOpen: !document.getElementById('new-session-menu').classList.contains('hidden'),
    icons: document.querySelectorAll('[data-ic][data-ic-done]').length + '/' + document.querySelectorAll('[data-ic]').length,
  };
})();
