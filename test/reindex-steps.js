'use strict';
// 探针（渲染层注入）：**正文已经在盘上**时，导入索引需不需要重启？
//
// 场景就是用户问的那个：工程文件夹（连同里面的 .one-harness 记录）已经在盘上，
// 但索引里没有这一行（左栏看不到这个工程）。导入索引之后应当：
//   ① 工程出现在左栏；
//   ② 会话列表跟着重读，那条老会话显示出来；
//   ③ 点开该工程，正文立刻加载出来（不需要重启、不需要手工刷新）；
//   ④ 不出现"文件夹在本机不存在"这类提示（gone 应该是 0）。
//
// 由 test/run-reindex.js 起：它先用 core 造出"正文在、索引摘掉"的数据目录
// （这个不一致状态没法走 API 造出来），再让 run-ui 注入本文件。
// 工程 id 是随机 uuid，所以这里**动态发现**新增的那个工程，不硬编码。
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const PROJECT_NAME = '老工程';
  const SESSION_NAME = '老机器上的会话';

  for (let i = 0; i < 60; i++) {
    if (typeof S !== 'undefined' && typeof api !== 'undefined' && typeof openSettings === 'function') break;
    await wait(150);
  }
  const out = { steps: [] };
  const step = (name, detail) => out.steps.push(Object.assign({ name }, detail));
  const toasts = () => [...document.querySelectorAll('#toasts .toast')].map((e) => e.textContent).join(' ~ ');
  const treeText = () => { const el = document.getElementById('project-tree'); return el ? el.textContent : ''; };
  const trText = () => { const el = document.getElementById('transcript'); return el ? el.textContent : ''; };

  const before = (S.projects || []).map((p) => p.id);

  // ---------- ① 起始：索引里没有，左栏看不到它 ----------
  // 盘上确实有正文这件事由 run-reindex.js 那一步保证（它用程序自己造了 2 条 entry）；
  // 这里只断言界面侧：那个工程不在列表里 —— 索引是"能不能被看见"的唯一依据。
  step('① 起始：索引里没有这个工程，所以左栏看不到它', {
    projects: before.length,
    inTree: treeText().indexOf(PROJECT_NAME) >= 0,
  });

  // ---------- ② 走界面：导入索引 ----------
  openSettings('general');
  for (let i = 0; i < 60; i++) {
    if (document.getElementById('btn-import-index')) break;
    await wait(150);
  }
  await wait(300);
  document.getElementById('toasts').innerHTML = '';
  document.getElementById('btn-import-index').click();
  await wait(2000);

  const added = (S.projects || []).find((p) => before.indexOf(p.id) < 0) || null;
  const t = toasts();
  const tree = added ? ((S.tree || {})[added.id] || []) : [];
  step('② 导入索引后（没重启、没手工刷新）', {
    toast: t,
    projectsAfter: (S.projects || []).length,
    newProjectName: added ? added.name : null,
    treeTextHasProject: treeText().indexOf(PROJECT_NAME) >= 0,
    treeEntries: tree.length,
    treeEntryName: tree[0] ? tree[0].name : null,
    treeTextHasSession: treeText().indexOf(SESSION_NAME) >= 0,
    noOrphanWarn: t.indexOf('没有会话记录') < 0,
  });

  // ---------- ③ 点开那个工程（用户的实际动作）：正文立刻出来 ----------
  // 注意：导入后**不会**自动切过去 —— 渲染层只在"当前还没选中任何工程"时才自动选第一个
  // （app.js: `if (!S.projectId && S.projects.length)`），而这里本机已有一个默认工程。
  if (added) {
    await setProject(added.id);
    await wait(1500);
  }
  step('③ 点开该工程：正文立刻加载出来（不需要重启）', {
    switched: !!added && S.projectId === added.id,
    sessionName: (S.sessions[0] || {}).name || null,
    transcriptHasHello: trText().indexOf('你好') >= 0,
    transcriptHasReply: trText().indexOf('在') >= 0,
  });

  // ---------- 自判定：任一条不成立就让跑分器给出非零退出码 ----------
  const [s0, s1, s2] = out.steps;
  const ok = s0.inTree === false
    && s1.projectsAfter === s0.projects + 1
    && s1.newProjectName === PROJECT_NAME
    && s1.treeEntries === 1
    && s1.treeEntryName === SESSION_NAME
    && s1.treeTextHasProject === true
    && s1.treeTextHasSession === true
    && s1.noOrphanWarn === true
    && s2.switched === true
    && s2.transcriptHasHello === true
    && s2.transcriptHasReply === true;
  if (!ok) throw new Error('导入索引后未能立刻看到正文：' + JSON.stringify(out.steps));

  return out;
})();
