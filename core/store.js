'use strict';
// 数据层：所有状态都落在应用目录内（自包含，搬走即用）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const projectIndex = require('./project-index');

// 打包成绿色版（electron-builder 默认把代码放进 app.asar）后，__dirname 落在 asar 内部 ——
// 那是只读的，而且用户根本看不到它。绿色版的要求是"整个文件夹拷到哪、数据就跟到哪"，
// 所以 packaged 时把根目录换成 exe 所在的文件夹（win-unpacked/One Harness.exe → win-unpacked/）。
// 开发态（npm start）保持 repo 根目录不变，现有的 data/、测试钩子一律不受影响。
const ROOT = (() => {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.dirname(app.getPath('exe'));
  } catch (_) { /* 纯 node 场景（测试/扫描脚本）没有 electron，忽略 */ }
  return path.resolve(__dirname, '..');
})();
// 代码自身的所在：开发态 = repo 根；打包后 = app.asar 内（Electron 能透明读 asar）。
// 随程序分发的只读资源（内置技能等）走这个，用户可见可写的东西一律走 ROOT。
const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.HATCH_DATA_DIR ? path.resolve(process.env.HATCH_DATA_DIR) : path.join(ROOT, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
// 程序在**工程文件夹里**落记录用的子目录：会话、检查点、临时文件都放它下面。
// 记录跟着工程文件夹走 —— 文件夹拷到哪、对话跟到哪；换一个程序版本打开同一个文件夹，
// 对话照样在，因为读的就是这个文件夹。程序数据目录里只留 projects.json 那张指针表。
// （以前记录放在 <数据目录>/projects/<工程 id>/ 下，等于把用户数据收到程序自己的目录里，
//  文件夹一换位置对话就"消失"了 —— 那是不对的。）
const RECORD_DIR = '.one-harness';
// 出厂默认端点（baseUrl / apiKey / model）读的是随包的 `config/model.json`，不是写死在代码里。
// 两处都找一遍，谁先有谁算：
//   · ROOT/config/model.json      —— 打包后 ROOT = exe 所在目录（绿色版：改这里最顺手）
//   · APP_ROOT/config/model.json  —— 代码自带的那份（asar:false 时在 resources/app/ 下）
// 开发态这两个是同一个路径（repo 根），只会命中一个。
const DEFAULT_MODEL_FILES = [
  path.join(ROOT, 'config', 'model.json'),
  path.join(APP_ROOT, 'config', 'model.json'),
];

const DEFAULT_SETTINGS = {
  model: {
    // 端点三件套（baseUrl / apiKey / model）**不写在这里** —— 出厂默认放在随包的配置文件
    // `config/model.json` 里，想让默认模型换一个，改那个 json 就行，不用动代码。
    // 这里一律留空串，语义是「用户还没填」：getSettings() 读的时候会拿 config/model.json 补上；
    // 所以空串 ≠ 「连一个空端点」，它只是"待补"的占位。
    baseUrl: '',
    apiKey: '',
    model: '',
    // 这个模型能不能吃图片输入。**只能手勾，探测不出来** —— 实测这类兼容端点的
    // /v1/models 只回 {id, object}，没有任何能力字段（OpenAI 规范里本来也没有）。
    // 默认 false：不发图永远不会错，勾错了代价是整轮 400（agent.js 会剥图重发并提示）。
    supportsVision: false,
    temperature: 0.3,
    maxTokens: -1,
    contextLength: 16384,      // 仅用于上下文占用估算
  },
  agent: {
    maxSteps: 40,
    autoCompactRatio: 0.9375,
    requestTimeoutMs: 300000,
    streamIdleTimeoutMs: 180000,
  },
  approval: {
    mode: 'reviewer',          // auto | reviewer | always-ask
    highRiskThreshold: 'medium',
    reviewerModel: '',         // 空 = 跟主模型相同
    onReviewerFailure: 'ask',  // 评审调用失败/输出无法解析时：ask（转人工，失败安全）| allow（照常放行）
  },
  shell: {
    timeoutMs: 120000,
    shellPath: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
  },
  python: {
    executable: process.platform === 'win32' ? 'python' : 'python3',
  },
  web: {
    searchEndpoint: '',        // 留空则关闭联网搜索；填 SearxNG 实例地址即可
    fetchTimeoutMs: 20000,
    maxChars: 20000,
  },
  ui: {
    theme: 'dark',
    inlineDiff: true,
  },
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function init() {
  ensureDir(DATA_DIR);
  ensureDir(PROJECTS_DIR);
  if (!fs.existsSync(SETTINGS_FILE)) writeJsonAtomic(SETTINGS_FILE, DEFAULT_SETTINGS);
  if (!fs.existsSync(PROJECTS_FILE)) writeJsonAtomic(PROJECTS_FILE, { projects: [] });
  ensureDir(path.join(DATA_DIR, 'skills'));
}

/**
 * 出厂默认端点：读随包的 config/model.json。
 * 文件被删了、写坏了、或者压根没打包进去 —— 都不能让程序起不来，
 * 退回"全空"（= 用户在设置里自己填），而不是抛错。
 * 只认 baseUrl / apiKey / model 三个字段；文件里那些 `_说明` 之类的注释键不参与。
 */
function readDefaultModel() {
  for (const f of DEFAULT_MODEL_FILES) {
    const c = readJson(f, null);
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      return {
        baseUrl: String(c.baseUrl || '').trim(),
        apiKey: String(c.apiKey || '').trim(),
        model: String(c.model || '').trim(),
      };
    }
  }
  return { baseUrl: '', apiKey: '', model: '' };
}

/**
 * 生效设置 = 内置默认 ← settings.json ← config/model.json 兜住"空"的那部分。
 * 判定规则只有一条：**空 = 没填 = 用出厂默认**。
 * 用户真填过的值永远优先（这是他自己的选择，不许被配置文件盖掉）。
 */
function getSettings() {
  const saved = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
  const def = readDefaultModel();
  const model = { ...saved.model };
  for (const k of ['baseUrl', 'apiKey', 'model']) {
    if (!String(model[k] || '').trim()) model[k] = def[k];
  }
  return { ...saved, model };
}

function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch);
  // **别把"出厂默认值"当成用户的选择存进去**。
  // 否则用户只是进设置改了个主题、顺手点了保存，端点就被钉死在 settings.json 里，
  // 之后再改 config/model.json 就永远不生效 —— 他会觉得"我改了没用"。
  // 规则：值 == 出厂默认（或为空）→ 存空串。读的时候还会解析成同一个值，行为不变。
  if (next.model) {
    const def = readDefaultModel();
    for (const k of ['baseUrl', 'apiKey', 'model']) {
      if (String(next.model[k] || '').trim() === def[k]) next.model[k] = '';
    }
  }
  writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

