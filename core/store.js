'use strict';
// 数据层：所有状态都落在应用目录内（自包含，搬走即用）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const DEFAULT_SETTINGS = {
  model: {
    // 默认指向本机那个 OpenAI 兼容代理（PCswitch，挂着一批云端模型）。
    // 指向任何 OpenAI 兼容端点都行，在设置里改 Base URL 即可。
    baseUrl: 'http://127.0.0.1:8787/v1',
    apiKey: '',
    // 这个代理的 /v1/models 会列出好几个模型，但实测只有 deepseek-v4.1-flash 真能跑
    // （其余名字回车是 404 model_not_found），所以默认写死这个实测可用的。
    // 换端点后如果这个名字不存在，main.js 的 resolveModel 会自动改用端点列表的第一个。
    model: 'deepseek-v4.1-flash',
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

function getSettings() {
  return deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
}

function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch);
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

function createProject(name, cwd) {
  const id = newId();
  const dir = path.join(PROJECTS_DIR, id);
  const workspace = cwd && fs.existsSync(cwd) ? cwd : path.join(dir, 'workspace');
  ensureDir(workspace);
  ensureDir(path.join(dir, 'sessions'));
  const project = { id, name: name || '未命名项目', cwd: workspace, createdAt: Date.now() };
  const db = readJson(PROJECTS_FILE, { projects: [] });
  db.projects.push(project);
  writeJsonAtomic(PROJECTS_FILE, db);
  return project;
}

function projectDir(projectId) {
  return path.join(PROJECTS_DIR, projectId);
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
 * 项目自己的记录目录、工作目录、会话数、工作目录是不是就在记录目录里（自动创建的 workspace）。
 */
function projectDeleteInfo(projectId) {
  const p = getProject(projectId);
  if (!p) return null;
  const dir = projectDir(projectId);
  const rel = p.cwd ? path.relative(dir, p.cwd) : '';
  let sessionCount = 0;
  try { sessionCount = listSessions(projectId).length; } catch (_) { sessionCount = 0; }
  return {
    id: p.id,
    name: p.name,
    cwd: p.cwd || null,
    projectDir: dir,
    sessionCount,
    cwdInsideProjectDir: !!rel && !rel.startsWith('..') && !path.isAbsolute(rel),
  };
}

// ---- sessions ----
function sessionsDir(projectId) {
  return ensureDir(path.join(projectDir(projectId), 'sessions'));
}

function sessionFile(projectId, sessionId) {
  return path.join(sessionsDir(projectId), sessionId + '.json');
}

function listSessions(projectId) {
  const dir = sessionsDir(projectId);
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
  writeJsonAtomic(sessionFile(projectId, session.id), session);
  return session;
}

function copyFileIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

module.exports = {
  ROOT, APP_ROOT, DATA_DIR, PROJECTS_DIR, SETTINGS_FILE, DEFAULT_SETTINGS,
  init, ensureDir, readJson, writeJsonAtomic, deepMerge, getSettings, saveSettings,
  newId, shortId, listProjects, createProject, getProject, updateProject, deleteProject,
  projectDeleteInfo, projectDir,
  listSessions, loadSession, saveSession, sessionFile, copyFileIfExists,
};
