'use strict';
// 真实鼠标巡检：每一次点击都由主进程 webContents.sendInputEvent 发出，走 Chromium 的
// 命中测试，而不是 el.click()。两者差在哪：
//   el.click()              直接触发元素的 onclick，元素被 visibility:hidden、宽 0、
//                           被别的元素压住、落在 -webkit-app-region 拖拽区里，它都照点不误。
//   真实鼠标                 以上任何一种情况都点不到。
// 所以只有这一层能测出"按钮点了没反应"。起因：左栏收起后，位于 #side-left 内部的
// 收起按钮跟着整块隐藏，用户再也点不回侧栏（且收起状态是持久化的，重启也是收起）。
//
// 跑法：node test/run-mouse.js           （见 package.json 的 npm run test:mouse）
module.exports = async ({ click, dblclick, probe, js, wait, log, input, hover, drag, wheel, type, offscreen }) => {
  const R = [];
  const add = (name, ok, extra) => {
    R.push(extra === undefined ? { name, ok: !!ok } : { name, ok: !!ok, extra });
    if (!ok) log('✗ ' + name);
  };
  const skip = (name, why) => {
    R.push({ name, ok: true, skipped: true, extra: why });
    log('· ' + name + '（跳过：' + why + '）');
  };
  const state = async () => {
    const c = await js("document.getElementById('app-root').className");
    return { cls: c, noLeft: /\bno-left\b/.test(c), noRight: /\bno-right\b/.test(c) };
  };

  const s0 = await state();

  // ---- 1. 真实鼠标点侧栏里的「收起」 ----
  const c1 = await click('#btn-toggle-left', '收起侧栏（侧栏内按钮）');
  const s1 = await state();
  add('左栏能收起', s1.noLeft === true, s1);
  add('收起按钮本身被真实鼠标点中了', c1.reachable === true, { topmost: c1.topmost, appRegion: c1.appRegion });

  // ---- 2. 关键：收起之后，展开入口必须还在、还能被真实鼠标点到 ----
  const open = await probe('#btn-open-left');
  add('收起后顶栏出现常驻的「展开侧栏」入口', open.found && open.visible, open);
  add('展开入口能被真实鼠标点到（没被遮挡、不在拖拽区）', open.reachable === true && open.appRegion === 'no-drag', open);
  const inside = await probe('#btn-toggle-left');
  add('对照：侧栏里那个按钮此时是点不到的（老 bug 的现场）', inside.found && inside.reachable === false, inside);

  // ---- 2b. 设置入口的兜底：收起左栏时，栏内那个「设置」点不到，标签栏上的齿轮必须能点到 ----
  // 设置只有这一个入口（右栏那页已经撤了），所以收起状态下必须有替代入口，
  // 否则用户收起左栏就再也开不了设置——和上面那个老 bug 是同一个形态。
  const setInside = await probe('#btn-open-settings');
  add('对照：收起时侧栏里的「设置」点不到', setInside.found && setInside.reachable === false, setInside);
  const railSet = await probe('#btn-open-settings-rail');
  add('收起时标签栏上的「设置」齿轮可点', railSet.found && railSet.visible && railSet.reachable === true && railSet.appRegion === 'no-drag', railSet);

  // ---- 3. 真实鼠标点「展开」 ----
  const c3 = await click('#btn-open-left', '展开侧栏（顶栏入口）');
  const s3 = await state();
  add('左栏能被重新展开', s3.noLeft === false, s3);
  add('展开入口确实点中了', c3.reachable === true, { topmost: c3.topmost });

  // ---- 4. 反复跑一轮，确认不是一次性的 ----
  await click('#btn-toggle-left', '收起（第二轮）');
  const s4a = await state();
  const c4 = await click('#btn-open-left', '展开（第二轮）');
  const s4b = await state();
  add('收起/展开可以反复来回（第二轮）', s4a.noLeft === true && s4b.noLeft === false && c4.reachable === true, { s4a, s4b });

  // ---- 5. 右栏：× 在右栏内部（收起后自然点不到），顶栏那个切换按钮才是常驻入口 ----
  // 右栏默认可能是收起的（照 Bionic），先确保它是展开的，再测 × 能不能真点着收起。
  if ((await state()).noRight) await click('#btn-toggle-right', '先把右栏展开');
  const r0 = await state();
  const rc1 = await click('#btn-close-right', '收起右栏（右栏内的 ×）');
  const r1 = await state();
  const rc2 = await click('#btn-toggle-right', '展开右栏（顶栏常驻）');
  const r2 = await state();
  add('右栏：展开时 × 能收起，收起后顶栏入口能再展开',
    r0.noRight === false && r1.noRight === true && r2.noRight === false && rc1.reachable === true && rc2.reachable === true,
    { r0, r1, r2 });

  // ---- 6. 真实鼠标点开「新建项目」对话框再取消 ----
  const c6 = await click('#btn-new-project', '新建项目');
  const opened = await js("!document.getElementById('project-modal').classList.contains('hidden')");
  add('新建项目：真实鼠标点得开应用内对话框', c6.reachable === true && opened === true, { topmost: c6.topmost, opened });
  await click('#project-cancel', '取消');
  const closed = await js("document.getElementById('project-modal').classList.contains('hidden')");
  add('新建项目：取消后对话框关闭', closed === true);

  // ---- 6b. 删除项目：先用真鼠标量"那个 × 到底点不点得到"，再真点一次走完确认 ----
  // 为什么必须这一层：删除按钮是常驻在项目行右侧的，而项目行自己是可点区域（点一下折叠/切项目），
  // 按钮又小又贴在行边上 —— 这类"看着在、实际点不到"只有真实鼠标 + 命中测试能发现。
  // 不写死项目名：取树上的第一行（干净数据目录里一定有项目，名字叫什么都不影响这条断言）
  const delSel = await js(`(() => {
    const row = document.querySelector('#project-tree .node');
    if (!row) return null;
    const b = row.querySelector('.row-del');
    if (!b) return null;
    b.id = b.id || 'probe-del-btn';
    return '#' + b.id;
  })()`);
  add('删除项目：项目行上找得到删除按钮', !!delSel, { delSel });
  if (delSel) {
    const pd = await probe(delSel);
    // 反向对照用同一条判据：命中测试必须落在按钮自己身上（不是被行或图标吃掉）。
    // 拖拽区判据是 `!== 'drag'`（不是 `=== 'no-drag'`）：这个按钮在侧栏里，appRegion 是 none
    // —— 只有顶栏那种需要划出拖拽区的地方才显式写 no-drag。第一版抄成了 'no-drag'，假红了一次。
    add('删除项目：那个 × 能被真实鼠标点到（没被行/图标挡住、不在拖拽区）',
      pd.found && pd.visible && pd.reachable === true && pd.appRegion !== 'drag', pd);
    const cd = await click(delSel, '项目行的删除按钮');
    const confirmOpen = await js("!document.getElementById('confirm-modal').classList.contains('hidden')");
    add('删除项目：真鼠标点下去弹出确认框', cd.reachable === true && confirmOpen === true,
      { topmost: cd.topmost, confirmOpen });
    // 反向对照：确认框里的「取消」也必须可点（否则用户只能被迫删除）
    const pcancel = await probe('#confirm-cancel');
    add('删除项目：确认框的「取消」也可点（不然就只能删了）',
      pcancel.found && pcancel.reachable === true, pcancel);
    await click('#confirm-cancel', '取消删除');
    const confirmClosed = await js("document.getElementById('confirm-modal').classList.contains('hidden')");
    add('删除项目：取消后确认框关闭', confirmClosed === true);
  }

  // ---- 7. 右栏页签用真鼠标切一次 ----
  const c7 = await click('.tab[data-tab="skills"]', '技能页签');
  const shown = await js("!document.getElementById('panel-skills').classList.contains('hidden')");
  add('右栏页签：真实鼠标能切到技能', c7.reachable === true && shown === true, { topmost: c7.topmost });
  await click('.tab[data-tab="files"]', '文件页签');
  const backToFiles = await js("!document.getElementById('panel-files').classList.contains('hidden')");
  add('右栏页签：能切回文件', backToFiles === true);

  // ---- 7b. 左栏底部的设置入口 + 设置模态框（照 Bionic 的位置，形态是模态框） ----
  const cSet = await click('#btn-open-settings', '左下角设置入口');
  const modalOpen = await js("!document.getElementById('settings-modal').classList.contains('hidden')");
  add('设置：左下角入口能被真实鼠标点开模态框', cSet.reachable === true && modalOpen === true, { topmost: cSet.topmost, modalOpen });
  const navInfo = await js(`(() => {
    const nav = document.getElementById('settings-nav');
    return {
      groups: [...nav.querySelectorAll('.grp')].map((e) => e.textContent.trim()),
      items: [...nav.querySelectorAll('.item')].map((e) => e.textContent.trim()),
      active: (nav.querySelector('.item.active') || {}).textContent,
      rightTabs: [...document.querySelectorAll('#side-right .tab')].map((e) => e.dataset.tab),
    };
  })()`);
  add('设置：模态框里有分组分类栏', navInfo.groups.length >= 1 && navInfo.items.length >= 4, navInfo);
  add('设置：右栏已经没有「设置」页签了（它搬去模态框了）', !navInfo.rightTabs.includes('settings'), navInfo.rightTabs);
  // 切分区：真鼠标点一个分区项，内容要跟着换
  const before = await js("document.getElementById('settings-content').innerText.slice(0,40)");
  const cSec = await click('#settings-nav .item[data-sec="appearance"]', '外观分区');
  const after = await js(`(() => {
    const nav = document.getElementById('settings-nav');
    return {
      text: document.getElementById('settings-content').innerText.slice(0, 40),
      active: (nav.querySelector('.item.active') || {}).dataset.sec,
      hasWidthInput: !!document.getElementById('set-left-w'),
    };
  })()`);
  add('设置：真鼠标能切分区，内容跟着换', cSec.reachable === true && after.active === 'appearance' && after.hasWidthInput === true && after.text !== before,
    { before, after });

  // ---- 7b-2. 设置 → 技能：卡片、以及卡片上的「查看」，都要能被真实鼠标点到 ----
  // 鼠标巡检用的是干净数据目录（一个技能都没有），而卡片是"技能库非空才渲染"的，
  // 所以先用应用自己的接口造一个技能出来，再来点卡片。
  const madeSkill = await js(`(async () => {
    await window.hatch.skills.save({
      name: 'mouse-probe-skill',
      content: '---\\nname: mouse-probe-skill\\ndescription: 鼠标巡检用的技能\\n---\\n\\n这是正文。\\n',
    });
    await refreshSkills();
    return (S.skills || []).map((s) => s.name);
  })()`);
  add('技能卡片前置：造出一个技能（卡片是"有技能才渲染"的）',
    Array.isArray(madeSkill) && madeSkill.includes('mouse-probe-skill'), madeSkill);

  const cSecSkills = await click('#settings-nav .item[data-sec="skills"]', '设置里的「技能」分区');
  const cardsInfo = await js(`(() => {
    const cards = [...document.querySelectorAll('#settings-content .skill-card')];
    return {
      n: cards.length,
      names: cards.map((c) => c.querySelector('.skill-card-name').textContent),
      modalOpen: !document.getElementById('settings-modal').classList.contains('hidden'),
    };
  })()`);
  add('设置 → 技能：真鼠标切到该分区，卡片渲染出来且与技能库一一对应',
    cSecSkills.reachable === true && cardsInfo.modalOpen === true &&
      Array.isArray(madeSkill) && cardsInfo.n === madeSkill.length && cardsInfo.n > 0,
    { topmost: cSecSkills.topmost, ...cardsInfo });

  const cView = await click('#settings-content .skill-card [data-skill-view]', '卡片上的「查看」');
  const afterView = await js(`(() => ({
    settingsClosed: document.getElementById('settings-modal').classList.contains('hidden'),
    skillsPanel: !document.getElementById('panel-skills').classList.contains('hidden'),
    name: document.getElementById('skill-name').value,
    bodyLen: (document.getElementById('skill-content').value || '').length,
  }))()`);
  add('卡片「查看」：真鼠标点下去 → 关设置、切到技能页、正文灌进文本框（就是这张卡那个技能）',
    cView.reachable === true && afterView.settingsClosed === true && afterView.skillsPanel === true &&
      afterView.bodyLen > 0 && afterView.name === cardsInfo.names[0],
    { topmost: cView.topmost, want: cardsInfo.names[0], ...afterView });

  // 反向对照：设置关掉之后，那个「查看」按钮就不该再是可达的 ——
  // 证明上面的 reachable=true 来自"真的能命中"，不是探针对什么都回 true。
  const gone = await probe('#settings-content .skill-card [data-skill-view]');
  add('对照：关掉设置后那个「查看」按钮不再可点（可达性探针有区分度）',
    gone.found === false || gone.reachable === false, gone);

  // ---- 7c. 下拉浮层（自绘，替代原生 <select>）：真鼠标开关 + 选中 + 键盘 ----
  // 原生 select 的选项列表是系统画的，所以这里验的是我们自绘的那套：
  // 点触发器要开、点条目要选中并回写到触发器、点别处/Esc/再点触发器要关。
  // 前置：审批模式是"会话级"的，得先有会话（否则 sessions:update 会拿 null 去问内核）
  const sess0 = await js(`(async () => {
    if (!S.sessionId) {
      const list = await window.hatch.sessions.list(S.projectId);
      if (list.length) await loadSession(list[0].id);
      else await createSession('omni');
    }
    return S.sessionId;
  })()`);
  add('下拉前置：有打开的会话（审批模式是会话级的）', !!sess0, { sessionId: sess0 });
  await js("if (!$('settings-modal').classList.contains('hidden')) closeSettings()");
  await wait(300);
  const cSel = await click('#approval-select', '审批模式触发器');
  const sel1 = await js(`(() => {
    const pop = document.getElementById('sel-pop');
    return {
      open: !!pop && !pop.classList.contains('hidden'),
      items: pop ? [...pop.querySelectorAll('.sel-item')].map((e) => e.dataset.v) : [],
      checked: pop ? [...pop.querySelectorAll('.sel-item.on')].map((e) => e.dataset.v) : [],
      expanded: document.getElementById('approval-select').getAttribute('aria-expanded'),
      radius: pop ? getComputedStyle(pop).borderRadius : '',
      pad: pop ? getComputedStyle(pop).paddingTop : '',
      itemH: pop && pop.querySelector('.sel-item') ? getComputedStyle(pop.querySelector('.sel-item')).height : '',
    };
  })()`);
  add('下拉：真鼠标点触发器能开出自绘浮层', cSel.reachable === true && sel1.open === true && sel1.items.length === 4, sel1);
  add('下拉：浮层是自绘的（8px 圆角 / 2px 内边距 / 24px 条目，照 Bionic 规范）',
    sel1.radius === '8px' && sel1.pad === '2px' && sel1.itemH === '24px', sel1);
  const cItem = await click('#sel-pop .sel-item[data-v="always-ask"]', '「每次询问」条目');
  const sel2 = await js(`(() => {
    const pop = document.getElementById('sel-pop');
    return {
      closed: pop.classList.contains('hidden'),
      label: document.getElementById('approval-select').title,
      expanded: document.getElementById('approval-select').getAttribute('aria-expanded'),
    };
  })()`);
  add('下拉：真鼠标点条目能选中并收起', cItem.reachable === true && sel2.closed === true && /每次询问/.test(sel2.label), sel2);
  // 再开一次，用 Esc 关（键盘）
  await click('#approval-select', '审批模式触发器');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const sel3 = await js("document.getElementById('sel-pop').classList.contains('hidden')");
  add('下拉：Esc 能关掉', sel3 === true);
  // 再开一次，点别处（空白）关
  await click('#approval-select', '审批模式触发器');
  await js(`document.getElementById('transcript').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const sel4 = await js("document.getElementById('sel-pop').classList.contains('hidden')");
  add('下拉：点别处能关掉', sel4 === true);
  // 还回去：跟随全局（别把巡检改的模式留给后面的用例）
  await js(`(async () => {
    const r = await window.hatch.sessions.update({ projectId: S.projectId, sessionId: S.sessionId, patch: { approvalMode: null } });
    S.meta = r.meta; renderTop();
  })()`);
  const backToGlobal = await js("/跟随全局/.test(document.getElementById('approval-select').title)");
  add('下拉：选完能还原成「跟随全局设置」', backToGlobal === true);
  // 关掉：先点关闭按钮
  await click('#settings-close', '设置关闭按钮');
  const closedByBtn = await js("document.getElementById('settings-modal').classList.contains('hidden')");
  add('设置：关闭按钮能关掉', closedByBtn === true);
  // 再验一次：遮罩空白处点一下也该关
  await click('#btn-open-settings', '左下角设置入口');
  await js(`(() => {
    const m = document.getElementById('settings-modal');
    m.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // e.target === 遮罩本身
    return true;
  })()`);
  const closedByBackdrop = await js("document.getElementById('settings-modal').classList.contains('hidden')");
  add('设置：点遮罩空白处也能关', closedByBackdrop === true);

  // ---- 7d. 提示条（toast）只许挡视线，不许挡点击 ----
  // 用户报："右下角弹出消息的时候 设置面板关闭按钮无法点击"。量过：提示条浮在窗口右下角
  // （z-index 50 > 模态框 40），1118 宽的窗口里它正好压在设置模态框右下角那一条上
  // （模态框底 669 / 提示条顶 664）。规矩：容器与提示条都 pointer-events:none，点击一律穿过去。
  // 验法：把提示条**中心对准**左下角「设置」入口的中心，然后发真鼠标点那个按钮。
  // 附带一条反向对照（就地改回 auto）——两条一起，才证明探针有区分度。
  await js(`(() => {
    const w = document.getElementById('toasts');
    w.style.right = 'auto'; w.style.bottom = 'auto';
    toast('巡检提示条：故意压在按钮上，看还能不能点到底下那个', 'ok');
    return true;
  })()`);
  await wait(400);
  const aligned = await js(`(() => {
    const w = document.getElementById('toasts');
    const t = w.firstElementChild;
    const btn = document.getElementById('btn-open-settings');
    const r = btn.getBoundingClientRect(), b = t.getBoundingClientRect();
    w.style.left = Math.round(r.left + r.width / 2 - b.width / 2) + 'px';
    w.style.top = Math.round(r.top + r.height / 2 - b.height / 2) + 'px';
    const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      toastBiggerThanBtn: b.width > r.width && b.height > r.height,
      topmostNow: top ? (top.id || top.className || top.tagName) : null,
      wrapPe: getComputedStyle(w).pointerEvents,
      toastPe: getComputedStyle(t).pointerEvents,
    };
  })()`);
  add('提示条确实盖住了那个按钮（且自己和容器都不吃事件）',
    aligned.toastBiggerThanBtn === true && aligned.topmostNow === 'btn-open-settings' &&
    aligned.wrapPe === 'none' && aligned.toastPe === 'none', aligned);
  const underToast = await probe('#btn-open-settings');
  add('提示条底下那个按钮依然"点得到"', underToast.found && underToast.reachable === true, underToast);
  const cUnderToast = await click('#btn-open-settings', '压在提示条底下的设置入口');
  const openedUnderToast = await js("!document.getElementById('settings-modal').classList.contains('hidden')");
  add('真鼠标点下去真的生效（设置面板打开了）', cUnderToast.reachable === true && openedUnderToast === true, { opened: openedUnderToast, topmost: cUnderToast.topmost });
  await js('closeSettings()');
  await wait(250);
  // 反向对照：把容器改回吃事件（等于没有这条修复），同一次点击就该点不到了。
  // 注意：提示条有自动消失的定时器 —— 它要是已经消失，这里就成了"没东西可挡"的**假红**
  // （实测偶发过），所以先重建一条、重新对齐，并把"确实盖住"作为前提一起断言。
  const blocked = await js(`(() => {
    const w = document.getElementById('toasts');
    w.style.pointerEvents = 'auto';
    if (!w.firstElementChild) toast('巡检提示条：反向对照', 'ok');
    const t = w.firstElementChild;
    const btn = document.getElementById('btn-open-settings');
    const r = btn.getBoundingClientRect(), b = t.getBoundingClientRect();
    w.style.left = Math.round(r.left + r.width / 2 - b.width / 2) + 'px';
    w.style.top = Math.round(r.top + r.height / 2 - b.height / 2) + 'px';
    const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return { covered: !!(top && t.contains(top)), topmost: top ? (top.id || top.className || top.tagName) : null };
  })()`);
  await wait(220);
  const blockedProbe = await probe('#btn-open-settings');
  add('对照：提示条恢复成吃事件后，同一个按钮就点不到了',
    blocked.covered === true && blockedProbe.found && blockedProbe.reachable === false,
    { covered: blocked.covered, topmost: blocked.topmost, reachable: blockedProbe.reachable });
  // 收尾：把提示条挪回右下角并清空（后面的全量体检要看到干净界面）
  await js(`(() => {
    const w = document.getElementById('toasts');
    w.style.pointerEvents = ''; w.style.left = ''; w.style.top = '';
    w.style.right = ''; w.style.bottom = ''; w.style.width = '';
    w.innerHTML = '';
    return true;
  })()`);
  await wait(250);

  // ---- 8. 顺带：顶栏窗口按钮必须在拖拽区之外（否则点不到） ----
  for (const [sel, label] of [['#win-min', '最小化'], ['#win-max', '最大化'], ['#win-close', '关闭']]) {
    const p = await probe(sel);
    add('窗口按钮「' + label + '」不被拖拽区吃掉', p.found && p.reachable === true && p.appRegion === 'no-drag', p);
  }

  // ---- 9. 全量体检：所有可见交互元素，命中测试都必须落在自己身上 ----
  // 只做命中测试、不点击，所以可以放心把整个界面扫一遍（不会有任何副作用）。
  // 判定"可疑"的三个条件：命中测试没落在自己身上 && 没被显式设成 pointer-events:none
  // && 不在拖拽区。三者同时成立 = 看得见却点不着（正是这次事故的形态）。
  const audit = await js(`(() => {
    const sels = ['button','[onclick]','.node','.stab','.tab','.section-head','.side-foot-row','input','textarea'];
    const seen = new Set(); const out = [];
    for (const s of sels) for (const el of document.querySelectorAll(s)) {
      if (seen.has(el)) continue; seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const top = (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) ? document.elementFromPoint(cx, cy) : null;
      out.push({
        desc: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : ''),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        pe: cs.pointerEvents,
        region: cs.webkitAppRegion || 'none',
        hit: !!(top && (top === el || el.contains(top) || top.contains(el))),
        // 命中的若是"同一个包裹层里的兄弟"——比如图标按钮 + 透明原生 select 这种组合控件
        // （.icon-select / .model-chip 就是有意这么叠的）——那是设计如此，不算点不到。
        grouped: !!(top && el.parentElement && el.parentElement.contains(top)),
        topmost: top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : null,
      });
    }
    return out;
  })()`);
  const suspicious = audit.filter((x) => !x.hit && !x.grouped && x.pe !== 'none' && x.region !== 'drag');
  const grouped = audit.filter((x) => !x.hit && x.grouped);
  add('全量体检：' + audit.length + ' 个可见交互元素的命中测试都落在自己身上（其中组合控件 ' + grouped.length + ' 个）', suspicious.length === 0, suspicious);

  // ---- 10. 真实拖拽分隔条（必须分步移动，一步到位很多拖拽实现收不到中间态） ----
  const leftW = () => js("parseFloat(getComputedStyle(document.getElementById('side-left')).width)");
  const w0 = await leftW();
  await drag('#split-left', 60, 0, '左分隔条右拖 60px');
  const w1 = await leftW();
  await drag('#split-left', -60, 0, '左分隔条左拖 60px');
  const w2 = await leftW();
  add('真实拖拽能改左栏宽度并拖回来（' + w0 + ' → ' + w1 + ' → ' + w2 + '）',
    w1 > w0 + 30 && Math.abs(w2 - w0) < 15, { w0, w1, w2 });

  // ---- 11. 真实双击分隔条 = 折叠/展开 ----
  const dblBefore = await state();
  const dblRec = await dblclick('#split-left', '左分隔条双击');
  const dblAfter = await state();
  add('真实双击左分隔条能折叠左栏', dblAfter.noLeft !== dblBefore.noLeft && dblRec.reachable === true, { dblBefore, dblAfter });
  if (dblAfter.noLeft) { await click('#btn-open-left', '双击后点展开入口恢复'); }

  // ---- 12. 真实键盘输入 ----
  await type('#input', 'REAL_TYPING', '输入框打字');
  const typed = await js("document.getElementById('input').value");
  add('真实键盘能往输入框打字', typed === 'REAL_TYPING', { typed });
  await js("const i=document.getElementById('input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));");

  // ---- 12b. 右栏浏览器「用系统默认浏览器打开」 ----
  // 用户报的 bug：按下没反应。根因是那一下交给了 shell.openPath —— 它只吃文件系统路径，
  // 喂 `file:///…` / `https://…` 会返回 "Failed to open path"（字符串、不 reject），
  // 旧代码没接返回值，于是"静默失败"。现在走 openExternal，且无论成败都回一句话。
  // 这里真鼠标验两件事：① 那个按钮真人点得到（它紧挨输入框，容易落在别处）；
  // ② 点完确实走到主进程、并按地址栏内容解析（拿 toast 文本当凭据）。
  // 注：跑分器会给子进程带 HATCH_OPEN_DRYRUN=1 —— 自动化不许真把浏览器/资源管理器
  // 糊到用户屏幕上；dry-run 里除了"不真打开"以外的链路（IPC、解析、回值、提示）全是真的。
  try {
    if ((await state()).noRight) await click('#btn-toggle-right', '先把右栏展开');
    // 注意：executeJavaScript 是当**脚本**求值的，顶层写 `return` 是语法错误
    // （表现为 "Script failed to execute"）—— 一律包成 IIFE。
    await js("(() => { switchPanel('browser'); return true; })()");
    await wait(300);
    const bwProbe = await probe('#bw-open');
    // appRegion 这里天然是 none（按钮不在顶栏拖拽区里）——"不是 drag"就够，别照抄左栏那条 no-drag。
    add('右栏浏览器的「用系统默认浏览器打开」能被真实鼠标点到',
      bwProbe.found && bwProbe.visible && bwProbe.reachable === true && bwProbe.appRegion !== 'drag', bwProbe);

    const toasts = () => js("[...document.querySelectorAll('#toasts .toast')].map(e=>e.textContent).join(' ~ ')");
    const putUrl = (v) => js("(() => { document.getElementById('toasts').innerHTML=''; document.getElementById('bw-url').value=" + JSON.stringify(v) + "; return true; })()");
    const netCase = 'https://github.com/momokula123/one-harness';
    await putUrl(netCase);
    const cNet = await click('#bw-open', '点「用系统默认浏览器打开」（网址）');
    await wait(600);
    const tNet = await toasts();
    add('点网址：真的走到主进程，并按地址栏内容交给系统',
      cNet.reachable === true && tNet.includes('已交给系统打开：' + netCase), tNet);

    const pathCase = 'C:\\Users\\Administrator\\Downloads';
    await putUrl(pathCase);
    await click('#bw-open', '点「用系统默认浏览器打开」（本地路径）');
    await wait(600);
    const tPath = await toasts();
    add('点本地路径：先转成 file:// 再交给系统（旧代码就是在这里静默失败的）',
      tPath.includes('已交给系统打开：file:///C:/Users/Administrator/Downloads'), tPath);

    // 反向对照：地址栏为空时必须明确报错，而不是"什么都不发生"（旧代码正是后者）
    await putUrl('');
    await click('#bw-open', '点「用系统默认浏览器打开」（空地址）');
    await wait(600);
    const tEmpty = await toasts();
    add('对照：地址栏为空时明确报「地址栏是空的」（不再静默）', tEmpty.includes('地址栏是空的'), tEmpty);

    // 反向对照：右栏收起时这个按钮**必须点不到** —— 否则上面那条 reachable 可能是恒真，
    // 全绿也就说明不了任何事（老 bug"收起后按钮跟着消失"正是这一类）。
    await click('#btn-close-right', '收起右栏（准备反向对照）');
    const bwHidden = await probe('#bw-open');
    const collapsed = (await state()).noRight;
    add('对照：右栏收起后同一个按钮点不到（证明可点性断言有区分度）',
      collapsed === true && bwHidden.found && bwHidden.reachable === false, { collapsed, probe: bwHidden });
    await click('#btn-toggle-right', '恢复右栏');
    add('恢复右栏后按钮又能点到了', (await probe('#bw-open')).reachable === true);
  } catch (e) {
    add('右栏浏览器的打开按钮', false, String((e && e.message) || e));
  }

  // ---- 12c. 设置里的「导出 / 导入工程索引」 ----
  // 用户要的是"把工程索引备份一份、换机器再导回来"。这里真鼠标点这两个按钮，
  // 并做一次**真往返**：导出 → 从索引里摘掉一个工程 → 再导入 → 它必须回来。
  // 跑分器把 HATCH_SAVE_PATH / HATCH_OPEN_PATH 指向同一个文件，所以"导出写的是真文件"
  // 这条能验得很硬：第二步导入能读出内容，就说明文件真的落盘了，而不是函数回了句 ok。
  try {
    await js("(() => { openSettings('general'); return true; })()");
    await wait(500);
    const eb = await probe('#btn-export-index');
    add('设置里「导出工程索引」能被真实鼠标点到',
      eb.found && eb.visible && eb.reachable === true, eb);

    const toasts = () => js("[...document.querySelectorAll('#toasts .toast')].map(e=>e.textContent).join(' ~ ')");
    const clearToasts = () => js("(() => { document.getElementById('toasts').innerHTML=''; return true; })()");
    const n0 = await js('S.projects.length');

    await clearToasts();
    await click('#btn-export-index', '点「导出工程索引」');
    await wait(1000);
    const tExp = await toasts();
    add('导出：提示里带出工程数，且与本机索引条数一致',
      tExp.includes('已导出 ' + n0 + ' 个工程的索引：'), { n0, tExp });

    await clearToasts();
    await click('#btn-import-index', '点「导入工程索引」（刚导出的那份）');
    await wait(1000);
    const tImp = await toasts();
    add('★ 把刚导出的文件导回来能读出内容（证明导出写的是真文件）',
      tImp.includes('新增 0 个工程') && tImp.includes('已有 ' + n0 + ' 个跳过'), { n0, tImp });

    // 真往返：摘掉一条**非当前**工程的索引，再导入，它必须回来
    const victim = await js("(S.projects.find(p => p.id !== S.projectId) || S.projects[0]).id");
    const victimName = await js("(S.projects.find(p => p.id !== S.projectId) || S.projects[0]).name");
    const rm = await js("(async () => { const r = await api.projects.remove({ projectId: " + JSON.stringify(victim) +
      " }); S.projects = await api.projects.list(); renderTree(); return { ok: r.ok, left: S.projects.length }; })()");
    add('反向对照：先确认那条真被摘掉了（否则下面"新增 1"可能恒真）',
      rm.ok === true && rm.left === n0 - 1, { victim, victimName, rm });

    await clearToasts();
    await click('#btn-import-index', '再点「导入工程索引」（把摘掉的那条补回来）');
    await wait(1000);
    const tImp2 = await toasts();
    const back = await js('S.projects.some(p => p.id === ' + JSON.stringify(victim) + ')');
    add('★ 导入把摘掉的那条补回来：提示"新增 1"且工程真的回到左栏',
      tImp2.includes('新增 1 个工程') && back === true, { tImp2, back });

    // 反向对照：关掉设置后同一个按钮必须不可见 —— 否则上面那条"可点"没有区分度
    await js("(() => { closeSettings(); return true; })()");
    await wait(400);
    const ebHidden = await probe('#btn-export-index');
    add('对照：关掉设置后同一个按钮不可见（证明可点性断言有区分度）',
      ebHidden.found === true && ebHidden.visible === false, ebHidden);
  } catch (e) {
    add('设置里的工程索引导出/导入', false, String((e && e.message) || e));
  }

  // ---- 13. 滚轮事件真的送达页面 ----
  // ⚠️ 屏幕外模式下**直接跳过**：屏幕外窗口的合成帧率极低，滚轮根本合成不出来，
  //    干等只会把整场测试拖到超时（实测踩过）。要验这两条请跑 npm run test:mouse:visible。
  // 合成器的丢弃条件有两层，两层都得满足才稳：
  //   ① 落点必须在一个**真的能滚**的容器上（否则"这一片没可滚的"直接丢）；
  //   ② 落点所在的那条**祖先链**要能让它算出滚动目标 —— 挂在 body 上的 fixed 元素
  //      虽然自己 overflow:auto，但它不在正常流里，实测会被丢（哪怕先移指针过去）。
  // 所以这里把探针容器塞进**主区**（.chat-scroll 这类真实滚动容器里），用真的会滚动的内容。
  // 另外滚多轮：单轮几百像素有时会被"滚动到底了没有位移"这一步吃掉。
  if (offscreen) {
    skip('滚轮事件真的送到页面', '屏幕外窗口滚轮合成不出来（跑 npm run test:mouse:visible 才验）');
    skip('指针移到发送按钮上会触发 mouseenter', '屏幕外窗口 mouseMoved 被攒着不派发（同上）');
  } else {
  await js(`(() => {
    window.__wheelSeen = 0;
    const host = document.createElement('div');
    host.id = 'wheel-probe';
    // 放进主区内部（真实滚动容器里），而不是 fixed 挂在 body 上
    const parent = document.getElementById('main-col') || document.body;
    host.style.cssText = 'width:220px;height:150px;overflow:auto;';
    const tall = document.createElement('div');
    tall.style.cssText = 'height:2000px;';
    host.appendChild(tall);
    parent.appendChild(host);
    document.addEventListener('wheel', (e) => { if (e.target && e.target.closest && e.target.closest('#wheel-probe')) window.__wheelSeen += 1; }, { passive: true });
    document.addEventListener('wheel', () => { window.__wheelAny = (window.__wheelAny || 0) + 1; }, { passive: true });
    return true;
  })()`);
  // 滚多轮（每次 6 小步的 wheel() 调用），并把探针滚回顶部再滚 —— 别让"已经到底"把位移吃掉
  let wheelSeen = 0;
  let wheelAny = 0;
  for (let round = 0; round < 3 && !wheelSeen; round += 1) {
    await js("(() => { const h = document.getElementById('wheel-probe'); if (h) h.scrollTop = 0; return true; })()");
    await wheel('#wheel-probe', 0, 240, '可滚容器滚轮第 ' + (round + 1) + ' 轮');
    for (let i = 0; i < 10 && !wheelSeen; i += 1) {
      await wait(150);
      wheelSeen = await js('window.__wheelSeen');
      wheelAny = await js('window.__wheelAny || 0');
    }
  }
  add('滚轮事件真的送到页面', wheelSeen > 0, { wheelSeen, wheelAny });
  await js("(() => { const h = document.getElementById('wheel-probe'); if (h) h.remove(); return true; })()");

  // ---- 14. 指针移到控件上会触发 hover ----
  // 同时挂 document 级的 mousemove/mouseover 计数：区分"事件根本没送达"和"送错元素了"。
  await js(`(() => { window.__hoverSeen = 0; window.__mm = 0; window.__mo = 0;
    document.getElementById('btn-send').addEventListener('mouseenter', () => { window.__hoverSeen += 1; });
    document.addEventListener('mousemove', () => { window.__mm += 1; });
    document.addEventListener('mouseover', () => { window.__mo += 1; });
    return true;
  })()`);
  const hov = await hover('#btn-send', '发送按钮');
  // 同上：mouseMoved 是攒到下一个合成时机才派发的，轮询到它到为止（最多约 2.4s）
  let hoverSeen = 0;
  let mm = 0;
  let mo = 0;
  for (let i = 0; i < 16; i += 1) {
    hoverSeen = await js('window.__hoverSeen');
    mm = await js('window.__mm');
    mo = await js('window.__mo');
    if (hoverSeen > 0 || mm > 0 || mo > 0) break;
    await wait(150);
  }
  add('指针移到发送按钮上会触发 mouseenter', hoverSeen > 0,
    { hoverSeen, documentMousemove: mm, documentMouseover: mo, probe: { found: hov.found, at: [hov.x, hov.y, hov.w, hov.h], topmost: hov.topmost } });
  }

  const unhandled = await js('window.__mouseRejections');
  add('全程无未处理异常', Array.isArray(unhandled) && unhandled.length === 0, unhandled);

  const failed = R.filter((x) => !x.ok).map((x) => x.name);
  const skipped = R.filter((x) => x.skipped).map((x) => x.name);
  return { 通过: R.length - failed.length, 总数: R.length, 失败: failed, 跳过: skipped, offscreen: !!offscreen, 明细: R };
};
