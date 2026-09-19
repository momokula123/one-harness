'use strict';
// 检查点：内容寻址快照 + 日志 + 按消息回滚
// 布局：<工程文件夹>/.one-harness/checkpoints/blobs/<sha256>   与   checkpoints/log.jsonl
// （跟着工程文件夹走，和会话记录同一个落脚点）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

function cpDir(projectId) {
  return store.ensureDir(path.join(store.projectDataDir(projectId), 'checkpoints'));
}

function blobsDir(projectId) {
  return store.ensureDir(path.join(cpDir(projectId), 'blobs'));
}

function logFile(projectId) {
  return path.join(cpDir(projectId), 'log.jsonl');
}

function readLog(projectId) {
  // **纯读，不许建目录**：logFile() 会 ensureDir，而"列改动记录"在启动时就会被调一次
  // （renderer 的 refreshFiles），工程目录不可写（比如绿色版被拷到别的电脑、老记录里
  // 还写着上一台机器的绝对路径）时，mkdir 抛 EPERM 会顺着 IPC 冒到 init()，
  // 整个界面变成一页"启动失败"。读不到就当空列表。
  // ⚠️ 路径必须和 logFile() **逐段一致**（`<工程记录目录>/checkpoints/log.jsonl`）——
  // 这里少写一层 `checkpoints` 的话读到的就是"永远不存在的文件"，表现是
  // 改动记录恒为空、回滚永远"恢复 0 个"（features 的 D8/D10/E3~E5 就是拿这个当断言）。
  const file = path.join(store.projectDataDir(projectId), 'checkpoints', 'log.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function appendLog(projectId, rec) {
  fs.appendFileSync(logFile(projectId), JSON.stringify(rec) + '\n', 'utf8');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 在修改文件之前调用。文件不存在时记一条 absent 记录（回滚意味着删掉它）。
 * 返回 {kind, path, sha, beforeSize, beforeText}
 */
function snapshot(projectId, sessionId, absPath) {
  const exists = fs.existsSync(absPath);
  if (!exists) {
    const rec = { ts: Date.now(), projectId, sessionId, path: absPath, kind: 'absent', sha: null, size: 0 };
    appendLog(projectId, rec);
    return { ...rec, beforeText: null };
  }
  const buf = fs.readFileSync(absPath);
  const sha = sha256(buf);
  const blob = path.join(blobsDir(projectId), sha);
  if (!fs.existsSync(blob)) fs.writeFileSync(blob, buf);
  const isText = !buf.includes(0);
  const rec = { ts: Date.now(), projectId, sessionId, path: absPath, kind: 'modified', sha, size: buf.length };
  appendLog(projectId, rec);
  return { ...rec, beforeText: isText ? buf.toString('utf8') : null };
}

function afterState(absPath) {
  if (!fs.existsSync(absPath)) return { exists: false, sha: null, size: 0, text: null };
  const buf = fs.readFileSync(absPath);
  return { exists: true, sha: sha256(buf), size: buf.length, text: buf.includes(0) ? null : buf.toString('utf8') };
}

function listForPath(projectId, absPath) {
  if (typeof absPath !== 'string' || !absPath) return [];
  return readLog(projectId).filter((r) => r && r.path === absPath).sort((a, b) => a.ts - b.ts);
}

function listRecent(projectId, limit = 60) {
  return readLog(projectId).filter((r) => r && typeof r.path === 'string' && r.path).slice(-limit).reverse();
}

function allPaths(projectId) {
  return [...new Set(readLog(projectId).map((r) => r && r.path).filter((p) => typeof p === 'string' && p))];
}

/** 回滚到某条消息（entry）之前：撤销该时间点之后的所有文件改动 */
function rollbackTo(projectId, sessionId, targetTs) {
  const log = readLog(projectId).filter(
    (r) => r && typeof r.path === 'string' && r.path && (r.kind === 'absent' || r.kind === 'modified')
  );
  const paths = [...new Set(log.map((r) => r.path))];
  const result = { restored: [], deleted: [], skipped: [], ts: targetTs };
  for (const p of paths) {
    const recs = log.filter((r) => r.path === p).sort((a, b) => a.ts - b.ts);
    const after = recs.filter((r) => r.ts > targetTs);
    if (!after.length) continue;
    const before = recs.filter((r) => r.ts <= targetTs).pop();
    const baseline = before || recs[0];
    if (!before && baseline.kind === 'modified') {
      // 目标点之前没有基线，用首次改动前的快照近似
      const blob = typeof baseline.sha === 'string' && baseline.sha ? path.join(blobsDir(projectId), baseline.sha) : null;
      if (blob && fs.existsSync(blob)) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.copyFileSync(blob, p);
        result.restored.push(p);
        appendLog(projectId, { ts: Date.now(), projectId, sessionId, path: p, kind: 'restored', sha: baseline.sha, size: baseline.size, rollbackTo: targetTs, approximate: true });
      } else {
        result.skipped.push(p);
      }
      continue;
    }
    if (baseline.kind === 'absent') {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        result.deleted.push(p);
        appendLog(projectId, { ts: Date.now(), projectId, sessionId, path: p, kind: 'restored', sha: null, size: 0, rollbackTo: targetTs });
      }
      continue;
    }
    const blob = typeof baseline.sha === 'string' && baseline.sha ? path.join(blobsDir(projectId), baseline.sha) : null;
    if (!blob || !fs.existsSync(blob)) {
      result.skipped.push(p);
      continue;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(blob, p);
    result.restored.push(p);
    appendLog(projectId, { ts: Date.now(), projectId, sessionId, path: p, kind: 'restored', sha: baseline.sha, size: baseline.size, rollbackTo: targetTs });
  }
  return result;
}

/**
 * 只取 snapshot() 写下的记录 —— 它们才是**改动前的状态**：
 *   kind:'absent'（改动前不存在 → 恢复=删掉它）、kind:'modified'（改动前是这份内容）
 * `restored` 是"恢复动作"自己的记录（sha 可能为 null，因为本来就是删除），
 * 它既不是新的改动、也没有 blob 可指 —— 拿它去 path.join 会直接抛
 * ERR_INVALID_ARG_TYPE: The "path" argument must be of type string.
 */
function snapshotRecs(projectId, absPath) {
  if (typeof absPath !== 'string' || !absPath) return [];
  return readLog(projectId)
    .filter((r) => r && r.path === absPath && (r.kind === 'absent' || r.kind === 'modified'))
    .sort((a, b) => a.ts - b.ts);
}

/** 单文件恢复到最近一次改动之前（幂等：已经恢复过再点一次也是同一个结果） */
function revertFile(projectId, sessionId, absPath) {
  if (typeof absPath !== 'string' || !absPath) return { ok: false, message: '文件路径无效。' };
  const recs = snapshotRecs(projectId, absPath);
  if (!recs.length) return { ok: false, message: '这个文件没有检查点记录。' };
  const last = recs[recs.length - 1];
  if (last.kind === 'absent') {
    try {
      if (fs.existsSync(absPath)) fs.rmSync(absPath, { force: true });
    } catch (e) {
      return { ok: false, message: '删除失败：' + e.message };
    }
    appendLog(projectId, { ts: Date.now(), projectId, sessionId, path: absPath, kind: 'restored', sha: null, size: 0 });
    return { ok: true, message: '已删除（该文件是 agent 新建的）' };
  }
  if (typeof last.sha !== 'string' || !last.sha) return { ok: false, message: '这条记录没有快照，无法恢复。' };
  const blob = path.join(blobsDir(projectId), last.sha);
  if (!fs.existsSync(blob)) return { ok: false, message: '快照内容已丢失。' };
  try {
    // 目录可能在两次改动之间被删掉过；不建目录的话 copyFileSync 会 ENOENT，
    // 又变成用户看到的 "操作失败：Error invoking remote method …"（这次吞成可读消息）
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.copyFileSync(blob, absPath);
  } catch (e) {
    return { ok: false, message: '恢复失败：' + e.message };
  }
  appendLog(projectId, { ts: Date.now(), projectId, sessionId, path: absPath, kind: 'restored', sha: last.sha, size: last.size });
  return { ok: true, message: '已恢复到最后一次改动之前' };
}

/**
 * 按文件聚合的改动列表（右栏「改动记录」面板用）。
 * 一个文件一行（取它最近一次改动前的快照 + 累计改动次数），
 * **不把 `restored` 当列表项**——它不是改动，给它配「恢复」按钮也点不出东西来。
 */
function listFiles(projectId, limit = 200) {
  const byPath = new Map();
  for (const r of readLog(projectId)) {
    if (!r || typeof r.path !== 'string' || !r.path) continue;
    if (r.kind !== 'absent' && r.kind !== 'modified') continue;
    const cur = byPath.get(r.path);
    if (!cur) {
      byPath.set(r.path, { path: r.path, ts: r.ts, kind: r.kind, sha: r.sha, size: r.size, changes: 1 });
    } else {
      cur.changes++;
      if (r.ts >= cur.ts) { cur.ts = r.ts; cur.kind = r.kind; cur.sha = r.sha; cur.size = r.size; }
    }
  }
  return [...byPath.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

module.exports = { snapshot, afterState, readLog, listRecent, listFiles, listForPath, allPaths, rollbackTo, revertFile, blobsDir };
