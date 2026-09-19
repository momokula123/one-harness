// 打包树首跑探针：全新数据目录第一次启动，"用户第一眼看到的东西"必须是对的。
// 0.1.16 起始页 = 默认对话：新装用户开机就被领进 One Harness 专用会话，不用先建项目。
// 在打包树里跑（lo-recon/run-packaged-firstrun.cjs），断言走渲染层真实状态。
(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    rejections.push(String((e.reason && (e.reason.message || e.reason)) || e.reason));
  });
  const api = window.hatch;

  // 等 boot 完成（左栏入口出现 = init 走完）
  for (let i = 0; i < 100 && !document.getElementById('btn-open-settings'); i++) await wait(200);
  await wait(1200);

  // ① 开机自动进入了专用会话
  out.hasSession = !!S.session;
  out.programId = S.session && S.session.programId;
  out.modelSource = S.session && S.session.modelSource;
  out.inDefaultLlm = out.hasSession && out.programId === 'default-llm' && out.modelSource === 'fallback';

  // ② 默认项目被自动补上（不用用户先建项目）
  const projs = await api.projects.list();
  out.projectCount = projs.length;
  out.projectNames = projs.map((p) => p.name);
  out.autoProject = S.projectId && projs.some((p) => p.id === S.projectId);

  // ③ 界面上真的渲染出了对话。注意 `.empty` 类被两处复用：会话加载后的
  // "还没有消息。说点什么吧。"是正常空会话提示；要防的是"先选一个项目/还没有会话"
  // 那种把用户挡在门外的 stall。
  const empty = document.querySelector('#transcript .empty');
  out.emptyText = empty ? empty.textContent.trim() : '';
  out.noEmptyStall = !(empty && /选一个项目|还没有会话|先创建项目/.test(out.emptyText));

  // ④ 随包技能卡片数 = 技能库条数（第一眼的东西都在）
  const expected = await api.skills.list();
  document.getElementById('btn-open-settings').click();
  await wait(400);
  document.querySelector('#settings-nav .item[data-sec="skills"]').click();
  await wait(500);
  const cards = [...document.querySelectorAll('#settings-content .skill-card')];
  out.skillCount = expected.length;
  out.cardCount = cards.length;
  out.cardsMatchSkills = out.cardCount === out.skillCount && out.cardCount > 0;
  document.getElementById('btn-close-settings') &&
    document.getElementById('btn-close-settings').click();

  out.rejections = rejections;
  out.verdict = {
    '首跑：开机自动进入 One Harness 专用会话（programId=default-llm）': out.inDefaultLlm,
    '首跑：该会话走兜底模型（modelSource=fallback）': out.hasSession && out.modelSource === 'fallback',
    '首跑：默认项目被自动补上': out.autoProject,
    '首跑：起始页不是"先选项目"的空状态': out.noEmptyStall,
    '首跑：随包技能卡片数 = 技能库条数': out.cardsMatchSkills,
    '全程无未处理异常': rejections.length === 0,
  };

  if (!Object.values(out.verdict).every(Boolean)) {
    throw new Error('断言失败 ' + JSON.stringify(out.verdict) + ' :: ' + JSON.stringify(out));
  }
  return out;
})();
