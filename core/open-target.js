'use strict';
// 「界面里那串要打开的东西」→「能直接交给系统的形态」。
//
// 为什么必须只此一处判定（2026-09-18 用户报「右栏浏览器那个『在系统浏览器打开』按了没反应」）：
//   shell.openPath 只吃**文件系统路径**。Electron 在 Windows 上的实现
//   （shell/common/platform_util_win.cc）是：
//       DirectoryExists(path) ? OpenFolderViaShell(path) : OpenFileViaShell(path)
//       → 失败时返回字符串 "Failed to open path"
//   名字叫 `https://…` 或 `file:///C:/…` 的“文件”当然不存在，于是必然失败；
//   而 openPath 返回的是 **resolve 出来的错误字符串**（不是 reject），旧代码没接返回值 ——
//   静默失败，界面上就是「按了没反应」。
//   URL 必须走 shell.openExternal（内部 ShellExecuteEx + lpVerb="open"，由系统按协议挑默认程序）。
//
// 判定顺序有讲究：Windows 盘符跟 URL scheme 长得一模一样（`C:`），必须先认盘符，
// 否则 `C:\Users\x` 会被当成 scheme="C:" 的 URL 扔给 ShellExecuteEx。

const path = require('path');
const { pathToFileURL } = require('url');

const WIN_DRIVE = /^[a-zA-Z]:[\\/]/;              // C:\…  C:/…  —— 盘符绝对路径
const DRIVE_ONLY = /^[a-zA-Z]:(?![\\/])/;         // C:foo  —— 盘符相对路径（不是 scheme）
const UNC = /^\\\\[^\\]/;                          // \\server\share
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;      // http: https: file: mailto: tel: …

/**
 * 判定一个待打开目标。
 * @param {string} raw   界面里那串原文（地址栏内容 / 链接）
 * @param {{base?: string}} [opts]  相对路径的基准目录，默认当前工作目录
 * @returns {{kind:'url'|'path'|'empty', target:string, abs:string, scheme:string}}
 *   · kind='url'   → 交给 shell.openExternal（http/https/mailto…；file: 除外 ——
 *                    openExternal 对 file:// 是执行原语，main.js 里已拦，见 2026-09-20 审计）
 *   · kind='path'  → 本地路径，target 已转成 file:// URL，abs 是原始绝对路径
 *                    （openExternal 不收 file:// 时才退 openPath，见 main.js）
 *   · kind='empty' → 调用方必须给用户一句提示，别静默什么都不做
 */
function resolve(raw, opts) {
  const o = opts || {};
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { kind: 'empty', target: '', abs: '', scheme: '' };

  if (WIN_DRIVE.test(s) || UNC.test(s)) {
    const abs = path.win32.normalize(s);
    return { kind: 'path', target: pathToFileURL(abs).href, abs, scheme: '' };
  }
  if (SCHEME.test(s) && !DRIVE_ONLY.test(s)) {
    const m = SCHEME.exec(s);
    return { kind: 'url', target: s, abs: '', scheme: m[0].slice(0, -1).toLowerCase() };
  }

  // 其余一律当本地路径：`C:foo` / `sub/a.html` / `/etc/hosts` 都按 base 拼成绝对路径
  const base = o.base ? path.resolve(String(o.base)) : process.cwd();
  const abs = path.resolve(base, s.replace(/^[\\/]+/, ''));
  return { kind: 'path', target: pathToFileURL(abs).href, abs, scheme: '' };
}

/** 只想知道「这串东西是不是一个协议 URL」时的便捷判据 */
function isUrlLike(raw) {
  return resolve(raw).kind === 'url';
}

module.exports = { resolve, isUrlLike };
