// 复现："把 One Harness 那个会话删了，左栏底部的固定入口就没法用了"。
//
// 只在**真产物**里跑：这个入口的取数要走 session.modelSource（内核侧）、
// 建会话要走存储层，开发态里的替身证明不了用户那一侧。
//
// 期望行为：删掉会话之后，点入口应当**重新建一个**，且立刻可对话（modelSource=fallback）。
(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $id = (i) => document.getElementById(i);
  const rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    rejections.push(String((e.reason && (e.reason.message || e.reason)) || e.reason));
  });
  const foot = () => $id('btn-default-session');
  const list = async () => api.sessions.list(S.projectId);

  for (let i = 0; i < 120 && !foot(); i++) await wait(200);
  await wait(800);

  const pid = S.projectId;
  out.projId = pid;

  // ---- 从干净状态起跑：先把当前项目的会话全删掉 ----
  for (const s of await list()) await api.sessions.remove({ projectId: pid, sessionId: s.id });
  // 界面侧同步一次（跟"删除会话"按钮同一条路径）
  if (typeof refreshSessions === 'function') await refreshSessions();
  await wait(400);
  out.startCount = (await list()).length;

  // ---- ① 第一次点入口：应当建出来 ----
  foot().click();
  await wait(1600);
  const after1 = await list();
  out.firstCount = after1.length;
  out.firstId = S.sessionId || null;
  out.firstModelSource = (S.session && S.session.modelSource) || null;

  // ---- ② 删掉它（模拟用户"把上面那个删了"：走界面那条删除路径）----
  const victim = S.sessionId;
  await api.sessions.remove({ projectId: pid, sessionId: victim });
  S.sessionId = null;
  S.session = null;
  S.meta = null;
  S.transcript = [];
  if (typeof refreshSessions === 'function') await refreshSessions();
  if (S.sessions.length && typeof loadSession === 'function') await loadSession(S.sessions[0].id);
  else if (typeof showNoSession === 'function') showNoSession();
  await wait(600);
  out.afterDeleteCount = (await list()).length;

  // ---- ③ 再点入口：这里就是用户说的"没法用了" ----
  foot().click();
  await wait(1800);
  const after2 = await list();
  out.secondCount = after2.length;
  out.secondId = S.sessionId || null;
  out.secondModelSource = (S.session && S.session.modelSource) || null;

  // 建出来的会话要能真的加载（不是"建了但打不开"）
  out.reloadable = null;
  if (S.sessionId) {
    try {
      const r = await api.sessions.load({ projectId: pid, sessionId: S.sessionId });
      out.reloadable = !!(r && r.session && r.session.modelSource === 'fallback');
    } catch (e) { out.reloadable = 'ERR ' + (e.message || e); }
  }
  out.lit = foot().classList.contains('on');

  out.verdict = {
    '起点干净：项目里 0 个会话': out.startCount === 0,
    '① 点入口能建出专用会话': out.firstCount === 1 && out.firstModelSource === 'fallback',
    '② 删掉之后项目里确实没有会话了': out.afterDeleteCount === 0,
    '★ ③ 删掉后再点入口仍能重建（用户报的 bug）':
      out.secondCount === 1 && out.secondModelSource === 'fallback',
    '★ 重建出来的会话能真的加载出来': out.reloadable === true,
    '进去之后入口点亮': out.lit === true,
    '全程无未处理异常': rejections.length === 0,
  };
  out.rejections = rejections;
  if (!Object.values(out.verdict).every(Boolean)) {
    throw new Error('断言失败 ' + JSON.stringify(out.verdict) + ' :: ' + JSON.stringify(out));
  }
  return out;
})();
