'use strict';
// 图片输入的最小支撑层：认类型、读盘转 data URL、量尺寸、估 token。
//
// 为什么单独一个模块：main.js（拖入时按类型分流）、core/session.js（发请求那一刻把
// 相对路径变成 data URL）、core/compact.js（估算上下文占用）三处都要用同一套判定 ——
// 判定抄三遍，日后必然改一处忘一处（同 core/store.js 的 uniquePath）。

const fs = require('fs');
const path = require('path');

// 只收 OpenAI 兼容端点确实认的这几种。svg 不在其中（它本质是 XML，端点多半拒收），
// bmp/tiff 也不收 —— 收得越宽，用户"发出去才知道 400"的机会越多。
const MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// 单张上限。图片会以 base64（体积约 ×1.37）随**每一轮、每一步**的请求重发，
// 10MB 的图意味着每步请求都要搬十几 MB —— 拒绝比默默拖垮好，而且要把原因说清楚。
const MAX_BYTES = 10 * 1024 * 1024;
// 长边超过这个值时服务端通常也会自己缩，传大的只白花字节和 token（业界事实标准 1568px）。
const RECOMMEND_MAX_SIDE = 1568;

// 缓存：同一张图在一次会话里会被反复渲染（每步都重新组 messages），
// 不缓存就是每步把同一个文件读盘 + base64 一遍再拼成一个几 MB 的字符串。
// 键里带上 size+mtime，文件被改过自然失效。
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const cache = new Map(); // absPath -> { key, value, bytes }
let cacheBytes = 0;

function mimeFor(nameOrRel) {
  return MIMES[path.extname(String(nameOrRel || '')).toLowerCase()] || null;
}

function isImage(nameOrRel) {
  return !!mimeFor(nameOrRel);
}

/** 从文件头读宽高。读不出来返回 null（不影响发送，只影响 token 估算的精度）。 */
function dimensionsOf(buf) {
  if (!buf || buf.length < 16) return null;
  // PNG：8 字节签名 + 4 字节长度 + 'IHDR' + 宽高（大端）
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF：'GIF87a' / 'GIF89a' + 宽高（小端 uint16，偏移 6/8）
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // BMP：'BM' + 宽高（小端 int32，偏移 18/22；高度为负表示自上而下）
  if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  // WebP：'RIFF' + 4 字节长度 + 'WEBP'，再按块类型分三种（VP8X / VP8 / VP8L，各自宽高位置不同）
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    if (kind === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG：扫段找 SOFn（宽高就在那一段里；0xC4/0xC8/0xCC 是别的表，不算 SOF）
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/**
 * 一张图的 token 估算。
 * 用的是 OpenAI 的分块公式（把图切成 512px 的块、每块 170 token，外加 85 基础值），
 * 语义上**偏保守**：实测本机端点（deepseek-v4.1-flash）一张 1280×648 约 530 token，
 * 而这个公式算 1105。宁可高估 —— 高估只会让自动压缩早一点触发，低估会让上下文撑爆。
 */
function estimateTokens(width, height) {
  if (!width || !height) return 1100; // 尺寸读不出来时给个保守常数
  return Math.ceil(width / 512) * Math.ceil(height / 512) * 170 + 85;
}

/**
 * 读一张图，产出上线要用的全部信息。
 * 返回 { ok:true, dataUrl, mime, bytes, width, height, tokens, oversize }
 *   或 { ok:false, error }（error 是给用户看的中文）
 * opts.maxBytes：给**界面缩略图**单独放宽的上限（4K 生图能到 11MB 以上；喂给模型那条仍走 MAX_BYTES）。
 *   上限进缓存键 —— 否则界面先缓存了 12MB 的图，模型那条读同一张会命中缓存、绕开大小限制。
 */
function inspect(absPath, opts) {
  const cap = (opts && Number(opts.maxBytes)) || MAX_BYTES;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { ok: false, error: '不是文件' };
    const mime = mimeFor(absPath);
    if (!mime) return { ok: false, error: '不是支持的图片格式' };
    if (st.size > cap) {
      return { ok: false, error: `这张图 ${(st.size / 1048576).toFixed(1)}MB，超过 ${cap / 1048576}MB 上限，先压缩一下` };
    }
    const key = mime + ':' + st.size + ':' + st.mtimeMs + ':' + cap;
    const hit = cache.get(absPath);
    if (hit && hit.key === key) return hit.value;

    const buf = fs.readFileSync(absPath);
    const dim = dimensionsOf(buf);
    const value = {
      ok: true,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      mime,
      bytes: st.size,
      width: dim ? dim.width : null,
      height: dim ? dim.height : null,
      tokens: estimateTokens(dim && dim.width, dim && dim.height),
      oversize: !!(dim && Math.max(dim.width, dim.height) > RECOMMEND_MAX_SIDE),
    };
    if (hit) { cacheBytes -= hit.bytes; cache.delete(absPath); }
    cache.set(absPath, { key, value, bytes: value.dataUrl.length });
    cacheBytes += value.dataUrl.length;
    // 按字节预算淘汰最旧的，而不是按条数 —— 两条 8MB 的图比二十条 20KB 的图占得多。
    while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    return value;
  } catch (e) {
    const msg = e.code === 'ENOENT' ? '文件不在了（可能已被移动或删除）'
      : e.code === 'EPERM' || e.code === 'EACCES' ? '读不了这个文件（没权限或被占用）'
      : (e.message || String(e));
    return { ok: false, error: msg };
  }
}

/** 从 data URL 反推 token。只解前 4KB 就够读出头里的宽高，不必解整张图。 */
function tokensForDataUrl(url) {
  const s = String(url || '');
  const comma = s.indexOf(',');
  if (comma < 0) return 1100;
  const raw = s.slice(comma + 1, comma + 1 + 4096);
  const b64 = raw.slice(0, raw.length - (raw.length % 4));
  let dim = null;
  try { dim = dimensionsOf(Buffer.from(b64, 'base64')); } catch (_) { dim = null; }
  return estimateTokens(dim && dim.width, dim && dim.height);
}

/** 这组模型消息里有没有图片 part（降级判断用）。 */
function hasImageParts(messages) {
  for (const m of messages || []) {
    if (Array.isArray(m && m.content) && m.content.some((p) => p && p.type === 'image_url')) return true;
  }
  return false;
}

/**
 * 这个报错是不是"端点不吃图"。
 * 只能靠特征判断 —— 各家错误体不一样，实测本机端点回的是 invalid_image_data。
 * 判据故意收紧（必须同时出现"图片"与"拒绝/无效"两边的词），
 * 因为误判的代价是"把一张本来能用的图剥掉"，比漏判更难发现。
 */
function looksLikeImageRejection(err) {
  const s = String((err && err.message) || err || '');
  const mentionsImage = /image|图片|多模态|multimodal|vision/i.test(s);
  const looksRejected = /invalid|unsupported|not support|不支持|无法|reject|400|415|422/i.test(s);
  return mentionsImage && looksRejected;
}

module.exports = {
  MIMES, MAX_BYTES, RECOMMEND_MAX_SIDE,
  mimeFor, isImage, dimensionsOf, estimateTokens,
  inspect, tokensForDataUrl, hasImageParts, looksLikeImageRejection,
};