function newId() {
  return crypto.randomUUID();
}

function shortId(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8);
}

// ---- projects ----
function listProjects() {
  return readJson(PROJECTS_FILE, { projects: [] }).projects;
}

/**
 * 建工程 —— **先按地址查重**：同一个工程文件夹永远只对应一个工程。
 * 以前每个 id 各认各的，同一个文件夹被打开两次就是两个工程、两套记录
 * （本机数据里同一个 someidea 有三条、rmzmv1070 有四条），所以必须先认地址。
 * 没给地址（或给的目录不存在）时，在数据目录里给它一个自建 workspace 当工程文件夹。
 */
function createProject(name, cwd) {
  const want = cwd && String(cwd).trim() ? path.resolve(String(cwd)) : null;
  if (want && fs.existsSync(want)) {
    const same = listProjects().find((p) => p.cwd && path.resolve(p.cwd) === want);
    if (same) return same;
  }
  const id = newId();
  const root = want && fs.existsSync(want) ? want : path.join(PROJECTS_DIR, id, 'workspace');
  ensureDir(root);
  const project = { id, name: name || '未命名项目', cwd: root, createdAt: Date.now() };
  const db = readJson(PROJECTS_FILE, { projects: [] });
  db.projects.push(project);
  writeJsonAtomic(PROJECTS_FILE, db);
  return project;
}

