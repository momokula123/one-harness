// UI 端到端：设置 → 技能 = 一个技能一张卡；卡片上的「查看」把 SKILL.md 交给系统程序打开。
//
// 为什么单独一份：设置里的类别栏以前只有"打开技能目录"一个按钮，看不出装了哪些技能，
// 也看不出哪些是常驻、哪些是随包（2026-09-19 用户要求"设置里要有卡片"）。
// 这里断言两件事：① 卡片与技能库一一对应（名字、描述、路径、标签都对得上）；
// ② 点卡片上的「查看」**不切右栏**、设置还开着，并把 SKILL.md 交给了系统
//    （证据 = handler 弹的「已交给系统打开：<路径>」toast；2026-09-21 用户拍板
//    "查看不走右栏，直接拉系统 notepad"）。
//
// 数据目录由跑分器指定（HATCH_UI_DATA_DIR），里面得先放好技能，否则卡片数会是 0。
(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    rejections.push(String((e.reason && (e.reason.message || e.reason)) || e.reason));
  });

  const $id = (i) => document.getElementById(i);
  // 文本框的 value 会被浏览器统一成 \n，而盘上的 SKILL.md 是 CRLF（Windows 拷来的），
  // 直接比会假红 —— 比之前先把两边都归一化。
  const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n');
  for (let i = 0; i < 100 && !$id('btn-open-settings'); i++) await wait(200);
  await wait(600);                       // 等 boot 里的 refreshSkills 落地

  // 真值来自接口，不用手写清单比对
  const expected = await window.hatch.skills.list();
  out.expectedCount = expected.length;
  out.expectedTiers = [...new Set(expected.map((s) => s.tier))].sort();
  out.expectedSources = [...new Set(expected.map((s) => s.source))].sort();

  // ---------------- ① 设置 → 技能：卡片长什么样 ----------------
  $id('btn-open-settings').click();
  await wait(400);
  out.modalOpen = !$id('settings-modal').classList.contains('hidden');

  const navItem = document.querySelector('#settings-nav .item[data-sec="skills"]');
  out.navHasSkills = !!navItem;
  navItem.click();
  await wait(300);
  out.sectionIsSkills = !!document.querySelector('#settings-content .skill-card, #settings-content #btn-open-skills-dir');

  const cards = [...document.querySelectorAll('#settings-content .skill-card')];
  out.cardCount = cards.length;
  out.cardNames = cards.map((c) => c.querySelector('.skill-card-name').textContent);
  // 卡片是**按 tier 分组**渲染的，而接口返回的是"按技能目录扫描顺序"—— 两边顺序本来就不该相等
  // （早先随包技能是平铺的，扫描顺序恰好也是 intro 在前，才一直是巧合通过的）。
  // 这里要断言的是"同一批技能"，不是"同一个次序"。
  out.namesMatch = JSON.stringify(out.cardNames.slice().sort()) === JSON.stringify(expected.map((s) => s.name).sort());
  out.everyCardHasDesc = cards.length > 0 && cards.every((c) => (c.querySelector('.skill-card-desc') || {}).textContent.trim().length > 0);
  // 路径不再铺在卡片上，而是挪进文件夹图标的 title（2026-09-23 技能卡重排版）——
  // 所以这里断言的是"图标按钮的 title 里含这个技能的目录"，而不是找一行路径文本。
  const dirOf = new Map(expected.map((s) => [s.name, s.dir]));
  out.everyCardHasFolder = cards.every((c) => {
    const dir = dirOf.get(c.querySelector('.skill-card-name').textContent);
    const b = c.querySelector('.skill-card-foot button[data-skill-folder]');
    return !!dir && /[\\/]/.test(dir) && !!b && String(b.getAttribute('title') || '').indexOf(dir) !== -1;
  });
  // 四段固定骨架（名称 → 标签 → 描述 → 操作条）是"图标对齐"的前提，少一段就会错开。
  out.everyCardHasFoot = cards.every((c) => !!c.querySelector('.skill-card-foot'));
  out.everyCardHasButton = cards.every((c) => {
    const b = c.querySelector('button[data-skill-view]');
    return !!b && b.tagName === 'BUTTON';
  });
  // 标签：第一枚是 常驻/按需，第二枚是 随包/自装
  out.cardTierTags = [...new Set(cards.map((c) => c.querySelectorAll('.pill')[0].textContent))].sort();
  out.cardSourceTags = [...new Set(cards.map((c) => c.querySelectorAll('.pill')[1].textContent))].sort();
  // 卡片上的 tier 标签必须与接口给的 tier 对得上（按**名字**对，不按位置对）
  const tierOf = new Map(expected.map((s) => [s.name, s.tier === 'intro' ? '常驻' : '按需']));
  out.tierTagsMatch = cards.every((c) => {
    const name = c.querySelector('.skill-card-name').textContent;
    return tierOf.get(name) === c.querySelectorAll('.pill')[0].textContent;
  });
  out.groupTitles = [...document.querySelectorAll('#settings-content .group-title')].map((t) => t.textContent);

  // 卡片是静态渲染的：等一会儿再断言"设置还开着、卡片还在"，
  // 防止刚才是"点导航渲染出来的残影"。
  await wait(800);
  out.stillOpenBeforeClick = !$id('settings-modal').classList.contains('hidden');
  out.cardsStillThereBeforeClick = document.querySelectorAll('#settings-content .skill-card').length === out.expectedCount;

  // ---------------- ② 点一张卡的「查看」 ----------------
  const pick = expected.find((s) => s.tier !== 'intro') || expected[0];
  const target = cards.find((c) => c.querySelector('.skill-card-name').textContent === pick.name);
  out.picked = pick.name;
  const viewBtn = target.querySelector('button[data-skill-view]');
  out.viewBtnFound = !!viewBtn;
  viewBtn.click();
  await wait(1200);

  // 新行为：不关设置、不切右栏，SKILL.md 交给系统（toast 为证）。
  // 反面对照：右栏技能页没被切过去（旧实现的现场）。
  out.settingsStillOpen = !$id('settings-modal').classList.contains('hidden');
  out.rightPanelUntouched = $id('panel-skills').classList.contains('hidden');
  out.openToast = [...document.querySelectorAll('#toasts .toast')]
    .map((t) => t.textContent)
    .find((t) => t.indexOf('已交给系统打开') === 0 && t.indexOf(pick.name) !== -1) || '';
  out.rightPanelNeverSelectedOther = out.settingsStillOpen && out.rightPanelUntouched;

  // ---------------- ③ 再看一眼（顺手给截图留画面） ----------------
  // 设置从②开始就没关过 —— 必须还是那 N 张卡（重进不能变空），
  // 并且把这一屏**留着不关**：跑分器的截图是在注入脚本跑完之后抓的。
  const again = [...document.querySelectorAll('#settings-content .skill-card')];
  out.reopenCardCount = again.length;
  out.stayOpenForShot = !$id('settings-modal').classList.contains('hidden');
  out.cardsStillComplete = again.length === out.expectedCount &&
    again.every((c) => !!c.querySelector('button[data-skill-view]'));

  out.rejections = rejections;
  out.verdict = {
    '设置 → 技能：类别栏里有这一项': out.navHasSkills,
    '设置 → 技能：每张卡都有一个技能（数量与技能库一致）': out.cardCount === out.expectedCount && out.cardCount > 0,
    '设置 → 技能：卡片就是技能库那一批（名字集合一致，顺序按 tier 分组）': out.namesMatch,
    '设置 → 技能：每张卡都有名字、描述、所在文件夹、查看按钮':
      out.everyCardHasDesc && out.everyCardHasFolder && out.everyCardHasButton,
    '设置 → 技能：卡片是四段固定骨架（操作条贴在卡底）': out.everyCardHasFoot,
    '设置 → 技能：常驻/按需 两种标签都在，且与接口 tier 一致':
      out.cardTierTags.length >= 1 && out.tierTagsMatch && JSON.stringify(out.cardTierTags.slice().sort()) ===
        JSON.stringify(out.expectedTiers.map((t) => (t === 'intro' ? '常驻' : '按需')).sort()),
    '设置 → 技能：随包/自装 两种来源标签都在':
      out.cardSourceTags.length >= 1 && JSON.stringify(out.cardSourceTags.slice().sort()) ===
        JSON.stringify(out.expectedSources.map((s) => (s === 'builtin' ? '随包' : '自装')).sort()),
    '卡片「查看」：设置还开着、右栏没被切走': out.settingsStillOpen && out.rightPanelUntouched,
    '卡片「查看」：SKILL.md 交给了系统（toast 带出路径）': !!out.openToast,
    '卡片是常驻画面（等一会儿卡片都还在，不是渲染残影）': out.stillOpenBeforeClick && out.cardsStillThereBeforeClick,
    '再进设置：卡片还是一片完整（重进不会变空）': out.reopenCardCount === out.expectedCount && out.cardsStillComplete,
    '截这一屏：设置开着、停在技能分区': out.stayOpenForShot,
    '全程无未处理异常': rejections.length === 0,
  };

  if (!Object.values(out.verdict).every(Boolean)) {
    throw new Error('断言失败 ' + JSON.stringify(out.verdict) + ' :: ' + JSON.stringify(out));
  }
  return out;
})();
