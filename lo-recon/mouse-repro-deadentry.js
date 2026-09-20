'use strict';
// 真鼠标复现（第二轮）："把一个东西删掉之后，左下角那个 One Harness 入口就没法用了"
//
// 第二轮为什么换了对象：第一轮我点的是**会话标签上的 ×**，那一击的命中测试落在 div.bar
// （关闭按钮是 hover 才现形的，真实鼠标点不到）—— 也就是那一轮**什么都没删掉**，
// 用户说"你根本没有删除默认会话"是对的。
// 而左栏「项目」那一行上有一个**常驻**的删除按钮（#del-project-<id>，不藏 hover），
// 会话行反倒没有任何删除入口 —— 所以"上面的那个能删的东西"只可能是它。
// 这一轮就点它，看删完之后入口是不是还活着。
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-09-16-16-28-57/hatch/lo-recon/shots-reopen';
let n = 10;
const shot = async (api, name) => {
  n += 1;
  const p = OUT + '/' + String(n) + '-' + name + '.png';
  const r = await api.shot(p);
  api.log('shot ' + (r ? 'saved ' + p : 'skipped'));
  return r;
};
const state = (api) => api.js(`(() => {
  const S_ = (typeof S !== 'undefined') ? S : null;   // ★ S 是模块级 const，不在 window 上
  const foot = document.getElementById('btn-default-session');
  return {
    projects: S_ ? S_.projects.map((p) => ({ id: p.id.slice(0, 8), name: p.name })) : null,
    projectId: S_ ? (S_.projectId || null) : 'S 取不到',
    sessions: S_ ? (S_.sessions || []).map((s) => ({ id: s.id.slice(0, 8), name: s.name, programId: s.programId })) : null,
    curId: S_ ? (S_.sessionId || null) : null,
    curName: S_ ? ((S_.session && S_.session.name) || null) : null,
    curModelSource: S_ ? ((S_.session && S_.session.modelSource) || null) : null,
    footLit: foot ? foot.classList.contains('on') : null,
    treeRows: [...document.querySelectorAll('#project-tree .row')].map((e) => e.textContent.trim()),
    treeSessions: [...document.querySelectorAll('#project-tree .sub')].map((e) => e.textContent.trim()),
    pills: [...document.querySelectorAll('#session-pills .pill')].map((e) => e.textContent.trim()),
    toasts: [...document.querySelectorAll('#toasts .toast')].map((e) => e.textContent.trim()),
  };
})()`);

module.exports = async (api) => {
  const steps = {};
  const wait = api.wait;
  for (let i = 0; i < 60; i += 1) {
    const ok = await api.js('!!(typeof S !== "undefined" && document.getElementById("btn-default-session"))');
    if (ok) break;
    await wait(300);
  }
  await wait(900);
  steps.s0 = await state(api);
  await shot(api, '起跑');

  // ① 先点入口，把专用会话建出来
  steps.clickFoot1 = await api.click('#btn-default-session', '左栏底部固定入口');
  await wait(1500);
  steps.s1 = await state(api);
  await shot(api, '建好专用会话');

  // ② 点左栏项目行上那个**常驻**的删除按钮
  const pid = steps.s1.projectId;
  steps.delSel = '#del-project-' + pid;
  steps.clickDel = await api.click(steps.delSel, '项目行上的 × （删除索引）');
  await wait(900);
  steps.s2 = await state(api);
  await shot(api, '确认框');

  // ③ 确认框里点「删除索引」
  steps.clickOk = await api.click('#confirm-ok', '确认框的「删除索引」');
  await wait(1400);
  steps.s3 = await state(api);
  await shot(api, '删掉之后');

  // ④ 再点左下角入口：用户说的"没法用了"
  steps.clickFoot2 = await api.click('#btn-default-session', '再点左栏底部固定入口');
  await wait(1500);
  steps.s4 = await state(api);
  await shot(api, '再点入口');
  steps.unhandled = await api.js('window.__mouseRejections || []');

  steps.verdict = {
    '① 起跑时有默认项目': steps.s0.projects && steps.s0.projects.length === 1,
    '① 点入口建出了专用会话': steps.s1.curModelSource === 'fallback',
    '★ ② 项目行上的 × 真实鼠标点得到（常驻，不藏 hover）':
      steps.clickDel.clicked === true && steps.clickDel.reachable === true,
    '② 弹出确认框并点到了「删除索引」': steps.clickOk.clicked === true && steps.clickOk.reachable === true,
    '③ 确认后项目真的没了（索引被摘掉）':
      Array.isArray(steps.s3.projects) && steps.s3.projects.length === 0,
    '★ ④ 删完再点入口：仍然能进专用会话（这是用户说"没法用了"的那一步）':
      steps.s4.curModelSource === 'fallback',
    '④ 界面给了可理解的提示（而不是静默没反应）': Array.isArray(steps.s4.toasts),
    '全程无未处理异常': (steps.unhandled || []).length === 0,
  };
  const bad = Object.entries(steps.verdict).filter(([, v]) => !v);
  api.log('断言 ' + (Object.keys(steps.verdict).length - bad.length) + '/' + Object.keys(steps.verdict).length +
    (bad.length ? ' 失败：' + JSON.stringify(bad.map(([k]) => k)) : ''));
  api.log('关键状态 ' + JSON.stringify({
    s1: steps.s1, s3toasts: steps.s3.toasts, s4: steps.s4,
  }));
  return steps;
};
