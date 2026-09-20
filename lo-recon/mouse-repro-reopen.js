'use strict';
// 真鼠标复现："在 One Harness 会话里把标签关掉（或删掉）→ 再点左栏底部那个固定入口"
//
// 每一步都用 CDP 的 Input.dispatchMouseEvent 发**真实鼠标**（走 Chromium 命中测试，
// 不是 el.click()），并逐步截图。api 里的 shot() 只有在窗口可见时才有图
// （BACKGROUND 且没设 HATCH_SHOT_VISIBLE 时它会返回 null 并跳过 —— 那种"假图"不留）。
const path = require('path');

const OUT = 'C:/Users/Administrator/WorkBuddy/2026-09-16-16-28-57/hatch/lo-recon/shots-reopen';
let n = 0;
const shot = async (api, name) => {
  n += 1;
  const p = OUT + '/' + String(n).padStart(2, '0') + '-' + name + '.png';
  const r = await api.shot(p);
  api.log('shot ' + (r ? 'saved ' + p : 'skipped（窗口不可见）'));
  return r;
};

// 读界面状态（都走 DOM / 渲染层现有函数，不改代码）
const state = (api) => api.js(`(() => {
  const box = document.getElementById('session-tabs');
  const tabs = box ? [...box.querySelectorAll('.stab')].map((e) => ({
    name: (e.querySelector('.stab-name') || {}).textContent || '',
    active: e.classList.contains('active'),
    hasClose: !!e.querySelector('.stab-close'),
  })) : null;
  const foot = document.getElementById('btn-default-session');
  const sess = (window.S && S.sessions) || [];
  return {
    tabs,
    tabCount: tabs ? tabs.length : -1,
    footExists: !!foot,
    footLit: foot ? foot.classList.contains('on') : null,
    curId: (window.S && S.sessionId) || null,
    curModelSource: (window.S && S.session && S.session.modelSource) || null,
    sessions: sess.map((s) => ({ id: s.id.slice(0, 8), name: s.name, programId: s.programId })),
  };
})()`);

module.exports = async (api) => {
  const steps = {};
  const wait = api.wait;

  // 等 boot 落地
  for (let i = 0; i < 60; i += 1) {
    const ok = await api.js('!!(window.S && S.programs && document.getElementById("btn-default-session"))');
    if (ok) break;
    await wait(300);
  }
  await wait(900);
  steps.s0 = await state(api);
  await shot(api, '初始');

  // ---- ① 真鼠标点左下角那个固定入口：应当建出/进入 One Harness 会话 ----
  steps.clickFoot1 = await api.click('#btn-default-session', '左栏底部固定入口');
  await wait(1500);
  steps.s1 = await state(api);
  await shot(api, '点入口之后');

  // ---- ② 真鼠标点标签上的 ×（"上面的那个标签"）----
  steps.hasCloseBtn = await api.js(`!!document.querySelector('#session-tabs .stab .stab-close')`);
  if (steps.hasCloseBtn) {
    steps.clickClose = await api.click('#session-tabs .stab .stab-close', '会话标签上的 ×（关闭标签）');
    await wait(1200);
    steps.s2 = await state(api);
    await shot(api, '关掉标签之后');
  }

  // ---- ③ 再点一次底部入口：这才是用户说的"没法用了" ----
  steps.clickFoot2 = await api.click('#btn-default-session', '再点左栏底部固定入口');
  await wait(1600);
  steps.s3 = await state(api);
  await shot(api, '再点入口之后');

  steps.unhandled = await api.js('window.__mouseRejections || []');

  const created = steps.s1.sessions.length;
  steps.verdict = {
    '① 点入口建出（或进入）了专用会话': steps.s1.curModelSource === 'fallback' && created >= 1,
    '① 标签栏里出现了它的标签': (steps.s1.tabCount || 0) >= 1,
    '② 标签上的 × 用真鼠标点得到': steps.hasCloseBtn === true,
    '③ 关掉标签后：会话文件还在（不是被删）': steps.s2 ? steps.s2.sessions.length === created : null,
    '★ ③ 再点入口，仍然能进去（要有 modelSource=fallback 的当前会话）':
      steps.s3.curModelSource === 'fallback',
    '★ ③ 再点入口，标签回来了（tabCount ≥ 1）': (steps.s3.tabCount || 0) >= 1,
    '③ 再点入口之后入口是亮的': steps.s3.footLit === true,
    '全程无未处理异常': (steps.unhandled || []).length === 0,
  };
  const bad = Object.entries(steps.verdict).filter(([, v]) => !v);
  api.log('断言 ' + (Object.keys(steps.verdict).length - bad.length) + '/' +
    Object.keys(steps.verdict).length + (bad.length ? ' 失败：' + JSON.stringify(bad.map(([k]) => k)) : ''));
  api.log('明细 ' + JSON.stringify(steps));
  return steps;
};
