// 在【打包树】里验 0.1.11 / 0.1.12 这几轮新增的东西（出包清单第 5 步）。
//
// 为什么不能只看开发态：开发目录里跑绿说明不了包里有什么 —— 包内 app/package.json 是裁剪过的、
// 路径是 exe 相对的、随包资源（config/、skills/）要靠 APP_ROOT 才读得到。历史上就出过
// "文件名承诺的功能、包里没有"（0.1.0 那个包里压根没有引擎）。
//
// 这里断言的全是"**用户装上之后第一眼/第一次动**就会碰到的东西"：
//   ① 工具名录：生图工具 generate_image 真的注册上了（不是"文件在包里但没接上"）
//   ② 包内 config/{model,image}.json 被 exe 真的读出来了（512K 上下文、生图模型名）
//   ③ 设置 → 兜底模型里那张「思考强度」控件在不在、候选是不是内核给的 7 档
//   ④ One Harness 专用会话：建出来带 modelSource=fallback；普通会话传参塞不进去
//   ⑤ ★ 左栏底部（「设置」上方）那个固定入口：在不在、在不在设置上方、
//      点它真能进去、而且不会每点一次多建一个会话、进去后点亮（回普通会话又灭）
//
// 返回形状按跑分器的契约：对象里有 verdict（全布尔），任一为假就 throw → [eval] failed。
(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $id = (i) => document.getElementById(i);
  const rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    rejections.push(String((e.reason && (e.reason.message || e.reason)) || e.reason));
  });

  for (let i = 0; i < 100 && !$id('btn-open-settings'); i++) await wait(200);
  await wait(600);                       // 等 boot 里的设置/技能落地

  // ---- ② 工具名录：生图工具必须真在包里，且真的注册上了 ----
  out.tools = (S.catalog || []).map((t) => t.name || t.alias || '');
  out.hasImageTool = out.tools.includes('generate_image');

  // ---- ② 出厂两套配置：包内 config/*.json 被 exe 真的读出来了 ----
  const s = await api.settings.get();
  out.fallback = s.fallback;
  out.llmModel = (s.fallback && s.fallback.llm && s.fallback.llm.model) || '';
  out.imageModel = (s.fallback && s.fallback.image && s.fallback.image.model) || '';
  out.ctxLen = s.fallback && s.fallback.llm && s.fallback.llm.contextLength;
  out.reasoningLevels = S.reasoningLevels || [];

  // ---- ③ 思考强度控件：在界面上存在，候选 = 内核下发的表（界面没自己抄一份字面值）----
  openSettings('fallback');
  await wait(500);
  const rBtn = $id('fb-llm-reasoning');
  out.hasReasonBtn = !!rBtn;
  if (rBtn) {
    out.reasonCurrent = rBtn.dataset.v;
    rBtn.click();
    await wait(400);
    out.reasonItems = [...document.querySelectorAll('#sel-pop .sel-item')].map((e) => e.dataset.v);
    if (typeof closeSelect === 'function') closeSelect();
    await wait(200);
  }
  const imgInput = $id('fb-image-model');
  out.imageCardModel = imgInput ? imgInput.value : null;
  out.llmCardModel = $id('fb-llm-model') ? $id('fb-llm-model').value : null;
  out.ctxCard = $id('fb-llm-ctx') ? $id('fb-llm-ctx').value : null;
  closeSettings();
  await wait(400);

  // ---- ④ 专用会话 ----
  out.programs = (S.programs || []).map((p) => p.id + (p.modelSource ? '(' + p.modelSource + ')' : ''));

  // 文件夹对话框被跑分器桩到 HATCH_PICK_FOLDER 指的那个目录，走接口直接建一个工程出来
  const dir = await api.projects.pickFolder();
  const proj = await api.projects.create({ name: 'pkg-probe-012', cwd: dir });
  await setProject(proj.id);
  await wait(800);

  const pin = await api.sessions.create({ projectId: proj.id, programId: 'default-llm', name: 'One Harness' });
  const pinLoaded = await api.sessions.load({ projectId: proj.id, sessionId: pin.session.id });
  out.pinModelSource = (pinLoaded.session || {}).modelSource;
  out.pinProgram = (pinLoaded.session || {}).programId;

  // 反向对照：普通预设 + 偷偷塞一个 modelSource 进去 → 必须被无视
  const sneaky = await api.sessions.create({ projectId: proj.id, programId: 'omni', name: '偷塞', modelSource: 'fallback' });
  const sneakyLoaded = await api.sessions.load({ projectId: proj.id, sessionId: sneaky.session.id });
  out.sneakyModelSource = (sneakyLoaded.session || {}).modelSource;

  // 菜单里**不该**再有这个入口（0.1.13 起：专用会话只由左栏底部那一个入口代表）。
  // 这条 0.1.12 时是反过来的（当时菜单里挂着一条）—— 用户拍板"不要重复"后撤掉了。
  if (typeof showNewSessionMenu === 'function') {
    showNewSessionMenu();
    await wait(400);
    out.menuLabels = [...document.querySelectorAll('#new-session-menu .pop-item')].map((e) => e.innerText.trim());
    out.menuHasPinned = out.menuLabels.some((t) => /One Harness|专用会话/.test(t));
    if (typeof hideNewSessionMenu === 'function') hideNewSessionMenu();
    await wait(200);
  }

  // ---- ④b 模型名单：出厂端点只让选 config 里声明的那几个（0.1.13）----
  // 端点 /v1/models 实测回 12 个（旧的 2.0/2.1/2.5 系 + 收费的 pro 系 + video），
  // 菜单里全列出来等于让用户自己去猜哪个能用。名单由随包 config/*.json 的 `models` 定。
  out.allowModels = await api.models.list({});

  // ---- ⑤ 左栏底部那个固定入口（0.1.12）----
  // 先制造"当前不在专用会话里"的局面：切回一个普通会话。不这么做，后面的"点亮"断言
  // 可能因为一开始就在专用会话里而恒真。
  const foot = $id('btn-default-session');
  const setRow = $id('btn-open-settings');
  out.footFound = !!foot;
  out.footText = foot ? foot.innerText.trim() : null;
  out.footAbove = !!(foot && setRow &&
    foot.parentElement === setRow.parentElement &&
    (foot.compareDocumentPosition(setRow) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);

  const ordinary = (await api.sessions.list(proj.id)).find((x) => x.programId !== 'default-llm');
  if (ordinary) { await loadSession(ordinary.id); await wait(700); }
  out.footOffInOrdinary = foot ? !foot.classList.contains('on') : null;

  const nBefore = (await api.sessions.list(proj.id)).length;
  if (foot) { foot.click(); await wait(1300); }
  const nAfter = (await api.sessions.list(proj.id)).length;
  out.footOpened = !!(S.session && S.session.modelSource === 'fallback');
  out.footNoDup = nAfter === nBefore;
  out.footLit = foot ? foot.classList.contains('on') : null;

  // ---- ⑤b 重复问题（0.1.13）：同名胶囊只能一枚；左栏列表里不列专用会话 ----
  // 0.1.12 的实际样子（真产物截图）：胶囊行是 ["One Harness","One Harness","可写"]，
  // 左栏还多一条同名的会话条目 —— 用户看到的就是"重复"。
  out.pills = [...document.querySelectorAll('#session-pills .pill')].map((e) => e.textContent.trim());
  out.pillsSameName = out.pills.filter((t) => t === 'One Harness').length;
  out.treeSubs = [...document.querySelectorAll('#project-tree .sub')].map((e) => e.textContent.trim());
  out.programLabel = ((S.programs || []).find((p) => p.id === 'default-llm') || {}).label;

  out.verdict = {
    '包内工具名录含 generate_image（工具真进包并注册）': out.hasImageTool,
    '包内 config/model.json 生效（兜底 LLM 有模型名）': !!out.llmModel,
    '包内 config/image.json 生效（生图模型名带 agnes-image）': /agnes-image/.test(out.imageModel),
    '兜底 LLM 上下文 = 512K（524288）': out.ctxLen === 524288,
    '内核下发了思考强度取值表（7 档）': out.reasoningLevels.length === 7,
    '★ 设置→兜底模型里有「思考强度」控件': out.hasReasonBtn,
    '候选 =「跟出厂值」+ 内核那 7 档（界面照表画，没自己编）':
      Array.isArray(out.reasonItems) && out.reasonItems[0] === '' &&
      JSON.stringify(out.reasonItems.slice(1)) === JSON.stringify(out.reasoningLevels),
    '兜底卡片里显示的模型名来自包内配置（语言模型 / 生图各一份）':
      out.llmCardModel === out.llmModel && out.imageCardModel === out.imageModel,
    '程序预设里有 default-llm(fallback)': out.programs.includes('default-llm(fallback)'),
    '★ 专用会话建出来带 modelSource=fallback': out.pinModelSource === 'fallback',
    '★ 反向对照：普通会话塞不进 modelSource（切不过去）': out.sneakyModelSource === null,
    '「新建会话」菜单里有 One Harness 这一项': out.menuHasPinned === true,
    '★「新建会话」菜单里**没有**它（入口只剩左栏底部那一个）': out.menuHasPinned === false,
    '★ 模型名单 = 随包 config 声明的两个（不是端点列出的 12 个）':
      JSON.stringify((out.allowModels || {}).models) === JSON.stringify(['agnes-3.0-flash', 'agnes-image-2.5-flash']),
    '★ 同名胶囊只有一枚（预设那枚叫「默认模型」，不再撞名）':
      out.pillsSameName === 1 && out.programLabel === '默认模型',
    '★ 左栏会话列表里不列专用会话（它只由底部入口代表）':
      Array.isArray(out.treeSubs) && !out.treeSubs.includes('One Harness'),
    '★ 左栏底部有固定入口，文字就是 One Harness':
      out.footFound === true && out.footText === 'One Harness',
    '★ 它在「设置」上方（同级 + DOM 顺序在前）': out.footAbove === true,
    '★ 点它真进专用会话，且没有多建一个（有就打开）':
      out.footOpened === true && out.footNoDup === true,
    '进去后点亮；在普通会话里是灭的（反向对照）':
      out.footLit === true && out.footOffInOrdinary === true,
    '全程无未处理异常': rejections.length === 0,
  };
  out.rejections = rejections;
  if (!Object.values(out.verdict).every(Boolean)) {
    throw new Error('断言失败 ' + JSON.stringify(out.verdict) + ' :: ' + JSON.stringify(out));
  }
  return out;
})();
