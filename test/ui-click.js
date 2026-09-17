// UI 端到端：真点侧栏「新建项目」，走完 选目录 → 起名 → 建项目 → 建会话 的完整链路；
// 顺带把侧栏/顶栏/输入框那几个"点了应该有事发生"的控件都点一遍，断言全程没有未处理异常。
// 只桩掉系统文件夹对话框（原生对话框没法自动化，见 main.js 的 HATCH_PICK_FOLDER）；
// 「打开数据目录」这类会弹系统窗口的按钮**故意不点**。
//
// 这条测试是补课的产物：之前只跑过"内核冒烟 + 截图"，从没点过任何一个会产生副作用的按钮，
// 于是 window.prompt 在 Electron 里被禁用（调用即抛）这件事一直没被发现 ——
// 异常又发生在 async 事件处理器里，界面上连报错都没有，用户看到的就是"点了没反应"。
(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // async 事件处理器里抛的错只会走到这里（界面不会有任何反应），必须收集起来断言
  const rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    rejections.push(String((e.reason && (e.reason.message || e.reason)) || e.reason));
  });

  // 顺手记一笔：Electron 到底支不支持原生 prompt
  try {
    window.prompt('t', 'x');
    out.promptCall = 'returned';
  } catch (e) {
    out.promptCall = 'threw:' + e.message;
  }

  const $id = (i) => document.getElementById(i);
  const tree = () => $id('project-tree');
  const rows = () => [...tree().querySelectorAll('.node')].map((el) => el.querySelector('.nm').textContent);
  const NAME = '探针项目';

  // ---------------- ① 新建项目 ----------------
  const before = (await window.hatch.projects.list()).length;
  out.btnFound = !!$id('btn-new-project');
  $id('btn-new-project').click();
  await wait(600);

  const modal = $id('project-modal');
  const input = $id('project-name-input');
  out.modalOpened = !modal.classList.contains('hidden');
  out.inputPrefilled = input.value;
  out.dirShown = $id('project-dir').textContent;

  input.value = NAME;
  $id('project-create').click();
  await wait(1800);

  out.modalClosed = modal.classList.contains('hidden');
  out.projects = (await window.hatch.projects.list()).map((p) => p.name);
  out.treeRows = rows();
  out.treeActive = tree().querySelector('.node.current .nm')?.textContent || null;
  out.tabs = [...document.querySelectorAll('#session-tabs .stab')].map((el) => el.innerText.trim());

  // ---------------- ② 把几个安全控件点一遍 ----------------
  const clicked = {};
  const click = async (sel, key) => {
    const el = document.querySelector(sel);
    clicked[key] = !!el;
    if (el) el.click();
    await wait(320);
  };

  await click('#btn-plus', 'plus');
  clicked.menuOpened = !$id('new-session-menu').classList.contains('hidden');
  // 菜单里挑第一项建个会话
  const firstItem = document.querySelector('#new-session-menu .pop-item');
  clicked.menuHasItems = !!firstItem && document.querySelectorAll('#new-session-menu .pop-item').length > 0;
  if (firstItem) {
    firstItem.click();
    await wait(900);
  }
  clicked.menuClosed = $id('new-session-menu').classList.contains('hidden');

  // 侧栏底部的「聊天」区已整体移除（用户要求：和项目树重复，没用）
  clicked.chatSectionGone = !$id('chat-section') && !$id('head-chat') && !$id('chat-list');

  // 设置已经不是右栏的一页了：入口在左下角，点开是模态框（照 Bionic 的位置）
  await click('#btn-open-settings', 'btnOpenSettings');
  clicked.settingsModalOpen = !$id('settings-modal').classList.contains('hidden');
  clicked.settingsHasNav = document.querySelectorAll('#settings-nav .item').length >= 4;
  await click('#settings-close', 'btnSettingsClose');
  clicked.settingsModalClosed = $id('settings-modal').classList.contains('hidden');
  await click('.tab[data-tab="skills"]', 'tabSkills');
  clicked.skillsShown = !$id('panel-skills').classList.contains('hidden');
  await click('.tab[data-tab="tools"]', 'tabTools');
  clicked.toolsShown = !$id('panel-tools').classList.contains('hidden');

  // 右栏默认是收起的（照 Bionic），所以这里断言"点一下会翻转"，
  // 而不是断言某个方向 —— 别把初始状态假设写进断言里。
  const noRight = () => $id('app-root').classList.contains('no-right');
  const beforeClose = noRight();
  await click('#btn-close-right', 'closeRight');
  clicked.rightToggled = noRight() !== beforeClose;
  const midRight = noRight();
  await click('#btn-toggle-right', 'toggleRight');
  clicked.rightToggledBack = noRight() !== midRight;

  await click('#btn-tab-new', 'tabNew');
  // 诚实的分工：el.click() 绕过命中测试，元素被 visibility:hidden / 宽 0 / 被压住它照样触发，
  // 所以"收起后还能不能再展开"这里根本测不出来（之前就是这么误判成通过的）。
  // 这里只断言"点一次能收起 + 展开入口存在"，可点性交给 test/mouse-steps.js 用真实鼠标事件验。
  const noLeft = () => $id('app-root').classList.contains('no-left');
  const beforeLeft = noLeft();
  await click('#btn-toggle-left', 'toggleLeft');
  clicked.leftToggled = noLeft() !== beforeLeft;
  const openLeft = $id('btn-open-left');
  clicked.openLeftExists = !!openLeft;
  if (openLeft) {
    openLeft.click(); // 恢复到展开态，别把收起状态留给后面的断言
    await wait(320);
  }
  clicked.leftBackOpen = noLeft() === false;

  out.clicked = clicked;

  // ---------------- ③ 删除项目：必须点得开确认框、取消不删、确认才删 ----------------
  // 用刚建的那个 "探针项目" 当靶子。走真实入口：项目行右侧那个常驻的 × 按钮。
  const del = (() => {
    // 找到名字等于 NAME 的那一行里的删除按钮
    for (const row of tree().querySelectorAll('.node')) {
      if (row.querySelector('.nm')?.textContent === NAME) return row.querySelector('.button-row-del, .row-del');
    }
    return null;
  })();
  out.delBtnFound = !!del;
  out.delBtnAlwaysVisible = !!del && getComputedStyle(del).display !== 'none' && del.getBoundingClientRect().width > 0;
  const countBefore = (await window.hatch.projects.list()).length;
  if (del) { del.click(); await wait(600); }

  out.confirmOpened = !$id('confirm-modal').classList.contains('hidden');
  out.confirmTitle = $id('confirm-title').textContent;
  out.confirmText = $id('confirm-text').textContent;
  // 文案要短而准（用户点名要求精简）：一句话说清"删索引 / 不删文件"。
  // 另外"东西在哪"不该堆在正文里，而是挂一行可点的「工程位置」。
  out.confirmSaysIndexOnly = /索引/.test(out.confirmText);
  out.confirmSaysNoFileDelete = /不删除.{0,6}(文件|磁盘)|磁盘上的任何文件/.test(out.confirmText);
  out.confirmIsShort = out.confirmText.length <= 80;
  const locRow = $id('confirm-loc-row');
  out.locRowVisible = !locRow.classList.contains('hidden');
  out.locPath = $id('confirm-loc').textContent;
  out.locLooksLikePath = /[\\/]projects[\\/]/.test(out.locPath);
  out.locIsButton = $id('confirm-loc').tagName === 'BUTTON';

  // 先取消：什么都不该变
  $id('confirm-cancel').click();
  await wait(500);
  out.cancelClosed = $id('confirm-modal').classList.contains('hidden');
  out.cancelKeptProject = (await window.hatch.projects.list()).length === countBefore;

  // 再确认：项目列表要少一条，但标签栏/树上也要跟着干净
  if (del) { del.click(); await wait(600); }
  $id('confirm-ok').click();
  await wait(1600);
  out.projectsAfterDelete = (await window.hatch.projects.list()).map((p) => p.name);
  out.deletedFromList = !out.projectsAfterDelete.includes(NAME);
  out.treeAfterDelete = rows();
  out.treeNoGhost = !out.treeAfterDelete.includes(NAME);
  // 删掉当前项目后必须切到别的项目（不能卡在"已删项目的会话"上）
  out.activeAfterDelete = tree().querySelector('.node.current .nm')?.textContent || null;
  out.noSessionErrorAfterDelete = !rejections.some((r) => /会话不存在/.test(r));
  // 图标注水体检：每个 [data-ic] 都必须真的拿到 SVG。
  // 这条是补课——删 ICONS 里的 chat 时，漏了 showNewSessionMenu 用
  // setAttribute('data-ic','chat') 挂的那 6 个（按 data-ic="chat" 字面量 grep 搜不到），
  // 结果新建会话菜单 6 个图标全空。当时 ui-shot 其实打出了 icons:"22/28"，
  // 但那只是**信息**不是断言，所以没拦住。
  out.iconsTotal = document.querySelectorAll('[data-ic]').length;
  out.iconsMissing = [...document.querySelectorAll('[data-ic]')]
    .filter((el) => el.getAttribute('data-ic-done') !== el.getAttribute('data-ic'))
    .map((el) => el.getAttribute('data-ic'));
  out.toasts = [...document.querySelectorAll('#toasts .toast')].map((el) => el.textContent);
  out.rejections = rejections;

  out.verdict = {
    '新建项目：按钮存在': out.btnFound,
    '新建项目：弹的是应用内对话框': out.modalOpened,
    '新建项目：名称框预填了目录名': out.inputPrefilled === 'probe-proj',
    '新建项目：新项目已落盘': out.projects.includes(NAME) && out.projects.length === before + 1,
    '新建项目：侧栏树上出现新项目': out.treeRows.includes(NAME),
    '新建项目：新项目成了当前项目': out.treeActive === NAME,
    '新建项目：自动建了会话': out.treeRows.length > out.projects.length,
    '新建项目：对话框已关闭': out.modalClosed,
    '输入框＋：菜单能开能关': clicked.menuOpened && clicked.menuHasItems && clicked.menuClosed,
    '侧栏底部「聊天」区已移除（它和项目树重复）': clicked.chatSectionGone,
    '右栏页签：技能/工具都能切': clicked.skillsShown && clicked.toolsShown,
    '设置：左下角入口点开模态框、有关闭按钮、有分类栏': clicked.settingsModalOpen && clicked.settingsModalClosed && clicked.settingsHasNav,
    '右栏：收起/展开双向都能切': clicked.rightToggled && clicked.rightToggledBack,
    '左栏：点一下能收起，且顶栏有常驻展开入口（可点性由 test:mouse 验）': clicked.leftToggled && clicked.openLeftExists && clicked.leftBackOpen,
    '所有控件都点到了': Object.values(clicked).every(Boolean),
    '所有图标都注水成功（缺 ICONS 条目会静默变空）': out.iconsTotal > 0 && out.iconsMissing.length === 0,
    '删除项目：项目行上有删除按钮，而且是常驻可见的': out.delBtnFound && out.delBtnAlwaysVisible,
    '删除项目：点它会弹应用内确认框（不是原生 confirm）': out.confirmOpened && /删除项目/.test(out.confirmTitle),
    '删除项目：文案写明"只摘索引"、且明确不删磁盘文件': out.confirmSaysIndexOnly && out.confirmSaysNoFileDelete,
    '删除项目：文案精简（≤80 字，不堆长路径）': out.confirmIsShort,
    '删除项目：工程位置单独一行、是个可点的按钮、指向项目记录目录':
      out.locRowVisible && out.locIsButton && out.locLooksLikePath,
    '删除项目：取消后项目还在': out.cancelClosed && out.cancelKeptProject,
    '删除项目：确认后从列表里消失': out.deletedFromList,
    '删除项目：侧栏树上也不留残影': out.treeNoGhost,
    '删除项目：当前项目被删后切到了别的项目（没卡在已删项目上）': !!out.activeAfterDelete && out.activeAfterDelete !== NAME,
    '删除项目：全程没有「会话不存在」这类未处理异常': out.noSessionErrorAfterDelete,
    '全程无未处理异常': rejections.length === 0,
  };

  if (!Object.values(out.verdict).every(Boolean)) {
    throw new Error('断言失败 ' + JSON.stringify(out.verdict) + ' :: ' + JSON.stringify(out));
  }
  return out;
})();
