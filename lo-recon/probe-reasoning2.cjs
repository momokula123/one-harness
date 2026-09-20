'use strict';
/*
 * 探针二：`reasoning_effort` 是**真被解析**还是被静默丢弃？
 * 判据只用一个：故意发一个非法值 'garbage'。
 *   · 返回 400 / 带 "invalid" 字样 → 网关确实在解析这个字段（于是取值表可信）
 *   · 返回 200 且行为跟没发一样 → 字段被丢了，写进程序里也不会生效
 * 再顺带把基线 / none / high 各跑 3 遍：思考是会拉长耗时并吐出 reasoning_content 的，
 * 单次结果可能只是这一次模型自己不想思考，不能拿一次当结论。
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'model.json'), 'utf8'));
const BASE = String(cfg.baseUrl || '').replace(/\/+$/, '');
const KEY = cfg.apiKey;
const MODEL = cfg.model;
const PROMPT = '一个笼子里有鸡和兔共 8 只，脚共 22 只。鸡兔各几只？只回答案。';

async function once(label, extra) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: 'Bearer ' + KEY } : {}) },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], stream: false, ...extra }),
      signal: AbortSignal.timeout(180000),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) {}
    const msg = j && j.choices && j.choices[0] && (j.choices[0].message || {});
    const rc = msg ? String(msg.reasoning_content || msg.reasoning || '') : '';
    const s = `${res.status} ${String(label).padEnd(30)} ${String(Date.now() - t0).padStart(6)}ms  reasoning=${String(rc.length).padStart(4)}字`;
    console.log(s + (res.ok ? '' : '   ← ' + text.replace(/\s+/g, ' ').slice(0, 220)));
  } catch (e) {
    console.log(`✗  ${String(label).padEnd(30)} 异常：${(e && e.message) || e}`);
  }
}

async function main() {
  console.log('① 决定性一问：发个非法值，看它认不认');
  await once("reasoning_effort:'garbage'", { reasoning_effort: 'garbage' });
  await once("reasoning_effort:'NONE'（大写）", { reasoning_effort: 'NONE' });
  await once("reasoning_effort: 123（数字）", { reasoning_effort: 123 });
  console.log('');

  console.log('② 各档各跑 3 遍（看耗时与 reasoning 长度的稳定性）');
  for (let i = 1; i <= 3; i++) {
    await once(`#${i} 基线`, {});
    await once(`#${i} none`, { reasoning_effort: 'none' });
    await once(`#${i} high`, { reasoning_effort: 'high' });
    console.log('');
  }
}

main().then(() => process.exit(0));
