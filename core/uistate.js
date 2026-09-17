'use strict';
// 界面布局状态。结构对齐 LM Studio Bionic 的 ui-state：
//
//   <data>/ui-state/global.json         跨窗口的全局状态（上次窗口位置尺寸、主题、打开过的窗口键）
//   <data>/ui-state/window-<key>.json   单个窗口的布局（左右栏宽度、折叠、当前视图、分栏树）
//
// 字段名跟 Bionic 保持一致，方便两边逐字段对照。唯一的差别是面板块的名字：
// Bionic 叫 "bionic"，这里叫 "workspace"——
//   window-<key>.json
//     ├─ projectIdentifier / windowBounds / zoomLevel / tabLayouts   ← 同名
//     ├─ windowContext.{type, projectIdentifiers,
//                       activeProjectIdentifier}                     ← 同名（Bionic 用它记"这个窗口打开过哪些项目、当前是哪个"）
//     ├─ expandedKvConfigSections                                    ← 同名（Bionic 放在 window 层，**不是** global）
//     └─ workspace.{leftSidebarWidth, leftSidebarIsCollapsed,
//                   rightPanelWidth, rightPanelIsCollapsed,
//                   devRightPanelView, activeModePath, ...}          ← 对应 bionic.*
//
// 这些字段名用 test/bionic-compare.js 对着**本机真实安装的 Bionic** 逐项核过
// （它读 ~/.lmstudio/.internal/ui-state/bionic/ 做对照），别再凭印象改名。
//
// 写盘一律走原子替换，读盘一律 deepMerge 默认值，所以文件缺字段、手改坏了都不会崩。

const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDir, readJson, writeJsonAtomic, deepMerge } = require('./store');

const UI_STATE_DIR = path.join(DATA_DIR, 'ui-state');
const GLOBAL_FILE = path.join(UI_STATE_DIR, 'global.json');

const DEFAULT_BOUNDS = { x: null, y: null, width: 1360, height: 880 };

const DEFAULT_GLOBAL = {
  themeId: 'system',
  lastActiveWindowBounds: { ...DEFAULT_BOUNDS },
  openedWindowKeys: [],
  windowKeyByProjectPathEntries: [],
};

function defaultWindowState() {
  return {
    projectIdentifier: null,
    // Bionic 用 windowContext 记"这个窗口属于哪类上下文、打开过哪些项目、当前是哪个"。
    // 之前 One Harness 把当前项目塞在 workspace.activeProjectId 里（Bionic 没有这个名字），
    // 现在按 Bionic 的形状搬到顶层。
    windowContext: { type: 'workspace', projectIdentifiers: [], activeProjectIdentifier: null },
    windowBounds: { ...DEFAULT_BOUNDS },
    // 上次关窗时是不是最大化。无边框窗口要自己记，否则还原后尺寸会被"常规尺寸"吃掉。
    windowMaximized: false,
    zoomLevel: 0,
    // 展开过的 KV 配置分区。Bionic 把它放在 window 层（global.json 里没有这个字段）。
    expandedKvConfigSections: [],
    workspace: {
      activeModePath: '/agent',
      leftSidebarWidth: 220,
      leftSidebarIsCollapsed: false,
      rightPanelWidth: 345,
      // Bionic 的界面上没有常驻右栏（它的 rightPanelWidth 一直是 null），
      // 资料面板是按需拉开的，所以这里默认收起。
      rightPanelIsCollapsed: true,
      // Bionic 叫 devRightPanelView（不是 rightPanelView）—— 名字照抄，别再简化。
      devRightPanelView: 'files',
      activeSessionPerProjectIdentifier: {},
      workspaceSidebarCollapsedProjectIdentifiers: [],
      projectFilesExpandedDirectoryEntries: [],
      composerHeight: null,
      orchestratorFloatingPanelSize: { width: 480, height: 600 },
    },
    tabLayouts: {},
  };
}

// 面板宽度的边界，跟 UI 一起用；越界值在写盘前就夹掉，避免手改 json 把界面撑坏。
const PANEL_LIMITS = {
  leftSidebarWidth: [168, 520],
  rightPanelWidth: [240, 640],
};

function windowFile(key) {
  const safe = String(key || 'main').replace(/[^\w.-]/g, '_');
  return path.join(UI_STATE_DIR, 'window-' + safe + '.json');
}

function ensureInit() {
  ensureDir(UI_STATE_DIR);
  if (!fs.existsSync(GLOBAL_FILE)) writeJsonAtomic(GLOBAL_FILE, DEFAULT_GLOBAL);
}

function clampPanel(key, value) {
  const lim = PANEL_LIMITS[key];
  if (!lim) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(lim[1], Math.max(lim[0], Math.round(n)));
}

