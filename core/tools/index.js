'use strict';
// 工具注册表：别名（暴露给模型）→ 内部实现的解析层，等价于 Bionic 的 name → ngModule:module:tool

const fsTools = require('./fs');
const shellTools = require('./shell');
const pythonTools = require('./python');
const webTools = require('./web');
const skillTools = require('./skills');
const officeTools = require('./office');

const ALL = [...fsTools.tools, ...shellTools.tools, ...pythonTools.tools, ...webTools.tools, ...skillTools.tools, ...officeTools.tools];

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

/** 执行一次工具调用。argsText 是模型给的 JSON 字符串。 */
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
    if (r && typeof r === 'object') return { text: String(r.text ?? ''), isError: !!r.isError };
    return { text: String(r ?? ''), isError: false };
  } catch (e) {
    return { text: `工具执行出错：${e && e.message ? e.message : String(e)}`, isError: true };
  }
}

module.exports = { ALL, byAlias, byModule, resolveTool, schemasFor, catalog, execute, classifyCommand: shellTools.classifyCommand, resolvePython: pythonTools.resolvePython };
