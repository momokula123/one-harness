'use strict';
/*
 * 探针：兜底 LLM（agnes-3.0-flash）到底认哪个"思考强度"参数、什么取值。
 * 为什么要真打一次：OpenAI 规范里**根本没有**这个字段（各家自己加的），
 * 文档里查不到就只剩"发出去看它认不认"这一条路。猜错的代价是整轮 400。
 * 矩阵：不发 / reasoning_effort 各档 / thinking.type / enable_thinking / chat_template_kwargs，
 * 只看两件事：HTTP 是不是 200、返回里有没有 reasoning_content。
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'model.json'), 'utf8'));
const BASE = String(cfg.baseUrl || '').replace(/\/+$/, '');
const KEY = cfg.apiKey;
const MODEL = cfg.model;

const CASES = [
  ['基线（什么参数都不发）', {}],
  ["reasoning_effort: 'none'", { reasoning_effort: 'none' }],
  ["reasoning_effort: 'minimal'", { reasoning_effort: 'minimal' }],
  ["reasoning_effort: 'low'", { reasoning_effort: 'low' }],
  ["reasoning_effort: 'medium'", { reasoning_effort: 'medium' }],
  ["reasoning_effort: 'high'", { reasoning_effort: 'high' }],
  ["thinking: {type:'disabled'}", { thinking: { type: 'disabled' } }],
  ['enable_thinking: false', { enable_thinking: false }],
  ["chat_template_kwargs: {thinking:false}", { chat_template_kwargs: { thinking: false } }],
];

const PROMPT = '一个笼子里有鸡和兔共 8 只，脚共 22 只。鸡兔各几只？只回答案。';

async function main() {
  console.log('端点 ' + BASE + '   模型 ' + MODEL);
  try {
    const r = await fetch(BASE + '/models', { headers: KEY ? { Authorization: 'Bearer ' + KEY } : {} });
    const j = await r.json();
    const ids = (j.data || j.models || []).map((m) => m.id || m.name);
    console.log('模型列表（' + r.status + '，' + ids.length + ' 个）：' + ids.join(', '));
    console.log('  ↳ 兜底模型名在列表里吗：' + (ids.includes(MODEL) ? '在' : '★ 不在（程序会自动改用列表第一个）'));
  } catch (e) {
    console.log('模型列表读不到：' + ((e && e.message) || e));
  }
  console.log('');

  for (const [label, extra] of CASES) {
    const body = { model: MODEL, messages: [{ role: 'user', content: PROMPT }], stream: false, ...extra };
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(KEY ? { Authorization: 'Bearer ' + KEY } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const text = await res.text();
      const ms = Date.now() - t0;
      let j = null;
      try { j = JSON.parse(text); } catch (_) { /* 非 json */ }
      const msg = j && j.choices && j.choices[0] && (j.choices[0].message || j.choices[0].delta);
      const rc = msg ? String(msg.reasoning_content || msg.reasoning || '') : '';
      const content = msg ? String(msg.content || '') : '';
      console.log(`${res.status} ${String(label).padEnd(34)} ${String(ms).padStart(6)}ms  reasoning=${rc.length}字  content=${content.length}字`);
      if (!res.ok) console.log('      ↳ ' + text.slice(0, 300));
      else if (!msg) console.log('      ↳ 没解析出 message，原始：' + text.slice(0, 200));
    } catch (e) {
      console.log(`✗  ${String(label).padEnd(34)} 异常：${(e && e.message) || e}`);
    }
  }
}

main().then(() => process.exit(0));
