// 评审模式端到端：发一条会触发需要确认的命令，停在审批卡片前（供截图）。
// 第二个文件 eval-review-allow.js 负责点「允许一次」。
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
  // 会话级切到「每次询问」，这样一定会走到审批卡片
  await window.hatch.sessions.update({
    projectId: S.projectId,
    sessionId: S.sessionId,
    patch: { approvalMode: 'always-ask' },
  });
  log.sessionId = S.sessionId;

  document.getElementById('input').value = '把项目的依赖装一下（npm install），然后跑一遍测试。';
  await send();

  // 等审批卡片；低风险那几次自动放行（模型会先看目录再装依赖），
  // 一直等到出现「带评审意见」的那张卡片再停下——那张才是要给人看的。
  const modal = document.getElementById('approval-modal');
  const verdictBox = document.getElementById('approval-verdict');
  let waited = 0;
  let autoAllowed = 0;
  log.cards = [];
  for (; waited < 1800; waited++) {
    if (!modal.classList.contains('hidden')) {
      const cmd = document.getElementById('approval-cmd').textContent;
      const verdict = verdictBox.innerText.replace(/\n/g, ' | ');
      // 直接看 pendingApproval 上有没有 reviewer，比抠文案可靠
      const rev = S.pendingApproval && S.pendingApproval.reviewer;
      const hasReviewer = !!rev;
      log.cards.push({ cmd: cmd.slice(0, 90), hasReviewer, risk: rev && rev.risk, verdict: verdict.slice(0, 120) });
      if (hasReviewer) break;
      // 低风险那张：放行，让模型继续往下走
      document.getElementById('approval-allow').click();
      autoAllowed++;
      await sleep(600);
      continue;
    }
    if (!S.running && waited > 40) break;
    await sleep(200);
  }
  log.waitedSeconds = +(waited * 0.2).toFixed(1);
  log.autoAllowed = autoAllowed;
  log.modalOpen = !modal.classList.contains('hidden');
  log.title = document.getElementById('approval-title').textContent;
  log.sub = document.getElementById('approval-sub').textContent;
  log.cmd = document.getElementById('approval-cmd').textContent;
  log.verdict = verdictBox.innerText.replace(/\n/g, ' | ');
  return log;
})()
