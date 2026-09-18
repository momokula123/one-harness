'use strict';
// 运行日志：把"一轮对话里到底发生了什么"记到磁盘上，供事后排查。
//
// 为什么需要它：出问题（比如"请求停不下来"）时，磁盘上没有任何记录 ——
// 应用只在启动/窗口/删项目这几处置了 console.log，而 launch.js 的日志文件每次启动重写、
// 且聊天链路一行不打。于是排查只能靠事后从会话 JSON 里反推事件流，非常费劲。
//
// 设计取向：
//   · **追加**，绝不重写（launch.log 每次启动清空那条路不能用在排查日志上）；
//   · **按天分文件** logs/run-YYYY-MM-DD.log，方便只看某一天；
//   · **行分隔 JSON（JSONL）**：一行一条，机器可读，不会因为一条日志里有换行而错位；
//   · **同步写**：进程崩溃/被 kill 时，缓冲里的内容最容易丢，宁可慢一点也要落盘；
//   · **永不抛错**：日志写失败绝不能影响主流程（磁盘满、权限异常都只静默降级）；
//   · **脱敏**：apiKey 之类的字段按 key 名识别并打码，避免把密钥写进日志文件。
//
// 谁在用：main.js 启动时 init() 一次；agent.js / model.js / main.js 各处 log() 记录事件。
// 环境变量 HATCH_RUN_LOG=0 可整体关掉（测试环境不需要时）。

const fs = require('fs');
const path = require('path');

let LOG_DIR = null;
let enabled = false;
let currentDay = '';

// 这些 key 名一律打码（不看值，只看名字），避免密钥落盘
const SECRET_KEY = /^(apikey|api_key|authorization|password|passwd|secret|token|access_token|refresh_token)$/i;

function maskDeep(v, depth = 0) {
  if (depth > 6 || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => maskDeep(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (SECRET_KEY.test(k)) out[k] = (v[k] ? '***' + String(v[k]).slice(-4) : '');
      else out[k] = maskDeep(v[k], depth + 1);
    }
    return out;
  }
  // 长字符串截断（日志不该被一整个文件内容撑爆）
  if (typeof v === 'string' && v.length > 4000) return v.slice(0, 4000) + `…(+${v.length - 4000} 字)`;
  return v;
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 应用版本。出处只有一个：package.json（打包后 = resources/app/package.json）。
 * 记进 app.start 是为了回答"用户手里那个包到底是哪一版" —— 光有文件名不够，
 * 因为包会被改名、会被拷来拷去；日志里的版本是程序自报的。查不到就 unknown，绝不抛错。
 */
function appVersion() {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/**
 * 初始化。dataDir 传 store.DATA_DIR 或 store.ROOT 都行 —— 日志跟数据放一起，
 * 绿色版里就落在 exe 旁边的 logs/ 下，跟文件夹一起搬走。
 */
function init(roots) {
  try {
    if (process.env.HATCH_RUN_LOG === '0') { enabled = false; return false; }
    // 默认落在 <数据根目录>/../logs —— 即 repo 根或绿色版 exe 旁边的 logs/，
    // 与 launch.js 的日志同目录，跟文件夹一起搬走。可用 roots.logDir 覆盖。
    const base = (roots && roots.logDir) ? roots.logDir : path.join((roots && roots.dataDir) || '.', '..', 'logs');
    LOG_DIR = path.resolve(base);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    enabled = true;
    write('app.start', {
      pid: process.pid,
      version: appVersion(),
      runtime: 'node ' + process.versions.node + (process.versions.electron ? ' / electron ' + process.versions.electron : ''),
      packaged: !!(roots && roots.packaged),
      logDir: LOG_DIR,
    });
    return true;
  } catch (_) {
    enabled = false;
    return false;
  }
}

/**
 * 同步追加一行。**刻意不用 createWriteStream**：
 * 它的写是异步缓冲的，而这份日志要对付的正是"请求停不下来 → 用户强杀进程"的场景，
 * 缓冲里没落盘的那几行（往往就是出事前最后几个事件）会直接消失。
 * 每轮对话只写十几行，同步 appendFileSync 的开销可以忽略，换来的是"写进去就一定在盘上"。
 */
function write(kind, data) {
  if (!enabled || !LOG_DIR) return;
  try {
    let line;
    try {
      line = JSON.stringify({ t: new Date().toISOString(), kind, ...maskDeep(data || {}) });
    } catch (_) {
      // 有循环引用之类，退化成字符串描述（不因此丢日志）
      line = JSON.stringify({ t: new Date().toISOString(), kind, note: '日志序列化失败（值不可 JSON 化）' });
    }
    const day = dayKey();
    currentDay = day;
    fs.appendFileSync(path.join(LOG_DIR, `run-${day}.log`), line + '\n');
  } catch (_) { /* 日志永远不能影响主流程 */ }
}

/** 通用记录 */
function log(kind, data) { write(kind, data); }

/** 记录模型请求的开销（token / 耗时 / 是否出错） */
function modelCall(info) { write('model.call', info); }

/** 记录工具调用（名称 / 参数 / 耗时 / 是否出错 / 结果字数） */
function toolCall(info) { write('tool.call', info); }

/** 记录轮次边界 */
function turn(info) { write('turn', info); }

/** 当前日志文件路径（给界面/排查时显示用） */
function logFile() {
  const d = currentDay || dayKey();
  return LOG_DIR ? path.join(LOG_DIR, `run-${d}.log`) : null;
}

function isEnabled() { return enabled; }

module.exports = { init, log, modelCall, toolCall, turn, logFile, isEnabled, maskDeep, dayKey };
