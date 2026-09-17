/* 复现/验证：跨项目标签 + 陈旧 active 时关标签会不会报「会话不存在」。
 * 跑法： node test/repro-run.js test/.tmp-repro/data test/repro-tabs.probe.js
 *
 * 现场推演（用户真实数据里就是这样）：
 *   pane.tabs 是**所有项目共用**的一条数组，而标签栏只画当前项目的标签。
 *   关闭标签时旧代码用 pane.tabs[pane.active] 当"下一个"，active 又长期停在
 *   别的项目的标签上，于是把别的项目的会话 id 拿到当前项目里加载 → 报错。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rej = [];
  window.addEventListener('unhandledrejection', (e) => {
    rej.push(String((e.reason && e.reason.message) || e.reason));
  });

  const p = () => tabsPane();
  const short = (t) => String(t).replace(/^session:/, '').split(':').map((x) => x.slice(0, 8)).join('→');
  const notes = {};

  await sleep(1800);

  // ---- 关标签之前的现场 ----
  const pane = p();
  const beforeActive = pane.active;
  const beforeTabs = pane.tabs.slice();
  notes['当前项目'] = String(S.projectId).slice(0, 8);
  notes['当前会话'] = S.sessionId ? String(S.sessionId).slice(0, 8) : null;
  notes['左栏收起'] = document.getElementById('app-root').classList.contains('no-left');
  notes['标签总数'] = beforeTabs.length;
  notes['标签栏画了几个'] = document.querySelectorAll('#session-tabs .stab').length;
  notes['active 下标'] = beforeActive;

  // ---- 按「旧逻辑」推演：关掉当前标签后会去开谁 ----
  const closing = tabIdFor(S.projectId, S.sessionId);
  const ci = beforeTabs.indexOf(closing);
  const rest = beforeTabs.slice();
  if (ci >= 0) rest.splice(ci, 1);
  const oldActive = Math.min(beforeActive, rest.length - 1);
  notes['旧逻辑的 next'] = short(rest[oldActive] || '(空)');
  notes['旧逻辑 next 属于当前项目吗'] = String(rest[oldActive] || '').startsWith('session:' + S.projectId + ':');

  // ---- 真点一次标签上的 ×（就是用户那个操作）----
  const x = document.querySelector('#session-tabs .stab .stab-close');
  if (!x) return { 结论: '标签栏里没有标签，没法复现', notes, rejections: rej };
  x.click();
  await sleep(1800);

  const paneAfter = p();
  notes['点完之后当前会话'] = S.sessionId ? String(S.sessionId).slice(0, 8) : null;
  notes['点完之后 active'] = paneAfter.active;
  notes['点完之后标签数'] = paneAfter.tabs.length;
  notes['点完之后标签栏画了几个'] = document.querySelectorAll('#session-tabs .stab').length;
  notes['界面上有没有报错'] = [...document.querySelectorAll('#toasts .toast')].map((e) => e.textContent);
  notes['主区空态文案'] = (document.querySelector('#transcript .empty') || {}).textContent || null;

  return { notes, rejections: rej, 未处理异常条数: rej.length };
})();
