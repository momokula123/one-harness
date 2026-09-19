// 全功能巡检：从界面真实入口把每个功能点走一遍，能上真模型的地方就上真模型。
// 用法： node test/run-ui.js test/features.js
// 前置： 本机模型端点在跑（默认 127.0.0.1:8787），否则 C 段会整段失败。
(async () => {
  const api = window.hatch;
  const $id = (i) => document.getElementById(i);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 进度打点都带"距开始多少秒"：一眼就能看出时间被哪一段吃掉了
  // （实测 D 段走公网真模型时一段就 100s+，光看段名看不出来）。
  const T0 = Date.now();
  const prog = (label) => console.log('[prog] +' + ((Date.now() - T0) / 1000).toFixed(1) + 's ' + label);
  const V = {};
  const fails = [];
  const R = {};
  const check = (name, cond, extra) => {
    V[name] = !!cond;
    if (!cond) fails.push(name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  };
  const until = async (fn, ms = 15000, step = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await fn()) return true; } catch {}
      await wait(step);
    }
    return false;
  };
  const running = () => !$id('btn-stop').classList.contains('hidden');
  const transcriptText = () => $id('transcript').innerText;
  const rows = () => [...document.querySelectorAll('#transcript .row')];

  const rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    rejections.push(String((e.reason && (e.reason.message || e.reason)) || e.reason));
  });

  // ============ Z0. 起始页 = 默认对话（0.1.16：新用户开机直接被领进能用的会话） ============
  prog("Z0. 起始页 = 默认对话");
  {
    const st0 = S.session && S.session.programId === 'default-llm' && S.session.modelSource === 'fallback';
    check('Z0a 开机自动进入了 One Harness 专用会话（programId=default-llm）',
      st0, S.session ? { programId: S.session.programId, modelSource: S.session.modelSource } : '没有会话');
    const projs0 = await api.projects.list();
    check('Z0b 开机自动补了默认项目（不用用户先去建项目）',
      S.projectId && projs0.some((p) => p.id === S.projectId), { projectId: S.projectId, n: projs0.length });
  }

  // ============ A. 新建项目对话框（用户报的那个 bug） ============
  prog("A. 新建项目对话框（用户报的那个 bug）");
  $id('btn-new-project').click();
  await wait(500);
  check('A1 起名对话框会弹出', !$id('project-modal').classList.contains('hidden'));
  check('A2 名称框预填目录名', $id('project-name-input').value === 'probe-proj', $id('project-name-input').value);
  $id('project-cancel').click();
  await wait(400);
  check('A3 取消后对话框关闭', $id('project-modal').classList.contains('hidden'));

  // ============ B. 布局与面板 ============
  prog("B. 布局与面板");
  const uiBefore = await api.ui.state();
  const noRightBefore = $id('app-root').classList.contains('no-right');
  $id('btn-toggle-right').click();
  await wait(500);
  const uiAfter = await api.ui.state();
  check(
    'B1 右栏折叠状态真的落盘了',
    uiAfter.window.workspace.rightPanelIsCollapsed === !noRightBefore,
    { before: noRightBefore, saved: uiAfter.window.workspace.rightPanelIsCollapsed, was: uiBefore.window.workspace.rightPanelIsCollapsed }
  );

  $id('btn-toggle-left').click();
  await wait(500);
  const uiAfter2 = await api.ui.state();
  check('B2 左栏折叠状态真的落盘了', uiAfter2.window.workspace.leftSidebarIsCollapsed === true);
  $id('btn-toggle-left').click();
  await wait(400);

  for (const t of ['browser', 'files', 'skills', 'tools']) {
    const tab = document.querySelector(`.tab[data-tab="${t}"]`);
    tab.click();
    await wait(350);
    check(`B3 右栏「${t}」页签能切`, !$id('panel-' + t).classList.contains('hidden'));
  }
  check('B3b 右栏四页：浏览器/文件/技能/工具（设置已搬去模态框，新增内置浏览器）',
    document.querySelectorAll('#side-right .tab').length === 4);

  const toolRows = document.querySelectorAll('#panel-tools .field').length;
  R.toolRows = toolRows;
  check('B4 工具面板列出了已注册工具', toolRows >= 10, toolRows);

  const skillItems = document.querySelectorAll('#skill-chips .chip').length;
  R.skillItems = skillItems;
  check('B5 技能面板列出了技能', skillItems >= 1, skillItems);

  // ============ C. 会话生命周期 ============
  prog("C. 会话生命周期");
  const proj = (await api.projects.list())[0];
  await api.sessions.update({ projectId: proj.id, sessionId: null, patch: {} }).catch(() => null);
  const sessBefore = (await api.sessions.list(proj.id)).length;

  $id('btn-tab-new').click();
  await wait(1200);
  const sessAfter = await api.sessions.list(proj.id);
  check('C1 顶栏「+」能新建会话', sessAfter.length === sessBefore + 1, { before: sessBefore, after: sessAfter.length });
  check('C2 新会话出现在标签栏', document.querySelectorAll('#session-tabs .stab').length >= 1);

  const sid = sessAfter[0].id;
  const renamed = await api.sessions.rename({ projectId: proj.id, sessionId: sid, name: '巡检-重命名' });
  check('C3 会话能重命名', (await api.sessions.list(proj.id)).some((s) => s.name === '巡检-重命名'), renamed);

  // 当前会话（真模型要用的那个）
  let cur = (await api.sessions.list(proj.id)).find((s) => s.name === '巡检-重命名');
  check('C4 会话详情能读回', !!cur);

  // ============ D. 真模型：一轮工具调用 ============
  prog("D. 真模型：一轮工具调用");
  await api.sessions.update({ projectId: proj.id, sessionId: cur.id, patch: { approvalMode: 'auto' } });
  $id('input').value = '在工作目录下创建文件 notes/sweep.md，内容写一行 SWEEP_OK，然后读回来确认内容。';
  $id('btn-send').click();
  await wait(1200);
  // 运行时发送按钮是 disabled（不是隐身），停止按钮才显出来
  check('D1 运行时出现「停止」且发送按钮禁用', running() && $id('btn-send').disabled, {
    running: running(), sendDisabled: $id('btn-send').disabled,
  });

  const done = await until(() => !running(), 30000);
  check('D2 一轮能在 3 分钟内跑完', done);
  R.turnText = transcriptText().slice(0, 1200);

  check('D3 助手回复了文本', rows().some((r) => r.classList.contains('assistant') && r.innerText.trim().length > 0));
  const toolCards = document.querySelectorAll('#transcript .tool');
  R.toolCards = toolCards.length;
  check('D4 有工具卡（至少 2 次调用：写 + 读）', toolCards.length >= 2, toolCards.length);
  check('D5 没有工具报错', !document.querySelector('#transcript .tool.error, #transcript .tool.fail'), null);

  // 用量明细以前只藏在 `title` 的原生 tooltip 里（要悬停才看得见），现在全部铺在这一行上。
  // 断言的就是**看得见的文本**：容量 + 占比 + 上次输入→输出 + 本轮次数与合计，四样都得在。
  // 文案是量出来的（全称写法 457px > 这一行剩下的 392px，必折行），所以横排用最短写法，
  // 完整说明挂在每段的 title 上——这里同时也断言那段 title 真的存在。
  const hintEl = $id('usage-hint');
  const usage = hintEl.textContent;
  R.usage = usage;
  check('D6 用量统计有真实数字', /上下文\s*[\d.,]+万?\//.test(usage), usage);
  check('D6b 容量与占比直接显示在这一行', /\/[\d.,]+万?\s*\(\d+%\)/.test(usage), usage);
  check('D6c 上次输入→输出直接显示在这一行', /上次 \d+→\d+/.test(usage), usage);
  check('D6d 本轮次数与合计直接显示在这一行', /本轮 \d+ 次 共 [\d.,]+万?/.test(usage), usage);
  check('D6e 用量不再只靠悬停 tooltip（usage-hint 上不该还有 title）', !hintEl.hasAttribute('title'));
  const gTips = [...hintEl.querySelectorAll('.g')].map((e) => e.title);
  check('D6e2 每段都有自己的完整说明（悬停看得到全称）', gTips.length === 3 && gTips.every((t) => t && t.length > 8), gTips);

  // 项目名已从这一行撤掉（跟左栏项目树重复，用户要求去掉），宽度让给用量明细。
  // 这条是"移除类"断言：谁哪天又把它加回来（或留个空壳），当场红。
  check('D6e3 这一行不再显示当前项目名（跟左栏重复）',
    !document.getElementById('composer-wd') && !document.querySelector('.composer-meta .wd'),
    { byId: !!document.getElementById('composer-wd'), byClass: !!document.querySelector('.composer-meta .wd') });

  // 铺开之后不许把这一行撑破、也不许折成两行
  // （整块 flex:none，空间不够时先压 spacer；行内各块高度不同，比较 top 要留 3px 容差）
  const metaEl = document.querySelector('.composer-meta');
  const metaBox = metaEl.getBoundingClientRect();
  const pillsEl = $id('session-pills');
  const tops = [pillsEl, hintEl].map((e) => Math.round(e.getBoundingClientRect().top));
  const pillsBox = pillsEl.getBoundingClientRect();
  R.usageLine = {
    text: usage, w: Math.round(hintEl.getBoundingClientRect().width),
    overflow: Math.round(hintEl.getBoundingClientRect().right - metaBox.right),
    lineSpread: Math.max(...tops) - Math.min(...tops),
    overlapsPills: Math.round(hintEl.getBoundingClientRect().left - pillsBox.right) < 0,
    pills: [...pillsEl.children].map((e) => e.textContent),
  };
  check('D6f 用量行没溢出、没折行、也没压到会话标签上',
    R.usageLine.overflow <= 0 && R.usageLine.lineSpread <= 3 && R.usageLine.overlapsPills === false, R.usageLine);
  // D6f2：程序预设标签必须跟着"实际模块"走。
  // 用户报的原话："我发现 omni 不会根据设置进行自动更新" —— 会话的 programId 一直是 omni，
  // 但模块集被改过之后，标签以前还写死显示 "Omni"。这里真的去设置里关掉一个模块，
  // 断言标签变成「自定义」且悬停说明列出被关的是哪个，再开回来确认恢复成预设名。
  {
    const pillText = () => [...$id('session-pills').children].map((e) => e.textContent);
    const modsBefore = JSON.stringify((S.meta && S.meta.modules) || []);
    const before = pillText();
    openSettings('sessions');
    await wait(600);
    const chips = [...document.querySelectorAll('#module-chips .chip')];
    // 优先挑"联网抓取/搜索"来关（后面的断言不依赖它），挑不到才用第一个
    const chip = chips.find((c) => /联网/.test(c.textContent)) || chips.find((c) => c.classList.contains('on'));
    const chipName = chip ? chip.textContent.trim() : null;
    R.progPill = { before, chipName, chips: chips.length };
    if (chip) chip.click();
    await wait(1000);
    const after = pillText();
    R.progPill.after = after;
    R.progPill.tip = ([...$id('session-pills').children][0] || {}).title;
    check('D6f2 在设置里关掉一个模块后，预设标签变成「自定义」',
      after[0] === '自定义' && before[0] !== '自定义', R.progPill);
    check('D6f2b 「自定义」的悬停说明列出了被关掉的模块',
      !!R.progPill.tip && R.progPill.tip.indexOf(String(chipName).replace(/（\d+）$/, '')) >= 0, R.progPill.tip);
    // 恢复：再点一次把模块开回来（别把"文件读写"这类关键模块留在关闭状态，后面还有真模型回合）
    const chip2 = [...document.querySelectorAll('#module-chips .chip')].find((c) => c.textContent.trim() === chipName);
    if (chip2) chip2.click();
    await wait(1000);
    const restored = pillText();
    R.progPill.restored = restored;
    check('D6f2c 模块开回来后标签恢复成预设名，模块集也回到原样',
      restored[0] === before[0] && JSON.stringify((S.meta && S.meta.modules) || []) === modsBefore,
      { restored, modsBefore, now: (S.meta && S.meta.modules) || [] });
    closeSettings();
    await wait(300);
  }

  // D6g：把这一行**压到真实窗口的宽度**（用户窗口 1118 时这里只有 495px），再塞一组最坏数字
  // （六位数输入、三位数次调用、总 token 上百万）。断言它仍然单行、不溢出。
  // 这条是防回归的关键：`flex-wrap: wrap` 会让明细掉到第二行；把明细设成可压缩又会把它挤没。
  {
    const keepHtml = hintEl.innerHTML;
    const keepMax = metaEl.style.maxWidth;
    metaEl.style.maxWidth = '495px';
    hintEl.innerHTML =
      '<span class="g">上下文 16.3万/100万 (16%)</span><span class="s">·</span>' +
      '<span class="g">上次 163123→4521</span><span class="s">·</span>' +
      '<span class="g">本轮 108 次 共 123.5万</span>';
    await wait(120);
    const mb = metaEl.getBoundingClientRect();
    const hb = hintEl.getBoundingClientRect();
    const pb = $id('session-pills').getBoundingClientRect();
    const spread = Math.max(pb.top, hb.top) - Math.min(pb.top, hb.top);
    R.usageNarrow = {
      rowW: Math.round(mb.width), usageW: Math.round(hb.width), pillsW: Math.round(pb.width),
      overflow: Math.round(hb.right - mb.right), lineSpread: Math.round(spread),
      overlapsPills: Math.round(hb.left - pb.right) < 0,
    };
    check('D6g 压到 495px + 最坏数字下依然单行不溢出、也不压标签',
      R.usageNarrow.lineSpread <= 3 && R.usageNarrow.overflow <= 0 && R.usageNarrow.overlapsPills === false,
      R.usageNarrow);
    metaEl.style.maxWidth = keepMax;
    hintEl.innerHTML = keepHtml;
    await wait(60);
  }

  const cwd = proj.cwd;
  const readBack = await api.fs.readText({ projectId: proj.id, sessionId: cur.id, absPath: cwd + '\\notes\\sweep.md' });
  R.readBack = { ok: readBack.ok, text: (readBack.text || '').slice(0, 120), error: readBack.error };
  check('D7 模型写的文件真落盘了', readBack.ok && /SWEEP_OK/.test(readBack.text || ''));

  // 右栏文件预览
  const filesTab = document.querySelector('.tab[data-tab="files"]');
  filesTab.click();
  await wait(400);
  const fileItem = [...document.querySelectorAll('#panel-files .file-item')].find((el) => /sweep\.md/.test(el.innerText));
  check('D8 右栏文件列表里有这个文件', !!fileItem);
  if (fileItem) {
    fileItem.click();
    await wait(900);
    check('D9 点文件能预览内容', /SWEEP_OK/.test($id('panel-files').innerText));
  }

  const cps = await api.checkpoints.list(proj.id);
  R.checkpoints = cps.length;
  check('D10 检查点已记录', cps.length >= 1, cps.length);

  // ============ E. 回滚（真点界面上的按钮，不走 IPC） ============
  prog("E. 回滚（真点界面上的按钮，不走 IPC）");
  // 注意：会话条目用的是 {type:'message', role:'user'}，kind 只存在于渲染后的行对象里
  const loaded = await api.sessions.load({ projectId: proj.id, sessionId: cur.id });
  const entries = (loaded.session && loaded.session.entries) || [];
  const userEntries = (es) => es.filter((e) => e.type === 'message' && e.role === 'user');
  R.entryCount = entries.length;
  check('E1 会话事件链可读', userEntries(entries).length >= 1, { entries: entries.length, types: [...new Set(entries.map((e) => e.type))] });

  const rollbackBtn = [...document.querySelectorAll('#transcript .msg-actions button')].find((b) => /回滚/.test(b.title || ''));
  check('E2 用户消息下方有「回滚到这条消息之前」按钮', !!rollbackBtn, [...document.querySelectorAll('#transcript .msg-actions button')].map((b) => b.title));
  if (rollbackBtn) {
    rollbackBtn.click();
    await wait(1500);
    R.rollbackToast = [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent);
    const after = await api.fs.readText({ projectId: proj.id, sessionId: cur.id, absPath: cwd + '\\notes\\sweep.md' });
    check('E3 回滚把 agent 新建的文件删掉了', !after.ok, { read: after, toast: R.rollbackToast });
  } else {
    check('E3 回滚把 agent 新建的文件删掉了', false);
  }

  // ============ E4/E5. 改动记录面板：每个文件一行；「恢复」连点两次不能报错 ============
  prog("E4/E5. 改动记录面板：每个文件一行；「恢复」连点两次不能报错");
  // 用户报的 bug：恢复之后再点一次「恢复」→ 右上角 "操作失败：Error invoking remote method
  // 'checkpoints:revertFile': The "path" argument must be of type string. Received null"。
  // 根因有两层：① 内核 revertFile 取"最后一条记录"，而恢复动作自己也写一条 kind:'restored'、
  // sha:null 的日志，它被当 blob 文件名喂给 path.join → 抛；② 面板把**原始日志行**铺成列表，
  // 于是同一个文件出现多行、其中还有"恢复动作本身"那一行也带「恢复」按钮。
  document.querySelector('.tab[data-tab="files"]').click();
  await wait(700);
  const fRows = [...document.querySelectorAll('#panel-files .file-item')];
  const shownPaths = fRows.map((r) => r.querySelector('.path').title);
  check('E4 改动记录每个文件只占一行（不再按日志行铺）', fRows.length > 0 && new Set(shownPaths).size === shownPaths.length, shownPaths);
  check('E4b 列表里没有「恢复动作本身」那种行', fRows.length > 0 && !fRows.some((r) => /restored/.test(r.innerText)), fRows.map((r) => r.innerText.replace(/\n/g, ' ')));

  const rejBeforeE = rejections.length;
  const restoreOnce = async () => {
    const row = [...document.querySelectorAll('#panel-files .file-item')][0];
    const btn = row && [...row.querySelectorAll('button')].find((b) => /恢复/.test(b.textContent));
    if (!btn) return null;
    btn.click();
    await wait(1400);
    const ts = [...document.querySelectorAll('#toasts .toast')];
    const last = ts[ts.length - 1];
    return last ? { text: last.textContent, err: last.classList.contains('err') } : null;
  };
  const t1 = await restoreOnce();
  const t2 = await restoreOnce();          // ← 修复前：第二次点击必抛（restored 记录 + sha null）
  R.restoreToasts = [t1, t2];
  check('E5 「恢复」连点两次都有结果、都不是错误提示、也没有未处理异常',
    !!t1 && !!t2 && t1.err === false && t2.err === false && rejections.length === rejBeforeE,
    { t1, t2, rejected: rejections.slice(rejBeforeE) });

  // ============ F. 审批拦截（always-ask） ============
  prog("F. 审批拦截（always-ask）");
  await api.sessions.update({ projectId: proj.id, sessionId: cur.id, patch: { approvalMode: 'always-ask' } });
  $id('input').value = '用 shell 执行命令 echo HATCH_APPROVAL_TEST';
  $id('btn-send').click();
  const asked = await until(() => !$id('approval-modal').classList.contains('hidden'), 15000);
  check('F1 高风险命令弹出了审批卡', asked);

  if (asked) {
    R.approvalCmd = $id('approval-cmd').textContent;
    R.approvalSub = $id('approval-sub').textContent;
    R.verdictPills = [...document.querySelectorAll('#approval-verdict .pill')].map((el) => el.textContent.trim());
    check('F2 审批卡展示了命令原文', /echo/.test(R.approvalCmd), R.approvalCmd.slice(0, 120));
    check('F3 审批卡至少给出风险等级', R.verdictPills.length >= 1, R.verdictPills);
    $id('approval-note').value = '巡检：故意拒绝';
    $id('approval-deny').click();
    await wait(800);
    const finished = await until(() => !running(), 20000);
    check('F4 拒绝后这一轮能正常收尾', finished);
    check('F5 会话里留下了拒绝记录', /拒绝|已拦截|deny/.test(transcriptText()));
  } else {
    check('F2 审批卡展示了命令原文', false);
    check('F3 审批卡至少给出风险等级', false);
    check('F4 拒绝后这一轮能正常收尾', false);
    check('F5 会话里留下了拒绝记录', false);
  }

  // ============ F2. 非低风险调用：必须走评审子会话并给出三轴 ============
  prog("F2. 非低风险调用：必须走评审子会话并给出三轴");
  // 探针用写文件（write_file，中风险）：它一定不是 low，「每次询问」下必然先过评审。
  // （早先试过让模型跑危险 shell 命令，模型却先自己执行 Test-Path 探测，风险变成 low，探针失效）
  $id('input').value = '再在工作目录写一个文件 notes/from-approval.md，内容一行 APPROVAL_OK。';
  $id('btn-send').click();
  const asked2 = await until(() => !$id('approval-modal').classList.contains('hidden'), 15000);
  check('F6 中风险调用在「每次询问」下弹出审批卡', asked2);
  if (asked2) {
    R.cmd2 = $id('approval-cmd').textContent.slice(0, 200);
    R.pills2 = [...document.querySelectorAll('#approval-verdict .pill')].map((el) => el.textContent.trim());
    R.sub2 = $id('approval-sub').textContent;
    R.reviewerNote = $id('approval-verdict').innerText;
    check('F7 卡片给出了风险等级', R.pills2.length >= 1, R.pills2);
    check('F8 高风险走了评审子会话（风险/授权/语法三轴齐全）', R.pills2.length >= 3, R.pills2);
    $id('approval-note').value = '巡检：拒绝写这个文件';
    $id('approval-deny').click();
    await wait(800);
    // 拒绝之后这一轮必须能收尾。注意：内核会告诉模型"不要重试同样的命令"，
    // 但模型仍可能换个写法再申请一次——那不是卡死，是正常行为。
    // 所以边等边把新弹出的卡也拒掉（最多 3 次），3 次之后还在跑才判失败。
    // 失败时把证据一起存下来：modalOpen=true 说明"还在等用户回答"，
    // 一张卡都没有却还在跑，才是运行状态自己卡住了（真 bug）。
    let denies = 1;
    let settled = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (running() === false) { settled = true; break; }
      const cardOpen = !$id('approval-modal').classList.contains('hidden');
      if (cardOpen && denies < 3) {
        denies += 1;
        $id('approval-note').value = '巡检：再次拒绝';
        $id('approval-deny').click();
      }
      await wait(500);
    }
    check('F9 拒绝后收尾正常', settled, {
      denies,
      modalOpen: !$id('approval-modal').classList.contains('hidden'),
      stopVisible: running(),
      lastRows: rows().slice(-4).map((r) => ({ cls: r.className, text: r.innerText.slice(0, 70) })),
    });
    const wrote = await api.fs.readText({ projectId: proj.id, sessionId: cur.id, absPath: proj.cwd + '\\notes\\from-approval.md' });
    check('F10 被拒绝的写入没有落盘', !wrote.ok, wrote);
  } else {
    check('F7 卡片给出了风险等级', false);
    check('F8 非低风险走了评审子会话（风险/授权/语法三轴齐全）', false);
    check('F9 拒绝后收尾正常', false);
    check('F10 被拒绝的写入没有落盘', false);
  }

  // ============ G. 分叉（优先走界面上的按钮） ============
  prog("G. 分叉（优先走界面上的按钮）");
  // 消息下方的动作是悬停图标：.msg-actions 里 data-ic=undo(回滚) / copy(复制) / branch(分叉)
  await api.sessions.update({ projectId: proj.id, sessionId: cur.id, patch: { approvalMode: 'reviewer' } });
  const actionBtn = (re) => [...document.querySelectorAll('#transcript .msg-actions button')].filter((b) => re.test(b.title || ''));
  const beforeFork = (await api.sessions.list(proj.id)).length;
  const forkBtns = actionBtn(/分叉/);
  const rbBtns = actionBtn(/回滚/);
  R.actionTitles = [...document.querySelectorAll('#transcript .msg-actions button')].map((b) => b.title);
  check('G0 用户消息下方有「回滚」和「从这里分叉」按钮', rbBtns.length >= 1 && forkBtns.length >= 1, R.actionTitles);
  if (forkBtns.length) {
    forkBtns[0].click();
    await wait(1500);
    check('G1 界面上「从这里分叉」能建出新会话', (await api.sessions.list(proj.id)).length === beforeFork + 1, { before: beforeFork });
  } else {
    check('G1 界面上「从这里分叉」能建出新会话', false, '没找到分叉按钮');
  }

  // ============ H. 删除会话 ============
  prog("H. 删除会话");
  const listNow = await api.sessions.list(proj.id);
  const doomed = listNow.find((s) => s.name === '巡检-重命名');
  if (doomed) {
    await api.sessions.remove({ projectId: proj.id, sessionId: doomed.id });
    await wait(500);
    check('H1 会话能删除', !(await api.sessions.list(proj.id)).some((s) => s.id === doomed.id));
  } else {
    check('H1 会话能删除', false, '找不到待删会话');
  }

  // ============ I. 设置读写 ============
  prog("I. 设置读写");
  const s0 = await api.settings.get();
  const s1 = await api.settings.save({ model: { contextLength: 32768 } });
  const s2 = await api.settings.get();
  check('I1 设置能保存并读回', s2.model.contextLength === 32768, { before: s0.model.contextLength, after: s2.model.contextLength });
  await api.settings.save({ model: { contextLength: s0.model.contextLength } });

  // ============ L. 设置模态框（入口在左下角，照 Bionic 的位置） ============
  prog("L. 设置模态框（入口在左下角，照 Bionic 的位置）");
  // 老实现是右栏里一页竖排长表单：一个「保存并应用」按钮同时读 6 个分区、11 个字段，
  // 且在「模型端点」标题下面 —— 用户改了「审批」里的东西根本不知道该不该按它。
  // 现在拆成「左分类栏 + 每分区各自保存」，这里把这条不变量钉住。
  {
    const setBefore = await api.settings.get();
    const $sec = (id) => document.querySelector(`#settings-nav .item[data-sec="${id}"]`);

    check('L1 左下角有设置入口', !!$id('btn-open-settings'));
    $id('btn-open-settings').click();
    await wait(400);
    check('L2 点左下角入口开的是模态框（不再去动右栏）', !$id('settings-modal').classList.contains('hidden'));

    const nav = {
      groups: [...document.querySelectorAll('#settings-nav .grp')].map((e) => e.textContent.trim()),
      items: [...document.querySelectorAll('#settings-nav .item')].map((e) => e.dataset.sec),
      rightTabs: [...document.querySelectorAll('#side-right .tab')].map((e) => e.dataset.tab),
      rightOpen: !$id('app-root').classList.contains('no-right'),
    };
    R.settingsNav = nav;
    check('L3 分类栏按 Bionic 的分组来（设置/集成两组）', nav.groups.length === 2 && nav.items.includes('general') && nav.items.includes('skills'), nav);
    check('L4 右栏不再有「设置」页签', !nav.rightTabs.includes('settings'), nav.rightTabs);

    // 切分区：内容跟着换
    const generalText = $id('settings-content').innerText.slice(0, 30);
    $sec('appearance').click();
    await wait(300);
    check('L5 切到「外观」分区内容跟着换',
      !!$id('set-left-w') && $id('settings-content').innerText.slice(0, 30) !== generalText,
      { active: ($sec('appearance') || {}).className });

    // 核心不变量：每个分区只存自己那组字段
    openSettings('general');
    await wait(300);
    $id('set-temp').value = '0.55';
    $id('btn-save-general').click();
    await wait(700);

    openSettings('sessions');
    await wait(300);
    // 审批模式现在是自绘下拉（按钮触发器 + .sel-pop 浮层），没有 .value 可以写，
    // 所以这里走真实交互：点触发器 → 点条目
    $id('set-approval').click();
    await wait(300);
    const picked = document.querySelector('#sel-pop .sel-item[data-v="always-ask"]');
    check('L5b 设置里的下拉能点开并出现条目', !!picked, { items: document.querySelectorAll('#sel-pop .sel-item').length });
    if (picked) picked.click();
    await wait(300);
    const triggerLabel = ($id('set-approval').querySelector('.sel-label') || {}).textContent;
    check('L5c 选完触发器上显示的是新档位', triggerLabel === '每次询问', { triggerLabel });
    $id('btn-save-approval').click();
    await wait(700);
    const stA = await api.settings.get();
    check('L6 「会话」分区存下了审批模式', stA.approval.mode === 'always-ask', stA.approval.mode);
    check('L7 「会话」分区保存不会把温度带回旧值', stA.model.temperature === 0.55, stA.model.temperature);

    openSettings('general');
    await wait(300);
    $id('set-temp').value = '0.4';
    $id('btn-save-general').click();
    await wait(700);
    const stB = await api.settings.get();
    check('L8 「常规」分区保存不会覆盖「会话」分区的值（老实现是一个按钮管六个分区）',
      stB.approval.mode === 'always-ask' && stB.model.temperature === 0.4,
      { mode: stB.approval.mode, temp: stB.model.temperature });

    // 关掉的三条路径：关闭按钮 / 遮罩 / Esc
    $id('settings-close').click();
    await wait(250);
    const closed1 = $id('settings-modal').classList.contains('hidden');
    openSettings('general');
    await wait(250);
    $id('settings-modal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(250);
    const closed2 = $id('settings-modal').classList.contains('hidden');
    openSettings('general');
    await wait(250);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(250);
    const closed3 = $id('settings-modal').classList.contains('hidden');
    check('L9 关闭按钮 / 点遮罩 / Esc 三条路都能关', closed1 && closed2 && closed3, { closed1, closed2, closed3 });

    // 模态框里的控件不能有缺 id 的（缺了就绑不上）
    openSettings('general');
    await wait(250);
    const noId = [...document.querySelectorAll('#settings-nav .item, #settings-content input, #settings-content select, #settings-content button')].filter((e) => !e.id && !e.dataset.sec);
    check('L10 设置里的控件都有 id（缺 id 就绑不上事件）', noId.length === 0, noId.map((e) => e.outerHTML.slice(0, 60)));
    closeSettings();
    await wait(250);

    // 还原：别把巡检改的值留给后面的用例
    await api.settings.save({
      model: { temperature: setBefore.model.temperature },
      approval: { mode: setBefore.approval.mode },
    });
  }

  // ============ O. 兜底模型：思考强度可调 + One Harness 专用会话 ============
  prog("O. 兜底模型：思考强度可调 + One Harness 专用会话");
  // 对应三句话：① 思考强度要在「设置 → 兜底模型」里能调；② 自带模型单独一个会话专用，
  // 普通会话用不了它；③ 左栏「设置」上方要有一个**固定**入口进那个会话。
  // 三句都得在**界面上**有落点，所以这一段全走真实点击/真实 IPC。
  {
    const ordinary = (await api.sessions.list(proj.id)).find((s) => s.programId !== 'default-llm');
    await loadSession(ordinary.id);
    await wait(400);
    const fb = (S.settings.fallback || {}).llm || {};
    const fbName = fb.model;

    // ---- O1~O3 兜底卡片里那一档「思考强度」 ----
    openSettings('fallback');
    await wait(400);
    const fbBtn = $id('fb-llm-reasoning');
    check('O1 兜底模型里有「思考强度」控件（可调）', !!fbBtn, fbBtn ? '' : '没找到 #fb-llm-reasoning');
    const fbReason = fb.reasoning || '';
    check('O2 它显示的就是当前生效的那一档',
      !!fbBtn && fbBtn.dataset.v === fbReason && fbBtn.textContent.includes(fbReason === 'none' ? '不思考' : fbReason),
      fbBtn && fbBtn.dataset.v + ' / ' + fbBtn.textContent);
    fbBtn.click();
    await wait(300);
    const reasonItems = [...document.querySelectorAll('#sel-pop .sel-item')].map((e) => e.dataset.v);
    check('O3 候选 =「跟出厂值」+ 内核下发的全部合法取值（界面没自己编字面值）',
      reasonItems[0] === '' && reasonItems.length === S.reasoningLevels.length + 1 &&
        JSON.stringify(reasonItems.slice(1)) === JSON.stringify(S.reasoningLevels),
      JSON.stringify(reasonItems));
    check('O3b 对照：候选确实不是空的（不是"空下拉"式的假绿）', reasonItems.length > 1, reasonItems.length);
    closeSelect();
    closeSettings();
    await wait(300);

    // ---- O4~O6 普通会话里，兜底模型**不是**可切换的目标 ----
    // 造出最危险的那个情形：端点列表里就有这个模型名 + 用户确实配了自己的端点。
    // 此时下拉若还塞一条"切换到这个模型"，用户点了会以为切好了 —— 其实改的是全局设置。
    const savedOwn = { ...S.settings.modelOwn };
    S.models = [fbName, 'zz-inspector-model'];       // 模拟 /v1/models 里确实有兜底那个名字
    S.settings = await api.settings.save({ model: { baseUrl: 'http://127.0.0.1:9/v1', model: 'zz-inspector-model' } });
    $id('model-select').click();
    await wait(300);
    const mItems = [...document.querySelectorAll('#sel-pop .sel-item')].map((e) => ({ v: e.dataset.v, d: e.title }));
    check('O4 普通会话的模型下拉里有别的模型（探针有区分度，不是空下拉）',
      mItems.some((x) => x.v === 'zz-inspector-model'), JSON.stringify(mItems.map((x) => x.v)));
    check('O5 ★ 里面没有"把兜底模型切到这个会话"这一项', !mItems.some((x) => x.v === fbName), JSON.stringify(mItems));
    // 这一条 2026-09-19 反过来了：下拉里以前额外挂了一条「…（One Harness）」，
    // 用户拍板"默认会话就是下面那个，不要重复" —— 现在入口只留左栏底部那一个。
    check('O6 ★ 也没有"打开专用会话"那条入口（入口只剩左栏底部一个）',
      !mItems.some((x) => x.v === '@default-llm'), JSON.stringify(mItems.filter((x) => x.v === '@default-llm')));
    closeSelect();
    S.settings = await api.settings.save({ model: savedOwn });   // 还原：别把巡检造的假端点留下来
    S.models = [];
    await wait(300);

    // ---- O7~O12 专用会话从**唯一的那个入口**（左栏底部固定项）建出来 ----
    // 以前这里走的是「新建会话」菜单，因为那时菜单里挂着一条。用户拍板"不要重复"之后
    // 菜单里那条已经撤掉，所以 O7 现在反过来断言它不在了。
    const sessBefore2 = (await api.sessions.list(proj.id)).length;
    showNewSessionMenu();
    await wait(300);
    const menuItems = [...document.querySelectorAll('#new-session-menu .pop-item')];
    check('O7 ★「新建会话」菜单里**没有**专用会话这一项（入口只有左栏底部那一个）',
      !menuItems.some((e) => /专用会话|One Harness/.test(e.innerText)),
      JSON.stringify(menuItems.map((e) => e.innerText.trim())));
    hideNewSessionMenu();
    await wait(200);
    $id('btn-default-session').click();
    await wait(1500);

    const list2 = await api.sessions.list(proj.id);
    const pinnedMeta = list2.find((s) => s.programId === 'default-llm');
    check('O8 专用会话真的建出来了', !!pinnedMeta, JSON.stringify(list2.map((s) => s.programId)));
    // O9 的本意是"点入口不会重复建一堆"。0.1.16 起始页=默认对话之后，开机时专用会话
    // 就已经建好了（本项目在 init 里被 openDefaultSession 自动领进去），这里点入口走的是
    // 判重复用（+0），所以断言从"恰好新建一个"改成"专用会话恰好一个、总数没有失控"。
    check('O9 它没有把别的会话搞多（专用会话恰好一个，总数最多 +1）',
      list2.filter((s) => s.programId === 'default-llm').length === 1 &&
        list2.length <= sessBefore2 + 1 && !!pinnedMeta,
      { before: sessBefore2, after: list2.length, pinned: list2.filter((s) => s.programId === 'default-llm').length });
    const loadedPin = pinnedMeta ? await api.sessions.load({ projectId: proj.id, sessionId: pinnedMeta.id }) : {};
    check('O10 ★ 内核给这个会话打上了 modelSource=fallback（端点整组走兜底）',
      (loadedPin.session || {}).modelSource === 'fallback', JSON.stringify((loadedPin.session || {}).modelSource));
    check('O11 界面上模型 chip 显示的是兜底那份模型',
      $id('model-name').textContent === fbName, $id('model-name').textContent);
    check('O12 顶栏有「One Harness」这枚标签，说明这个模型是从哪儿来的',
      $id('session-pills').innerText.includes('One Harness'), $id('session-pills').innerText);
    // O12b：同名胶囊只能有一枚。2026-09-19 真产物截图里这里是 **两枚一模一样的
    // 「One Harness」**（程序预设那枚 + 专用会话标记那枚，label 撞名了）——
    // 用户看到的就是"重复"。程序预设的 label 已改回「默认模型」。
    const pillTexts = [...document.querySelectorAll('#session-pills .pill')].map((e) => e.textContent.trim());
    check('O12b ★ 同名胶囊只有一枚（程序预设那枚叫「默认模型」，不再跟它撞名）',
      pillTexts.filter((t) => t === 'One Harness').length === 1 && pillTexts.includes('默认模型'),
      JSON.stringify(pillTexts));

    // ---- O13/O14 专用会话里模型是锁死的；同一动作在普通会话里必须是有反应的 ----
    $id('model-select').click();
    await wait(300);
    const popInPin = $id('sel-pop');
    const pinnedNoPop = !popInPin || popInPin.classList.contains('hidden');
    check('O13 ★ 点它不会弹出可切换的模型下拉（这个会话的模型改不了）',
      pinnedNoPop, popInPin && popInPin.className);

    await loadSession(ordinary.id);
    await wait(400);
    $id('model-select').click();
    await wait(300);
    const popInOwn = $id('sel-pop');
    const ownHasPop = !!popInOwn && !popInOwn.classList.contains('hidden') && popInOwn.querySelectorAll('.sel-item').length > 0;
    closeSelect();
    check('O14 反向对照：同样一次点击在普通会话里是**会**弹的 —— 证明 O13 不是探针失灵',
      ownHasPop, popInOwn && popInOwn.className);
    await wait(300);

    // ---- O15~O20 左栏底部那个固定入口（用户要求：固定在「设置」上方，常驻） ----
    // 这一组测的是"入口本身"，和 O7~O12 那条菜单路径是两个入口、同一件事 ——
    // 所以这里既能验它真的通，也能验"有就打开、不再多建一个"这条语义。
    const foot = $id('btn-default-session');
    check('O15 ★ 左栏底部有固定的 One Harness 入口', !!foot, foot ? '' : '没找到 #btn-default-session');
    check('O16 它就在「设置」的**上方**，两者同级',
      !!foot && !!$id('btn-open-settings') &&
        foot.parentElement === $id('btn-open-settings').parentElement &&
        !!(foot.compareDocumentPosition($id('btn-open-settings')) & Node.DOCUMENT_POSITION_FOLLOWING),
      foot && foot.className);
    check('O17 此刻在普通会话里，它是未点亮态', !!foot && !foot.classList.contains('on'), foot && foot.className);

    const sessBefore3 = (await api.sessions.list(proj.id)).length;
    foot.click();
    await wait(1200);
    const list3 = await api.sessions.list(proj.id);
    check('O18 ★ 点它就是进专用会话，且**不会**每点一次多建一个（有就打开）',
      !!S.session && S.session.modelSource === 'fallback' && list3.length === sessBefore3,
      { modelSource: S.session && S.session.modelSource, before: sessBefore3, after: list3.length });
    check('O19 进去之后这个入口点亮了（表示"当前就在它里面"）',
      foot.classList.contains('on'), foot.className);

    await loadSession(ordinary.id);
    await wait(400);
    check('O20 反向对照：回到普通会话后它又灭了 —— 证明 O19 不是"一直是 on"',
      !foot.classList.contains('on'), foot.className);
    // O21：左栏会话列表里**不该**再出现专用会话那一条（用户："默认会话就是下面那个，不要重复"）。
    // 它列在树里时跟底部入口看着像两样东西，用户会去删其中一个。
    const treeSubs = [...document.querySelectorAll('#project-tree .sub')].map((e) => e.textContent.trim());
    check('O21 ★ 左栏会话列表里没有专用会话那一条（它只由底部那个入口代表）',
      !treeSubs.includes('One Harness'), JSON.stringify(treeSubs));
    await wait(300);

    // ---- O22~O26 专用会话里、输入框正上方那两个按钮 ----
    // 用户要的：进这个会话后，输入框上方并排两个按钮，左边"配置自定义模型"、右边"绘图"；
    // 点它们**在对话里回一句话**（不是 toast）。
    const ctBox = $id('chat-tools');
    check('O22 普通会话里这对按钮是隐藏的（反向对照，证明不是"一直显示"）',
      !!ctBox && ctBox.classList.contains('hidden'), ctBox && ctBox.className);
    check('O23 左栏那个入口的悬停提示只剩「基础对话」这一句',
      foot.title === '基础对话', foot.title);

    foot.click();
    await wait(1000);
    const ctA = ctBox && ctBox.children[0];
    const ctB = ctBox && ctBox.children[1];
    const ra = ctA && ctA.getBoundingClientRect();
    const rb = ctB && ctB.getBoundingClientRect();
    const rIn = $id('input').getBoundingClientRect();
    check('O24 ★ 进专用会话后两个按钮露出来，且并排横放在输入框上方（左起第一个是「配置自定义模型」）',
      !!ctBox && !ctBox.classList.contains('hidden') &&
        !!ctA && ctA.id === 'ct-config-model' &&
        !!ctB && ctB.id === 'ct-draw' &&
        !!ra && !!rb &&
        ra.right <= rb.left + 1 &&                        // 左 → 右 并排
        Math.abs(ra.top - rb.top) <= 2 &&                 // 同一行（不是上下两行）
        ctBox.getBoundingClientRect().bottom <= rIn.top + 1, // 整体在输入框上面
      ctBox && ctBox.className);

    const rowsBefore = document.querySelectorAll('#transcript .row').length;
    $id('ct-config-model').click();
    await wait(400);
    let rows = [...document.querySelectorAll('#transcript .row')];
    let last = rows[rows.length - 1];
    check('O25 ★ 「配置自定义模型」在对话里回一条**助手样式**的消息（不是灰底系统条）',
      rows.length === rowsBefore + 1 && !!last && last.classList.contains('assistant') &&
        !!last.querySelector('.meta') && last.textContent.includes('自定义模型在「设置 → 常规」里填'),
      last ? last.textContent.slice(0, 60) : '(没有新行)');

    $id('ct-draw').click();
    await wait(400);
    rows = [...document.querySelectorAll('#transcript .row')];
    last = rows[rows.length - 1];
    check('O26 ★ 「绘图」也在对话里回一条助手样式的消息，文案指路',
      rows.length === rowsBefore + 2 && !!last && last.classList.contains('assistant') &&
        last.textContent.includes('可以对我说') &&
        last.textContent.includes('帮我生成一个海边的小狗 4K 16:9'),
      last ? last.textContent.slice(0, 80) : '(没有新行)');

    await loadSession(ordinary.id);
    await wait(400);
  }

  // ============ K. 运行状态按会话记账（老代码会永久卡死的那个） ============
  prog("K. 运行状态按会话记账（老代码会永久卡死的那个）");
  // 老实现用一个全局布尔 S.running，而 agent:event 是按会话过滤的。
  // 于是：在会话 A 发消息 → 切到 B → A 这一轮结束（turn:end 被过滤丢掉）
  // → 切回 A，S.running 还是 true：发送键永久禁用，点停止也不会再有事件来复位。
  // 内核的锁本来就是 per-session 的，界面必须同构。
  {
    const kA = (await api.sessions.list(proj.id))[0];
    const rB = await api.sessions.create({ projectId: proj.id, programId: 'omni', name: '巡检-切走切回' });
    const kB = rB.session;

    await loadSession(kA.id);
    await wait(400);
    handleAgentEvent({ type: 'turn:start', sessionId: kA.id });
    const disabledWhenRunning = $id('btn-send').disabled;

    await loadSession(kB.id); // 切走
    await wait(400);
    const sendOkOnOther = !$id('btn-send').disabled;

    // 我们"不在场"的时候，kA 那一轮结束了：这个事件按会话过滤，老代码会直接丢掉
    handleAgentEvent({ type: 'turn:end', sessionId: kA.id });

    await loadSession(kA.id); // 切回
    await wait(400);
    const sendOkBack = !$id('btn-send').disabled;

    check('K1 当前会话在跑时发送键禁用', disabledWhenRunning === true, { disabledWhenRunning });
    check('K2 切到别的会话后发送不受影响（运行状态是 per-session 的）', sendOkOnOther === true, { sendOkOnOther });
    check('K3 切走期间结束的那一轮，切回来不能把发送键卡死', sendOkBack === true, { sendOkBack });
    R.perSessionRunning = { disabledWhenRunning, sendOkOnOther, sendOkBack };
  }

  // ============ J. 跨项目标签：关标签不能拿别的项目的会话 id 去加载 ============
  prog("J. 跨项目标签：关标签不能拿别的项目的会话 id 去加载");
  // 标签栏是**所有项目共用**的一条数组（pane.tabs），而界面上只画当前项目的标签。
  // 用户真实数据里 active 停在 A 项目的标签上，切到 B 项目后关掉 B 自己的标签，
  // 旧逻辑拿 pane.tabs[active] 当"下一个" → 拿到 A 的会话 id → 报「会话不存在：xxx」。
  {
    const projA = proj;
    const projB = await api.projects.create({ name: '巡检-跨项目B', cwd: null });
    const sessA = (await api.sessions.list(projA.id))[0];
    const rB = await api.sessions.create({ projectId: projB.id, programId: 'omni', name: 'B 的会话' });
    const sessB = rB.session;

    // 手工摆出"跨项目标签 + active 停在别的项目标签上"的局面
    const pane = tabsPane();
    pane.tabs.push(tabIdFor(projA.id, sessA.id));
    pane.tabInstanceIds.push('tab-it-a');
    pane.tabs.push(tabIdFor(projB.id, sessB.id));
    pane.tabInstanceIds.push('tab-it-b');
    pane.active = pane.tabs.length - 2; // 陈旧：停在 A 的标签上
    persistTabs(pane);

    await setProject(projB.id, { sessionId: sessB.id });
    await wait(800);
    const rejBefore = rejections.length;

    closeTab(sessB.id);
    await wait(1400);

    check('J1 跨项目标签下关标签不再报「会话不存在」', rejections.length === rejBefore, rejections.slice(rejBefore));
    check(
      'J2 关完没串到别的项目的会话上',
      S.projectId === projB.id && S.sessionId === null,
      { projectId: String(S.projectId).slice(0, 8), sessionId: S.sessionId }
    );
    R.jCrossProject = { tabsAfter: tabsPane().tabs.length, active: tabsPane().active, sessionId: S.sessionId };
  }

  // ============ N-2. 右栏内置浏览器 + 带行号的文本视图 ============
  prog("N-2. 右栏内置浏览器 + 带行号的文本视图");
  // 用户要的：右栏换成内置浏览器（照 Bionic）；会话里点文件名则切到"带行号"的文本视图。
  {
    const r = {};
    // ① 页签与面板
    r.tabs = [...document.querySelectorAll('#side-right .tab')].map((t) => t.dataset.tab);
    check('N-2a 右栏第一页是「浏览器」（照 Bionic，其余保留）',
      r.tabs[0] === 'browser' && r.tabs.includes('files'), r.tabs);
    check('N-2b 原来的「资料」标题条已移除（纯冗余）',
      !document.querySelector('#side-right .bar .section-title'), true);
    check('N-2c 地址栏与四个控件都在',
      ['bw-url', 'bw-back', 'bw-fwd', 'bw-reload', 'bw-open'].every((id) => !!$id(id)));

    // ② 地址归一化（纯函数，覆盖面最广的一条）
    r.toUrl = {
      域名: toUrl('example.com'),
      已带协议: toUrl('https://a.b/c'),
      盘符: toUrl('C:\\Windows\\win.ini'),
      unix: toUrl('/tmp/a.txt'),
      localhost: toUrl('localhost:3000'),
      搜索词前缀: toUrl('随便搜点啥').slice(0, 30),
    };
    check('N-2d 地址归一化：域名补 http、协议原样、本地路径转 file://、其余走搜索',
      r.toUrl.域名 === 'http://example.com' && r.toUrl.已带协议 === 'https://a.b/c' &&
      r.toUrl.盘符 === 'file:///C:/Windows/win.ini' && r.toUrl.unix === 'file:///tmp/a.txt' &&
      r.toUrl.localhost === 'http://localhost:3000' && /bing\.com\/search/.test(r.toUrl.搜索词前缀),
      r.toUrl);

    // ③ 真加载一个本机 HTML，并从 guest 里把内容读回来（证明是"真渲染"，不是只有一个空元素）
    // 探针页由 run-ui.js 写在 test/.tmp-ui/ 下；这里从**应用自身的 URL** 反推工程根目录
    // （location.href 就是 …/hatch/renderer/index.html），不需要额外传参。
    const appUrl = location.href;                                  // file:///…/hatch/renderer/index.html
    const rootUrl = appUrl.replace(/\/renderer\/index\.html.*$/, '');
    const probeHtml = rootUrl + '/test/.tmp-ui/bw-probe.html';
    check('N-2e0 从应用 URL 推出了探针页地址（推不出来后面就是空跑）', /bw-probe\.html$/.test(probeHtml), { appUrl, probeHtml });
    openInBrowser(probeHtml);
    await wait(3200);
    const v = document.querySelector('#bw-stage webview');
    r.viewExists = !!v;
    check('N-2e 浏览器视图被创建出来', !!v);
    if (v) {
      try { r.guestText = String(await v.executeJavaScript('document.body ? document.body.innerText : ""')).trim().slice(0, 40); } catch (e) { r.guestErr = e.message.slice(0, 80); }
      r.guestURL = (() => { try { return v.getURL(); } catch (e) { return null; } })();
      check('N-2f ★ guest 真的渲染了页面（读到了页面里的文字）',
        /内置浏览器加载成功/.test(r.guestText || ''), { text: r.guestText, err: r.guestErr });
      check('N-2g guest 的 URL 与请求一致', /bw-probe\.html$/.test(r.guestURL || ''), r.guestURL);
    }
    check('N-2h 地址栏回填了当前地址', /bw-probe\.html$/.test($id('bw-url').value), $id('bw-url').value);
    check('N-2i 没弹"打不开"的错误提示', !$id('bw-error'));

    // ④ 换地址走 loadURL 路径（不是 src），确认前进/后退那套也能用
    openInBrowser('file:///C:/Windows/win.ini');
    await wait(2200);
    let after = null;
    try { after = v.getURL(); } catch (e) {}
    check('N-2j 切到另一个地址也能载入（loadURL 路径通）', /win\.ini$/i.test(after || ''), after);

    // ⑤ 关掉浏览器视图不该报错（切回文件页）
    switchPanel('files');
    await wait(300);
    check('N-2k 能切回「文件」页', !$id('panel-files').classList.contains('hidden'));
    switchPanel('browser', { persist: false });
    await wait(200);
    // ⑥ 点正文里的文件名 → 右栏打开（用户报的"点击后右侧浏览器打不开"）
    //    关键覆盖两种写法：绝对路径、以及**只有文件名**的相对路径（模型最常这么写）。
    const b = r;
    const rootFileUrl = location.href.replace(/\/renderer\/index\.html.*$/, '');
    const rootWin = decodeURI(rootFileUrl.replace(/^file:\/\/\//, '').replace(/\//g, '\\'));
    const absHtml = rootWin + '\\renderer\\index.html';
    check('N-2l 靶子文件存在（应用自身的 index.html）', (await api.fs.readText({ absPath: absHtml })).ok, absHtml);

    openLink(absHtml);                       // ① 绝对路径
    await wait(2600);
    let u2 = '';
    try { u2 = v.getURL(); } catch (e) {}
    check('N-2m 点绝对路径 .html → 右栏浏览器打开它', S.panel === 'browser' && /index\.html$/.test(u2), { panel: S.panel, guest: u2 });

    // ② 相对文件名：靠检查点记录里的绝对路径兜底（模拟"模型刚生成的文件"）
    S.files = (S.files || []).concat([{ path: absHtml, kind: 'modified', changes: 1 }]);
    openLink('index.html');
    await wait(2600);
    let u3 = '';
    try { u3 = v.getURL(); } catch (e) {}
    check('N-2n ★ 只给文件名（相对路径）也能打开 —— 旧代码在这里什么都不做',
      S.panel === 'browser' && /index\.html$/.test(u3), { panel: S.panel, guest: u3, 地址栏: $id('bw-url').value });
    S.files = S.files.filter((f) => f.path !== absHtml);

    // ③ 行号视图必须**留得住**：以前 renderFiles() 把 panel 的 innerHTML 清空，
    //    连带把行号视图一起删掉（用户报的"行号也没了"）。现在两者是各自独立的容器。
    switchPanel('files');
    await wait(300);
    await previewFile(absHtml);
    await wait(500);
    const beforeRefresh = document.querySelectorAll('#file-viewer .tv-row').length;
    refreshFiles();                          // 触发一次列表重画（就是它以前会清掉视图）
    await wait(700);
    const afterRefresh = document.querySelectorAll('#file-viewer .tv-row').length;
    r.tvRowsBefore = beforeRefresh;
    r.tvRowsAfter = afterRefresh;
    check('N-2o ★ 列表刷新后行号视图还在（两者是独立容器，不再互相覆盖）',
      beforeRefresh > 10 && afterRefresh === beforeRefresh, { before: beforeRefresh, after: afterRefresh });
    check('N-2p 行号从 1 开始且与文件行数一致',
      (document.querySelector('#file-viewer .tv-n') || {}).textContent === '1', (document.querySelector('#file-viewer .tv-n') || {}).textContent);
    const tvClose = $id('tv-close');
    if (tvClose) tvClose.click();
    await wait(200);
    check('N-2q 能关掉行号视图', !$id('file-viewer'));

    // ④ 右栏默认停在「文件」（用户指定），且文件按类型给不同图标
    const uiNow = await api.ui.state();
    r.savedView = uiNow.window.workspace.devRightPanelView;
    check('N-2r 右栏默认页是「文件」', r.savedView === 'files', r.savedView);
    // 类型判定：给一串扩展名，必须分到不同的图标（不能全是通用 file）
    const map = {
      'a.html': fileIconFor('a.html'), 'b.js': fileIconFor('b.js'), 'c.py': fileIconFor('c.py'),
      'd.json': fileIconFor('d.json'), 'e.md': fileIconFor('e.md'), 'f.txt': fileIconFor('f.txt'),
      'g.png': fileIconFor('g.png'), 'h.xyz': fileIconFor('h.xyz'), 'noext': fileIconFor('noext'),
    };
    r.fileIcons = map;
    check('N-2s 网页/代码/数据/文档/图片各有各的图标',
      map['a.html'] === 'file-web' && map['b.js'] === 'file-code' && map['c.py'] === 'file-code' &&
      map['d.json'] === 'file-data' && map['e.md'] === 'file-text' && map['f.txt'] === 'file-text' &&
      map['g.png'] === 'file-image',
      map);
    check('N-2t 认不出的扩展名/无扩展名退回通用图标（不硬猜）',
      map['h.xyz'] === 'file' && map['noext'] === 'file', { xyz: map['h.xyz'], noext: map['noext'] });
    check('N-2u 每个类型图标都真的在 ICONS 里（否则注水后是空白）',
      Object.values(map).every((n) => !!ICONS[n]), Object.values(map).filter((n) => !ICONS[n]));

    // ⑤ 列表里的图标真的注水了（漏 hydrateIcons 就静默变空，这条专治那个）
    //    ⚠️ 顺序要紧：**先** switchPanel('files')，它内部会异步触发 refreshFiles()，
    //    而 refreshFiles 会用检查点里的真实内容**覆盖** S.files（新数据目录里通常是空的）。
    //    先设 S.files 再切页的话，会被那个异步刷新冲掉 → 读到空列表（踩过）。
    switchPanel('files');
    await wait(500);                                   // 等异步刷新落定
    const savedFiles = S.files;
    S.files = [
      { path: rootWin + '\\notes\\a.html', kind: 'absent', changes: 1 },
      { path: rootWin + '\\notes\\b.json', kind: 'modified', changes: 2 },
      { path: rootWin + '\\notes\\c.py', kind: 'modified', changes: 1 },
    ];
    renderFiles();
    await wait(300);
    r.fileIconEls = [...document.querySelectorAll('#files-list .file-item .ic')].map((el) => ({
      want: el.getAttribute('data-ic'), done: el.getAttribute('data-ic-done'), hasSvg: !!el.querySelector('svg'),
    }));
    check('N-2v 改动记录每行都有已注水的类型图标（这条专治"漏 hydrateIcons 静默变空"）',
      r.fileIconEls.length === 3 && r.fileIconEls.every((x) => x.done === x.want && x.hasSvg),
      r.fileIconEls);
    check('N-2w 三种类型在列表里确实分到了三个不同图标',
      new Set(r.fileIconEls.map((x) => x.want)).size === 3, r.fileIconEls.map((x) => x.want));
    S.files = savedFiles;
    renderFiles();
    await wait(150);

    // ⑥ 消息操作条不能压住别的东西（用户截图报的：两个图标叠在「本轮完成」卡右端上）
    //    根因：操作条原先是 bottom:-26px 挂在行外，而 .row 下边距只有 16px → 垂进下一行。
    //    这条按**几何**断言：造「助手回复 + 紧随的汇总卡」，两者不许有任何交叠。
    {
      const tr = $id('transcript');
      const saved = S.transcript.slice();
      S.transcript = [
        { kind: 'assistant', id: 'zz-a', ts: Date.now(), text: '想要哪种风格多一点？我可以再攒一批。' },
        { kind: 'summary', id: 'zz-s', ts: Date.now(), durationMs: 12000, files: [] },
        { kind: 'user', id: 'zz-u', ts: Date.now(), text: '再攒一批' },
      ];
      renderTranscript();
      await wait(450);
      const rows = [...tr.querySelectorAll('.row')];
      const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
      const hit = (a, b) => !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
      const asst = rows.find((x) => x.classList.contains('assistant'));
      const summ = rows.find((x) => x.classList.contains('summary'));
      const user = rows.find((x) => x.classList.contains('user'));
      const aAct = asst && asst.querySelector('.msg-actions');
      const uAct = user && user.querySelector('.msg-actions');
      const uBub = user && user.querySelector('.bubble');
      R.msgActions = {
        asst: aAct ? R(aAct) : null, summ: summ ? R(summ) : null, asstRow: asst ? R(asst) : null,
        uAct: uAct ? R(uAct) : null, uBub: uBub ? R(uBub) : null,
      };
      check('N-3 前置：助手行/汇总行/用户行与它们的操作条都在（否则下面几条空跑）',
        !!(aAct && summ && uAct && uBub), Object.keys(R.msgActions));
      check('N-3a ★ 助手消息的操作条不压住紧随其后的「本轮完成」卡',
        !hit(R(aAct), R(summ)), R.msgActions);
      check('N-3b 操作条也不垂出自己那一行（旧写法 bottom:-26px 会垂出去）',
        R(aAct).b <= R(asst).b + 1, { act: R(aAct), row: R(asst) });
      check('N-3c 用户消息的操作条不压住自己的气泡（用户气泡右对齐，操作条挂左下角）',
        !hit(R(uAct), R(uBub)), R.msgActions);
      S.transcript = saved;
      renderTranscript();
      await wait(250);
    }

    // 收尾：别把 'browser' 之外的落盘值留给后面的用例
    R.browser = r;
  }

  // ============ N-1. 左栏项目树：会话名的文字要和项目名首字母对齐 ============
  prog("N-1. 左栏项目树：会话名的文字要和项目名首字母对齐");
  // 用户报的：「会话文字没有和上面项目名的首字母对齐」。
  // 实测差值 24px = 会话行那个**空图标位**(16px) + flex 的 gap(8px)。
  // 对齐不是"看着差不多"，是两行的文字起点必须是同一个 x —— 所以按像素断言。
  {
    await refreshSessions();
    renderTree();
    await wait(300);
    // 注意：features.js 是注入**渲染层**跑的，直接写 DOM 代码即可（js()/probe() 是鼠标巡检那层的 API，这里没有）
    const treeRows = [...document.querySelectorAll('#project-tree .node')];
    const nmLeft = (el) => (el ? Math.round(el.querySelector('.nm').getBoundingClientRect().left * 100) / 100 : null);
    const projRows = treeRows.filter((r) => !r.classList.contains('sub'));
    const sessRows = treeRows.filter((r) => r.classList.contains('sub') && !r.classList.contains('empty-note'));
    const align = {
      projCount: projRows.length,
      sessCount: sessRows.length,
      projLefts: projRows.map(nmLeft),
      sessLefts: sessRows.map(nmLeft),
      // 顺带量一下图标位是不是真的不占宽了（这就是那个 24px 的来源）
      sessIconDisplay: sessRows.length ? getComputedStyle(sessRows[0].querySelector('.ic')).display : null,
      projIconDisplay: projRows.length ? getComputedStyle(projRows[0].querySelector('.ic')).display : null,
    };
    R.treeAlign = align;
    check('N-1 前置：树里既有项目行也有会话行（否则这条是空跑）',
      align.projCount > 0 && align.sessCount > 0, { p: align.projCount, s: align.sessCount });
    if (align.projCount && align.sessCount) {
      const cols = [...new Set([...align.projLefts, ...align.sessLefts])];
      check('N-1a 项目名与会话名的文字起点在同一列（差值 0，实测曾差 24px）',
        cols.length === 1, { cols, projLefts: align.projLefts, sessLefts: align.sessLefts });
      check('N-1b 会话行没有空图标位占宽（24px 的成因）',
        align.sessIconDisplay === 'none' && align.projIconDisplay !== 'none',
        { sess: align.sessIconDisplay, proj: align.projIconDisplay });
    }
  }

  // ============ N. 删除项目 ============
  prog("N. 删除项目");
  // 用户要的语义：**删除项目只摘索引**，磁盘上的记录目录/会话/检查点/工作目录一律不动。
  // 所以除了"列表里没了"，更要断言"磁盘上还在" —— 后者才是这个动作安全的前提。
  {
    // 走真实界面路径建项目（点「新建项目」→ 起名 → 创建）。
    // 为什么不用 api.projects.create 直接建：那样绕过了界面，S.projects 不会刷新，
    // 侧栏树上根本没那一行，后面的"项目行上有删除按钮"必然假红（第一版就这么红的）。
    $id('btn-new-project').click();
    await wait(700);
    $id('project-name-input').value = '巡检-待删项目';
    $id('project-create').click();
    await wait(1800);
    const target = (await api.projects.list()).find((p) => p.name === '巡检-待删项目');
    check('N0 用界面的「新建项目」建出待删项目（前置，否则 N1 起是空跑）', !!target, target && target.id);
    if (!target) throw new Error('建待删项目失败');
    const tSess = await api.sessions.create({ projectId: target.id, programId: 'omni', name: '待删会话' });
    await api.sessions.update({ projectId: target.id, sessionId: tSess.session.id, patch: { approvalMode: 'auto' } });
    await refreshSessions();
    renderTree();
    await wait(400);
    const tInfo = await api.projects.deleteInfo({ projectId: target.id });
    // 会话数不止 1：界面的「新建项目」建完项目会顺手建一个会话（app.js 的 btn-new-project），
    // 所以这里只能断言"至少 1 个"，并把它当作后面"一条没少"的基准。
    const sessCountBefore = tInfo && tInfo.sessionCount;
    check('N1 deleteInfo 报出记录目录、工作目录与会话数',
      tInfo && sessCountBefore >= 1 && !!tInfo.recordDir && !!tInfo.cwd,
      tInfo && { n: sessCountBefore, dir: !!tInfo.recordDir, cwd: !!tInfo.cwd });
    // 测试环境里 HATCH_PICK_FOLDER 指向 test/.tmp-ui/probe-proj（**不是**程序在数据目录里
    // 自建的那种 workspace），所以这里该认出"是用户自己的目录"。反过来那支（自建 workspace）
    // 由 smoke 的 6b 段覆盖，两处各测一半。
    check('N2 deleteInfo 认出这是用户自己的目录（不是程序自建的 workspace，绝不能删）',
      tInfo && tInfo.selfWorkspace === false, tInfo && { cwd: tInfo.cwd, dir: tInfo.recordDir });

    // 界面入口：项目行右侧那个常驻的删除按钮（不是悬停才出现的）
    const row = [...document.querySelectorAll('#project-tree .node')]
      .find((r) => r.querySelector('.nm') && r.querySelector('.nm').textContent === '巡检-待删项目');
    check('N3 项目行上有删除按钮', !!row && !!row.querySelector('.row-del'), !!row);
    const delBtn = row && row.querySelector('.row-del');
    if (delBtn) {
      const cs = getComputedStyle(delBtn);
      check('N4 删除按钮是常驻可见的（不靠 hover 才出现，否则用户发现不了）',
        cs.display !== 'none' && cs.visibility !== 'hidden' && delBtn.getBoundingClientRect().width > 0,
        { display: cs.display, visibility: cs.visibility, w: Math.round(delBtn.getBoundingClientRect().width) });
      delBtn.click();
      await wait(600);
      const opened = !$id('confirm-modal').classList.contains('hidden');
      const text = $id('confirm-text').textContent;
      check('N5 点了弹应用内确认框，且文案写明「删索引、不删任何文件」',
        opened && /索引/.test(text) && /不删除/.test(text), { opened, text: text.slice(0, 80) });
      check('N5b 文案精简（用户点名要求：别在正文里堆路径）', text.length <= 80, text.length);
      // 路径改挂在一行可点的「记录位置」上，指向工程的记录目录（会话都在里面，删了也保留）
      const locRow = $id('confirm-loc-row');
      const locBtn = $id('confirm-loc');
      check('N6 记录位置单独一行、可点，且指向工程的记录目录',
        !locRow.classList.contains('hidden') && locBtn.tagName === 'BUTTON' &&
        !!tInfo && locBtn.textContent === tInfo.recordDir,
        { hidden: locRow.classList.contains('hidden'), text: locBtn.textContent, want: tInfo && tInfo.recordDir });
      check('N6b 位置行也说明了"删除后依然保留"', /保留/.test(locBtn.title || ''), locBtn.title);

      // 取消 → 什么都不该发生
      $id('confirm-cancel').click();
      await wait(500);
      const stillThere = (await api.projects.list()).some((p) => p.id === target.id);
      check('N7 取消后项目还在（取消要真的取消）', stillThere === true);

      // 再来一次，这回确认
      delBtn.click();
      await wait(600);
      $id('confirm-ok').click();
      await wait(1600);
      const listAfter = await api.projects.list();
      check('N8 确认后从项目列表里消失', !listAfter.some((p) => p.id === target.id), listAfter.map((p) => p.name));
      check('N9 侧栏树上也不留残影',
        ![...document.querySelectorAll('#project-tree .nm')].some((n) => n.textContent === '巡检-待删项目'));
      // ★ 记录必须原样还在，而且要能"重新认回来"。
      // 新模型：记录落在**工程文件夹**里（<文件夹>/.one-harness/sessions/），projects.json 只是指针。
      // 删索引 = 摘掉指针 → 按旧 id 当然查不到（记录不挂在 id 上，挂在文件夹上），
      // 但磁盘一个字节没动：**重新打开那个文件夹**就该原样认回来。
      const sessByOldId = await api.sessions.list(target.id);
      check('N10 摘掉索引后按旧 id 查不到会话（记录不挂在索引上）',
        sessByOldId.length === 0, { after: sessByOldId.length });

      const folder = tInfo.root;
      const reopened = await api.projects.create({ name: '巡检-重新打开', cwd: folder });
      const back = await api.sessions.list(reopened.id);
      check('N11 ★ 重新打开同一个文件夹，会话一条没少（记录跟着文件夹走）',
        back.length === sessCountBefore, { before: sessCountBefore, after: back.length });
      const again = await api.projects.create({ name: '再开一次', cwd: folder });
      check('N11b ★ 同一个文件夹再打开一次不会变出第二个工程（按地址认工程）',
        again.id === reopened.id, { first: reopened.id, second: again.id });
      const mine = back.find((s) => s.id === tSess.session.id);
      const reloaded = mine ? await api.sessions.load({ projectId: reopened.id, sessionId: tSess.session.id }) : null;
      check('N12 ★ 会话内容仍能被完整读出来（含刚存的审批模式）',
        !!reloaded && reloaded.meta && reloaded.meta.approvalMode === 'auto',
        reloaded && reloaded.meta && reloaded.meta.approvalMode);
    }
    R.deleteProject = { tInfo, removed: true };
  }

  // ============ M. 转录渲染：空行不能变成大片空白 ============
  prog("M. 转录渲染：空行不能变成大片空白");
  // 用户报「会话里还有很多空行」。根因是 mdToHtml 把空行也当成正文 push 进段落，
  // 再 join('<br>') —— 模型爱连着吐 \n\n\n\n\n，渲染出来就是一串 <br>；
  // 空行夹在列表间时还会撞出一个空的 <p></p>（浏览器默认 16px 边距）。
  {
    const count = (s, re) => (s.match(re) || []).length;
    R.md = {};

    const m1 = mdToHtml('第一段\n\n\n\n\n第二段');
    R.md.multiBlank = m1;
    check('M1 连续多个空行塌缩成段落断点（不再吐一串 <br>）',
      count(m1, /<br>/g) === 0 && count(m1, /<p>/g) === 2, m1);

    const m2 = mdToHtml('第一段\n\n第二段\n\n第三段');
    check('M2 空行仍然断开段落（三行文本 → 三个段落）',
      count(m2, /<p>/g) === 3 && count(m2, /<br>/g) === 0, m2);

    const m3 = mdToHtml('- 甲\n\n- 乙\n\n- 丙');
    R.md.listWithBlanks = m3;
    check('M3 列表项之间的空行不拆列表（拆一次要多出 16px 边距）',
      count(m3, /<ul>/g) === 1 && count(m3, /<li>/g) === 3, m3);

    check('M4 不产生空段落 <p></p>',
      !/<p><\/p>/.test(m1 + m2 + m3), { m1, m2, m3 });

    const m5 = mdToHtml('上行\n下行');
    check('M5 单个换行仍然保留成 <br>（别把有意换行也吃掉）',
      count(m5, /<br>/g) === 1, m5);

    // 真实转录再体检一遍：任何气泡里都不该出现连续 <br> 或空段落
    const bad = [];
    let brTotal = 0;
    for (const b of document.querySelectorAll('#transcript .bubble.md')) {
      const h = b.innerHTML;
      brTotal += count(h, /<br>/g);
      if (/(?:<br>\s*){2,}/.test(h) || /<p><\/p>/.test(h)) bad.push(h.slice(0, 80));
    }
    R.md.realBrTotal = brTotal;
    check('M6 真实转录里没有连续 <br>、没有空段落', bad.length === 0, bad.slice(0, 3));

    // ---- M7~M11：块之间的"幽灵空行" ----
    // 前置：J 段跑完是"没有打开的会话"（J2 就是断言 sessionId 为 null 的），转录是空的。
    // 不先把有内容的会话打开，下面这些 DOM 断言全是**空跑**（M10 就是这么暴露的：它的 data 是空数组）。
    const all = await api.sessions.list(proj.id);
    const rich = all.slice().sort((a, b) => (b.entryCount || 0) - (a.entryCount || 0))[0];
    // 必须**主动把它打开**。原先写的是 setProject(proj.id, {sessionId: rich.id})，而
    // setProject 的既有语义是"当前项目就是它 → 直接返回"，此时什么都不加载、也不报错：
    // 断言就全落在上一个会话的画面上。以前没出事，是因为"删项目之后界面停在哪个会话上"
    // 碰巧是有内容的那个（靠的是 K 段最后停在哪个会话）。一旦会话集合变了（比如新增一个
    // 空会话被 K 段选中），这个偶然的依赖就断，M7~M11 一起红 —— 而画面本身一点没坏。
    // loadSession 两种情形都覆盖（换项目 / 同项目直接载），正是这一段要的语义。
    if (rich) { await loadSession(rich.id, proj.id); await wait(700); }
    const bubbles = [...document.querySelectorAll('#transcript .bubble.md')];
    check('M7 有可测的气泡（否则 M8~M11 是空跑）', bubbles.length > 0, {
      sessionId: S.sessionId, bubbles: bubbles.length,
      // 失败时一眼看出"为什么没气泡"：挑中的是谁、它有几条、这个项目下各会话各几条
      rich: rich && String(rich.id).slice(0, 8), richEntries: rich && rich.entryCount,
      list: all.map((s) => String(s.id).slice(0, 8) + ':' + (s.entryCount || 0) + ':' + s.name),
    });

    // 根因：.bubble 曾经是 white-space:pre-wrap，而 mdToHtml 用 out.join('\n') 拼块——
    // 那个字面换行被当成真换行渲染，每个块边界凭空多一整行（22px），
    // 而且那个匿名内联框还**阻止相邻 margin 合并**（p→p 从 9px 变 31px、p→h3 从 18 变 49）。
    const m7 = mdToHtml('甲\n\n乙');
    check('M8 块与块之间不插文本节点（</p><p> 直接相邻）', /<\/p><p>/.test(m7) && !/<\/p>\s+<p>/.test(m7), m7);

    const withText = [];
    for (const b of bubbles) {
      const stray = [...b.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      if (stray.length) withText.push({ text: b.innerText.slice(0, 20), stray: stray.map((n) => JSON.stringify(n.textContent.slice(0, 12))) });
    }
    check('M9 真实转录里气泡的块之间没有游离文本节点', withText.length === 0, withText.slice(0, 2));

    // 用户实际看到的那条：量相邻块的实测间隙。
    // **不要依赖"模型这次写了几个块"**——实测真转录里经常一条消息只有 1 个块，
    // 那样 gapCount=0、断言变成空跑（上一版就是栽在这）。所以合成一段固定的块序列：
    // 仍然是真实 CSS + 真实浏览器布局，但结果不再看模型心情。
    const probe = document.createElement('div');
    probe.className = 'bubble md';
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    probe.style.width = '600px';
    probe.innerHTML = mdToHtml('甲\n\n乙\n\n### 小标题\n\n- 一\n- 二\n\n```\ncode\n```\n\n尾\n\n\n\n\n补');
    document.getElementById('transcript').appendChild(probe);
    const pk = [...probe.children];
    const gaps = [];
    for (let i = 1; i < pk.length; i++) {
      gaps.push({ from: pk[i - 1].tagName.toLowerCase(), to: pk[i].tagName.toLowerCase(), gap: Math.round(pk[i].getBoundingClientRect().top - pk[i - 1].getBoundingClientRect().bottom) });
    }
    probe.remove();
    const fat = gaps.filter((g) => g.gap > 20);
    R.md.gaps = gaps;
    check('M10 相邻块的实测间隙没有"幽灵空行"（都 ≤ 20px）', gaps.length >= 5 && fat.length === 0, { gapCount: gaps.length, fat: fat.slice(0, 3), gaps });
    const wsBad = bubbles.filter((b) => getComputedStyle(b).whiteSpace === 'pre-wrap');
    check('M11 气泡本体不再用 white-space:pre-wrap（那是幽灵空行的源头）', bubbles.length > 0 && wsBad.length === 0, { checked: bubbles.length, bad: wsBad.length });

    // ---- M12/M13：悬停才显形的操作条不许占布局高度 ----
    // 它原来在文档流里（margin-top 6 + 高 26 = 32px），悬停才显形却一直占着这 32px，
    // 于是每条消息后面都留一块看不见的空白——用户最直接的感觉就是"本轮完成上面一大块空"。
    // 用**合成的行**来量：真会话里"有正文 + 有操作条"的助手行不一定恰好存在，
    // 依赖它就又会空跑（这条断言第一版就是这么栽的：count:0）。
    const probe2 = document.createElement('div');
    probe2.className = 'row assistant';
    probe2.style.cssText = 'position:absolute; left:-9999px; width:600px';
    probe2.innerHTML = '<div class="meta">助手</div>' +
      '<div class="bubble md"><p>' + '正文一行'.repeat(10) + '</p></div>' +
      '<div class="msg-actions"><button class="act-btn"></button></div>';
    document.getElementById('transcript').appendChild(probe2);
    const p2row = probe2.getBoundingClientRect();
    const p2bubble = probe2.querySelector('.bubble.md').getBoundingClientRect();
    // 注意：getComputedStyle 返回的是**活对象**，元素一脱离文档再读就是空串
    // （这条断言第一版就是这么假红的：先 remove 再读 .position 得到 ""）。所以先取值。
    const p2pos = getComputedStyle(probe2.querySelector('.msg-actions')).position;
    const tail = Math.round(p2row.bottom - p2bubble.bottom);
    probe2.remove();
    check('M12 消息操作条不占布局高度（position:absolute）', p2pos === 'absolute', { position: p2pos });
    check('M13 助手消息正文之后不留空档（操作条不占位）', tail <= 6, { tail, 说明: '32 = 操作条还在文档流里' });

    // 顺带把真会话里也扫一遍（零基数不再是失败条件，只作为附加证据）
    const actions = [...document.querySelectorAll('#transcript .msg-actions')];
    const inFlow = actions.filter((el) => getComputedStyle(el).position !== 'absolute');
    check('M14 真会话里的操作条也全是绝对定位', inFlow.length === 0, { total: actions.length, inFlow: inFlow.length });
  }

  // ============ 汇总 ============
  R.rejections = rejections;
  check('Z1 全程没有未处理异常', rejections.length === 0, rejections);

  if (fails.length) {
    throw new Error('失败 ' + fails.length + ' 项 :: ' + fails.join(' | ') + ' :: 数据 ' + JSON.stringify(R).slice(0, 1500));
  }
  return { 通过: Object.keys(V).length, 数据: R };
})();
