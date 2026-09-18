'use strict';
// 上下文隔离下的安全桥：渲染层只能看到下面这些方法
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('hatch', {
  boot: () => invoke('app:boot'),
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
  },
  models: { list: (override) => invoke('models:list', override) },
  projects: {
    list: () => invoke('projects:list'),
    create: (input) => invoke('projects:create', input),
    update: (input) => invoke('projects:update', input),
    pickFolder: () => invoke('projects:pickFolder'),
    // 删除是"只摘索引"：从项目列表里移除，磁盘记录与工作目录都不动
    remove: (input) => invoke('projects:delete', input),
    deleteInfo: (input) => invoke('projects:deleteInfo', input),
    // 索引的备份与恢复：同样只动 projects.json，导入只增不减
    exportIndex: () => invoke('projects:exportIndex'),
    importIndex: () => invoke('projects:importIndex'),
  },
  sessions: {
    list: (projectId) => invoke('sessions:list', projectId),
    create: (input) => invoke('sessions:create', input),
    load: (input) => invoke('sessions:load', input),
    rename: (input) => invoke('sessions:rename', input),
    update: (input) => invoke('sessions:update', input),
    remove: (input) => invoke('sessions:delete', input),
    fork: (input) => invoke('sessions:fork', input),
  },
  chat: {
    send: (input) => invoke('chat:send', input),
    stop: (input) => invoke('chat:stop', input),
  },
  approvals: {
    answer: (input) => invoke('approval:answer', input),
  },
  checkpoints: {
    list: (projectId) => invoke('checkpoints:list', projectId),
    rollback: (input) => invoke('checkpoints:rollback', input),
    revertFile: (input) => invoke('checkpoints:revertFile', input),
  },
  skills: {
    list: () => invoke('skills:list'),
    read: (name) => invoke('skills:read', name),
    save: (input) => invoke('skills:save', input),
    openDir: () => invoke('skills:openDir'),
  },
  fs: {
    readText: (input) => invoke('fs:readText', input),
  },
  // 拖进来的文件。渲染层**拿不到**它的本地路径 —— Electron 32 起 File.path 已被移除
  // （webUtils.getPathForFile 是唯一的替代品，而它只能在 preload 里用）。
  // 所以"拖入 → 复制进工作目录"这条路必须经过这里：渲染层问路径，主进程负责搬。
  files: {
    pathFor: (file) => {
      try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
    },
    attach: (input) => invoke('files:attach', input),
    // 取一张图的像素（气泡缩略图用）。rel 是工作目录内的相对路径，
    // 主进程会再校验一次"必须在工作目录内"，渲染层拿不到任意路径的读盘能力。
    preview: (input) => invoke('files:preview', input),
  },
  // 无边框窗口的自绘按钮
  win: {
    minimize: () => invoke('win:minimize'),
    toggleMaximize: () => invoke('win:toggleMaximize'),
    close: () => invoke('win:close'),
    isMaximized: () => invoke('win:isMaximized'),
    onStateChange: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('win:state', handler);
      return () => ipcRenderer.removeListener('win:state', handler);
    },
  },
  // 布局状态（ui-state/*.json 的读写口）
  ui: {
    state: () => invoke('ui:state'),
    patch: (patch) => invoke('ui:patch', patch),
    patchGlobal: (patch) => invoke('ui:patchGlobal', patch),
    reset: () => invoke('ui:reset'),
  },
  shell: {
    openPath: (p) => invoke('shell:openPath', p),
    // 网址/协议一律走它（openPath 只吃文件系统路径，喂 URL 会静默失败）
    openExternal: (raw) => invoke('shell:openExternal', raw),
    showItem: (p) => invoke('shell:showItem', p),
    openDataDir: () => invoke('app:openDataDir'),
  },
  events: {
    onAgentEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('agent:event', handler);
      return () => ipcRenderer.removeListener('agent:event', handler);
    },
    onApprovalRequest: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('approval:request', handler);
      return () => ipcRenderer.removeListener('approval:request', handler);
    },
    // 内置浏览器里点 target=_blank 时，主进程把地址回推给渲染层（见 main.js 的 setWindowOpenHandler）
    onBrowserNavigate: (cb) => {
      const handler = (_e, url) => cb(url);
      ipcRenderer.on('browser:navigate', handler);
      return () => ipcRenderer.removeListener('browser:navigate', handler);
    },
  },
});
