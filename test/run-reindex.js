'use strict';
// 跑分器：验证「正文已经在盘上时，导入索引之后界面需不需要重启」。
// 运行： node test/run-reindex.js
//
// 为什么要单独一个跑分器，而不是塞进 run-ui 的常规套件：
// 本场景要的初始状态是「工程目录里有会话正文，但 projects.json 里没有这一行」——
// **这个不一致状态没法用 API 造出来**（走 API 建会话必然同时写索引），
// 所以必须在起界面之前用 core 直接铺好数据，而常规 UI 套件每次都是干净数据目录。
// （顺带：这个状态不是造假的产物，它就是「删除项目只摘索引、正文留在盘上」之后的样子。）

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp-reindex');
const DATA = path.join(TMP, 'data');

// ---------- ① 铺数据（必须在 require store 之前定好数据目录）----------
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.HATCH_DATA_DIR = DATA;

const store = require('../core/store');
const sessionLib = require('../core/session');

const project = store.createProject('老工程', 'C:/tmp/old-ws');
const ses = sessionLib.createSession({ projectId: project.id, name: '老机器上的会话' });
sessionLib.userMessage(ses, '你好');
sessionLib.assistantMessage(ses, [{ type: 'text', text: '在' }]);
store.saveSession(project.id, ses);

// 摘掉索引行 —— 正文仍留在 projects/<id>/sessions/ 下
store.writeProjects([]);

// 给界面的「导入」准备一份同 id 的索引备份（HATCH_OPEN_PATH 指过来，不弹原生框）
const idxFile = path.join(TMP, 'incoming.json');
fs.writeFileSync(idxFile, JSON.stringify({
  kind: 'one-harness/project-index',
  version: 1,
  exportedAt: Date.now(),
  app: { name: 'One Harness', version: 'reindex-test' },
  count: 1,
  projects: [{ id: project.id, name: project.name, cwd: project.cwd, createdAt: project.createdAt }],
}, null, 2));

console.log('铺好了：工程 ' + project.id.slice(0, 8) + ' 的 ' + ses.entries.length + ' 条正文在盘上，索引里没有它');

// ---------- ② 起界面，注入探针 ----------
const r = spawnSync(process.execPath, [path.join(__dirname, 'run-ui.js'), 'test/reindex-steps.js'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    HATCH_UI_KEEP_DATA: '1',                       // 别清掉上面铺好的数据
    HATCH_UI_DATA_DIR: path.relative(ROOT, DATA),  // run-ui 相对 ROOT 解析
    HATCH_OPEN_PATH: idxFile,
    HATCH_UI_TIMEOUT: '120000',
  },
});

process.exit(r.status === null ? 1 : r.status);