/** 工程文件夹 —— 用户自己的目录，也是记录的落脚点。读路径，不建目录。 */
function projectRoot(projectId) {
  const p = getProject(projectId);
  if (p && p.cwd) return p.cwd;
  // 索引里没有这一行、或那一行没有 cwd：退回它自建的 workspace
  return path.join(PROJECTS_DIR, projectId, 'workspace');
}

/** 程序为这个工程写下的记录目录：<工程文件夹>/.one-harness */
function projectDataDir(projectId) {
  return path.join(projectRoot(projectId), RECORD_DIR);
}

function getProject(projectId) {
  return listProjects().find((p) => p.id === projectId) || null;
}

function updateProject(projectId, patch) {
  const db = readJson(PROJECTS_FILE, { projects: [] });
  const i = db.projects.findIndex((p) => p.id === projectId);
  if (i < 0) return null;
  db.projects[i] = { ...db.projects[i], ...patch };
  writeJsonAtomic(PROJECTS_FILE, db);
  return db.projects[i];
}

/**
 * 删除项目 —— **只摘索引**：把这一条从 projects.json 里移除，别的一律不动。
 * 磁盘上的 <数据目录>/projects/<id>/（会话记录、检查点、自动创建的 workspace）与项目的
 * 工作目录都原样保留，所以这一步是可逆的：反悔了可以手工把这条记录写回去，
 * 想彻底清掉则手工删掉那个目录。语义与「删除会话只删会话记录」一致 ——
 * 只摘掉登记表上的一行，不动任何内容文件。
 * （工作目录尤其不能碰：用户选的是自己的目录，里面是用户的文件。）
 */
function deleteProject(projectId) {
  const db = readJson(PROJECTS_FILE, { projects: [] });
  const i = db.projects.findIndex((p) => p.id === projectId);
  if (i < 0) return false;
  db.projects.splice(i, 1);
  writeJsonAtomic(PROJECTS_FILE, db);
  return true;
}

/**
 * 删除前给界面写确认文案用的事实（只读，不删任何东西）：
 * 工程文件夹（用户自己的目录）、程序写下的记录目录、会话数，
 * 以及工作目录是不是程序自建的那个 workspace（只有那种才归程序自己管）。
 */
function projectDeleteInfo(projectId) {
  const p = getProject(projectId);
  if (!p) return null;
  let sessionCount = 0;
  try { sessionCount = listSessions(projectId).length; } catch (_) { sessionCount = 0; }
  const selfWs = path.join(PROJECTS_DIR, projectId, 'workspace');
  return {
    id: p.id,
    name: p.name,
    cwd: p.cwd || null,
    root: p.cwd || null,
    recordDir: projectDataDir(projectId),
    sessionCount,
    selfWorkspace: !!p.cwd && path.resolve(p.cwd) === path.resolve(selfWs),
  };
}

// ---- 工程索引的导出 / 导入 ----
// 两件事都**只动 projects.json**：会话正文（projects/<id>/sessions/）与工作目录一律不碰。
// 判定逻辑（打包形状、合并规则）全在 core/project-index.js 里，这里只负责读写盘 ——
// 于是"导入会不会覆盖我的工程"这种问题能在单测里回答，不用起界面。
function writeProjects(list) {
  const out = Array.isArray(list) ? list : [];
  writeJsonAtomic(PROJECTS_FILE, { projects: out });
  return out;
}

function exportProjectIndex(destPath, meta) {
  const bundle = projectIndex.build(listProjects(), meta);
  writeJsonAtomic(destPath, bundle);
  return { path: destPath, count: bundle.projects.length, bytes: fs.statSync(destPath).size };
}

