// 评审模式端到端（放行版）：低风险的自动放行，遇到评审卡片点「允许一次」，
// 跑完整轮后展开工具卡，验证「闸门决定」那一行是否落到了卡片上。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = { steps: [] };

  for (let i = 0; i < 120; i++) {
    if (typeof S !== 'undefined' && S.programs && S.programs.length && document.getElementById('session-tabs')) break;
    await sleep(100);
  }

  let p = (S.projects || []).find((x) => x.name === '审批演示');
  if (!p) {
    p = await window.hatch.projects.create({ name: '审批演示' });
    S.projects = await window.hatch.projects.list();
  }
  S.projectId = p.id;
  renderProjectSelect();

  await createSession('omni');
  await window.hatch.sessions.update({
    projectId: S.projectId,
    sessionId: S.sessionId,
    patch: { approvalMode: 'always-ask' },
  });
  log.sessionId = S.sessionId;

  document.getElementById('input').value = '先看看当前目录有什么，然后把 lodash 装到项目里（npm install lodash），最后把结果告诉我。';
  await send();

  const modal = document.getElementById('approval-modal');
  const decisions = [];
  let ticks = 0;
  for (; ticks < 1800; ticks++) {
    if (!modal.classList.contains('hidden')) {
      const rev = S.pendingApproval && S.pendingApproval.reviewer;
      decisions.push({
        cmd: document.getElementById('approval-cmd').textContent.slice(0, 80),
        risk: (rev && rev.risk) || (S.pendingApproval && S.pendingApproval.risk) || '-',
        auth: rev && rev.authorization,
        correct: rev && rev.correct,
        steps: rev && rev.steps,
        sub: document.getElementById('approval-sub').textContent.slice(0, 90),
      });
      document.getElementById('approval-allow').click();
      await sleep(700);
      continue;
    }
    if (!S.running && ticks > 40) break;
    await sleep(200);
  }
  await sleep(1500);

  log.decisions = decisions;
  log.running = S.running;
  document.querySelectorAll('.tool').forEach((el) => el.classList.add('open'));
  await sleep(500);

  // 卡片里的「闸门决定」行
  log.decisionLines = Array.from(document.querySelectorAll('.tool-body .decision')).map((x) =>
    x.innerText.replace(/\s+/g, ' ').trim()
  );
  log.toolNames = Array.from(document.querySelectorAll('.tool .tool-name')).map((x) => x.textContent);
  log.summary = Array.from(document.querySelectorAll('.row.summary')).map((x) => x.innerText.replace(/\n/g, ' '));
  log.elicitation = Array.from(document.querySelectorAll('.row.elicitation')).map((x) => x.innerText.replace(/\s+/g, ' ').slice(0, 150));
  log.usage = (document.getElementById('usage-hint') || {}).textContent || '';
  return log;
})()