/** 把 patch 收进已知字段，顺手做类型与范围校正。返回可落盘的补丁。 */
function sanitizeWindowPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('projectIdentifier' in patch) out.projectIdentifier = patch.projectIdentifier || null;
  if ('windowMaximized' in patch) out.windowMaximized = !!patch.windowMaximized;
  if ('zoomLevel' in patch && Number.isFinite(Number(patch.zoomLevel))) out.zoomLevel = Number(patch.zoomLevel);
  if (patch.windowBounds && typeof patch.windowBounds === 'object') {
    const b = patch.windowBounds;
    out.windowBounds = {
      x: Number.isFinite(b.x) ? Math.round(b.x) : null,
      y: Number.isFinite(b.y) ? Math.round(b.y) : null,
      width: Math.max(800, Math.round(Number(b.width) || DEFAULT_BOUNDS.width)),
      height: Math.max(560, Math.round(Number(b.height) || DEFAULT_BOUNDS.height)),
    };
  }
  if (patch.tabLayouts && typeof patch.tabLayouts === 'object') out.tabLayouts = patch.tabLayouts;
  if (Array.isArray(patch.expandedKvConfigSections)) out.expandedKvConfigSections = patch.expandedKvConfigSections.slice();
  if (patch.windowContext && typeof patch.windowContext === 'object') {
    const c = patch.windowContext;
    out.windowContext = {
      type: typeof c.type === 'string' ? c.type : 'workspace',
      projectIdentifiers: Array.isArray(c.projectIdentifiers) ? c.projectIdentifiers.slice() : [],
      activeProjectIdentifier: c.activeProjectIdentifier || null,
    };
  }
  if (patch.workspace && typeof patch.workspace === 'object') {
    const src = { ...patch.workspace };
    // 旧字段名迁移（对齐 Bionic 时改过名，别让用户已有的布局白丢）：
    //   rightPanelView → devRightPanelView（Bionic 的真实名字）
    //   workspace.activeProjectId → 顶层 windowContext.activeProjectIdentifier
    if (src.rightPanelView !== undefined && src.devRightPanelView === undefined) src.devRightPanelView = src.rightPanelView;
    if (src.activeProjectId && !out.windowContext) {
      out.windowContext = { type: 'workspace', projectIdentifiers: [], activeProjectIdentifier: src.activeProjectId };
    }
    const w = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === 'activeProjectId' || k === 'rightPanelView') continue; // 旧名，已搬到新位置
      if (k === 'leftSidebarWidth' || k === 'rightPanelWidth') {
        const c = clampPanel(k, v);
        if (c !== null) w[k] = c;
      } else if (k === 'composerHeight') {
        w[k] = Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null;
      } else {
        w[k] = v;
      }
    }
    out.workspace = w;
  }
  return out;
}

// ---- 全局 ----
function readGlobal() {
  ensureInit();
  const raw = readJson(GLOBAL_FILE, {});
  // 只认自己定义过的键：老版本写进去的、或者手改留下的废弃字段
  // （比如 expandedKvConfigSections 已经按 Bionic 的层级搬到 window 了），
  // 不能继续躺在 global 里 —— 否则 test/bionic-compare.js 会一直报"只有 One Harness 有"。
  const picked = {};
  for (const k of Object.keys(DEFAULT_GLOBAL)) if (k in raw) picked[k] = raw[k];
  return deepMerge(DEFAULT_GLOBAL, picked);
}

function writeGlobal(next) {
  ensureInit();
  writeJsonAtomic(GLOBAL_FILE, next);
  return next;
}

function patchGlobal(patch) {
  return writeGlobal(deepMerge(readGlobal(), patch || {}));
}

/** 记录窗口几何（去重：跟上次完全一样就不写盘）。 */
function saveWindowBounds(bounds) {
  if (!bounds) return null;
  const clean = {
    x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : null,
    y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : null,
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  const g = readGlobal();
  const prev = g.lastActiveWindowBounds || {};
  if (prev.x === clean.x && prev.y === clean.y && prev.width === clean.width && prev.height === clean.height) return clean;
  patchGlobal({ lastActiveWindowBounds: clean });
  return clean;
}

// ---- 单窗口 ----
function readWindow(key) {
  ensureInit();
  const raw = readJson(windowFile(key), {});
  return deepMerge(defaultWindowState(), sanitizeWindowPatch(raw));
}

function patchWindow(key, patch) {
  ensureInit();
  const next = deepMerge(readWindow(key), sanitizeWindowPatch(patch));
  writeJsonAtomic(windowFile(key), next);
  return next;
}

function listWindowKeys() {
  ensureInit();
  return (readGlobal().openedWindowKeys || []).slice();
}

function registerWindow(key) {
  const g = readGlobal();
  const keys = new Set(g.openedWindowKeys || []);
  keys.add(String(key));
  patchGlobal({ openedWindowKeys: [...keys] });
  if (!fs.existsSync(windowFile(key))) writeJsonAtomic(windowFile(key), defaultWindowState());
  return readWindow(key);
}

function removeWindow(key) {
  const g = readGlobal();
  patchGlobal({ openedWindowKeys: (g.openedWindowKeys || []).filter((k) => k !== String(key)) });
  const f = windowFile(key);
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}

module.exports = {
  UI_STATE_DIR,
  GLOBAL_FILE,
  DEFAULT_GLOBAL,
  DEFAULT_BOUNDS,
  PANEL_LIMITS,
  defaultWindowState,
  windowFile,
  ensureInit,
  readGlobal,
  writeGlobal,
  patchGlobal,
  saveWindowBounds,
  readWindow,
  patchWindow,
  listWindowKeys,
  registerWindow,
  removeWindow,
};
