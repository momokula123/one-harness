(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = { steps: [] };

  // 等界面 boot 完成
  for (let i = 0; i < 120; i++) {
    if (typeof S !== 'undefined' && S.programs && S.programs.length && document.getElementById('session-tabs')) break;
    await sleep(100);
  }
  log.steps.push('booted programs=' + S.programs.length + ' models=' + S.models.length);

  // 复用同名演示项目，避免每跑一次就堆一个
  let p = (S.projects || []).find((x) => x.name === '真模型演示');
  if (!p) {
    p = await window.hatch.projects.create({ name: '真模型演示' });
    S.projects = await window.hatch.projects.list();
  }
  S.projectId = p.id;
  await refreshSessions();
  log.steps.push('project=' + p.name + ' cwd=' + p.cwd);

  await createSession('omni');
  log.sessionId = S.sessionId;
  log.steps.push('session created');

  document.getElementById('input').value =
    '在当前目录下建一个 notes 文件夹，里面写一份 hello.md 说明文件（用 markdown，写 5 行左右），然后回读确认内容没问题。';
  await send();
  log.steps.push('message sent');

  let ticks = 0;
  for (; ticks < 900; ticks++) {
    if (!S.running) break;
    await sleep(200);
  }
  await sleep(1200);
  log.ranSeconds = +(ticks * 0.2).toFixed(1);
  log.running = S.running;

  // 展开所有工具卡，方便截图看到参数与输出
  document.querySelectorAll('.tool').forEach((el) => el.classList.add('open'));
  await sleep(400);

  log.toolCards = Array.from(document.querySelectorAll('.tool .tool-name')).map((x) => x.textContent);
  log.turns = Array.from(document.querySelectorAll('.row.summary')).map((x) => x.innerText.replace(/\n/g, ' '));
  log.transcript = S.transcript.length;
  log.meta = S.meta ? { entries: S.meta.entryCount, usage: S.meta.usage, chars: S.meta.chars } : null;
  log.usageHint = (document.getElementById('usage-hint') || {}).textContent || '';
  log.tabs = Array.from(document.querySelectorAll('.stab, .stab-list > *')).map((x) => x.innerText.replace(/\n/g, ' '));
  log.textHead = document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 700);
  return log;
})()