/**
 * 导入：解析 → 合并（只增不减，见 core/project-index.js 的 merge）→ 写回。
 * 索引导入只接回**指针**，所以要照实说两件事（都不代表出错，但用户得知道）：
 *   gone  = 指向的工程文件夹在本机不存在 —— 这条目前指不到东西（文件夹放回原处就恢复）；
 *   empty = 文件夹在、但里面还没有记录 —— 就是个空工程。
 * 会话正文本来就在工程文件夹里、跟着文件夹走，所以这里没有"搬正文"这回事。
 */
function importProjectIndex(srcPath) {
  let text;
  try {
    text = fs.readFileSync(srcPath, 'utf8');
  } catch (e) {
    return { ok: false, error: '读不到这个文件：' + String((e && e.message) || e) };
  }
  const parsed = projectIndex.parse(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const before = listProjects();
  const merged = projectIndex.merge(before, parsed.projects);
  if (merged.added) writeProjects(merged.projects);

  let gone = 0;
  let empty = 0;
  for (const id of merged.addedIds) {
    const p = getProject(id);
    if (!p || !p.cwd || !fs.existsSync(p.cwd)) { gone++; continue; }
    let n = 0;
    try { n = listSessions(id).length; } catch (_) { n = 0; }
    if (!n) empty++;
  }
  return {
    ok: true,
    path: srcPath,
    added: merged.added,
    skipped: merged.skipped,
    total: merged.projects.length,
    gone,
    empty,
    declared: parsed.meta.declared,
    // 文件里声称 N 条、实际能用的只有 M 条 → 差额是"缺 id 之类被忽略"的行数。
    // 单独报出来，免得手工整理过的清单里少了几条却没人发现（skipped 只说"已有"）。
    invalid: Math.max(0, parsed.meta.declared - merged.added - merged.skipped),
    legacy: parsed.meta.legacy,
  };
}

// ---- sessions ----
// 会话记录落在**工程文件夹**里：<工程文件夹>/.one-harness/sessions/<会话 id>.json。
// 读路径不建目录（ensureDir 只在写的时候调）—— 否则工程文件夹被删掉后，程序光看一眼列表
// 就会把它又"建"出来。
function sessionsDir(projectId) {
  return path.join(projectDataDir(projectId), 'sessions');
}

function sessionFile(projectId, sessionId) {
  return path.join(sessionsDir(projectId), sessionId + '.json');
}

function listSessions(projectId) {
  const dir = sessionsDir(projectId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean)
    .map((s) => ({
      id: s.id,
      name: s.name,
      programId: s.programId,
      updatedAt: s.updatedAt,
      entryCount: s.entries.length,
      parentSessionId: s.parentSessionId || null,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function loadSession(projectId, sessionId) {
  return readJson(sessionFile(projectId, sessionId), null);
}

function saveSession(projectId, session) {
  session.updatedAt = Date.now();
  ensureDir(sessionsDir(projectId));
  writeJsonAtomic(sessionFile(projectId, session.id), session);
  return session;
}

function copyFileIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

// 同名就往后加 -1 / -2 …，**永不覆盖**已有文件。
// 两处在用：office 工具的产物落盘（core/tools/office.js）、拖入的附件复制进工作目录（main.js）。
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

module.exports = {
  ROOT, APP_ROOT, DATA_DIR, PROJECTS_DIR, SETTINGS_FILE, DEFAULT_SETTINGS,
  init, ensureDir, readJson, writeJsonAtomic, deepMerge, getSettings, saveSettings,
  readDefaultModel, DEFAULT_MODEL_FILES,
  newId, shortId, listProjects, createProject, getProject, updateProject, deleteProject,
  uniquePath,
  projectDeleteInfo, projectRoot, projectDataDir, RECORD_DIR,
  writeProjects, exportProjectIndex, importProjectIndex,
  listSessions, loadSession, saveSession, sessionFile, copyFileIfExists,
};
