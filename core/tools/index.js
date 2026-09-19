'use strict';
// 工具注册表：别名（暴露给模型）→ 内部实现的解析层，等价于 Bionic 的 name → ngModule:module:tool

const fsTools = require('./fs');
const shellTools = require('./shell');
const webTools = require('./web');
const skillTools = require('./skills');
const officeTools = require('./office');
const imageTools = require('./image');
// 图片后缀/类型只有一套判定（core/images.js），工具报回来的图也走它
const images = require('../images');

const ALL = [...fsTools.tools, ...shellTools.tools, ...webTools.tools, ...skillTools.tools, ...officeTools.tools, ...imageTools.tools];

const byAlias = new Map();
const byModule = new Map();
for (const t of ALL) {
  if (byAlias.has(t.alias)) throw new Error('工具别名重复：' + t.alias);
  byAlias.set(t.alias, t);
  if (!byModule.has(t.module)) byModule.set(t.module, []);
  byModule.get(t.module).push(t);
}

function resolveTool(name) {
  return byAlias.get(String(name || '').trim()) || null;
}

function describeTool(tool) {
  return `${tool.alias} (${tool.module}) — ${tool.description}`;
}

function schemasFor(aliases) {
  const wanted = aliases ? new Set(aliases) : null;
  return ALL.filter((t) => !wanted || wanted.has(t.alias)).map((t) => ({
    type: 'function',
    function: { name: t.alias, description: t.description, parameters: t.parameters },
  }));
}

function catalog() {
  return ALL.map((t) => ({ alias: t.alias, module: t.module, risk: t.risk, description: t.description }));
}

/**
 * 执行一次工具调用。argsText 是模型给的 JSON 字符串。
 * 返回值固定是 `{ text, isError }`，外加**可选**的 `images: [{ rel, mime }]` ——
 * 少数工具（生图）会产出图片，那是给用户看的：模型侧仍然只有 text 这一条通道，
 * 图靠 rel 走渲染层（和用户拖进来的附件同一条路：files:preview 取像素）。
 */
async function execute(name, argsText, ctx) {
  const tool = resolveTool(name);
  if (!tool) {
    return { text: `未知工具 "${name}"。可用工具：${[...byAlias.keys()].join(', ')}`, isError: true };
  }
  let args = {};
  const raw = String(argsText || '').trim();
  if (raw) {
    try {
      args = JSON.parse(raw);
    } catch (e) {
      return { text: `参数不是合法 JSON（${e.message}）。收到的原文：${raw.slice(0, 400)}`, isError: true };
    }
  }
  try {
    const r = await tool.run(args, ctx);
    if (typeof r === 'string') return { text: r, isError: false };
    if (r && typeof r === 'object') {
      const out = { text: String(r.text ?? ''), isError: !!r.isError };
      const imgs = normalizeImages(r.images);
      if (imgs) out.images = imgs;
      return out;
    }
    return { text: String(r ?? ''), isError: false };
  } catch (e) {
    return { text: `工具执行出错：${e && e.message ? e.message : String(e)}`, isError: true };
  }
}

/** 工具报的图片一律收窄成 `{rel, mime}`：只留工作目录内的相对路径，别的形态不收。 */
function normalizeImages(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list) {
    const rel = typeof it === 'string' ? it : it && it.rel;
    if (!rel) continue;
    out.push({ rel: String(rel), mime: (it && it.mime) || images.mimeFor(rel) || null });
  }
  return out.length ? out : null;
}

module.exports = { ALL, byAlias, byModule, resolveTool, schemasFor, catalog, execute, classifyCommand: shellTools.classifyCommand };
