'use strict';
// web_search 契约探针（纯本机假端点，**不打公网、更不打真转发层** —— 猜错密钥会被按 IP 封禁）。
//
// 守三件事：
//   1. 服务二选一的判定只有一处（web.js 的 resolveSearch），界面与工具口径一致；
//   2. lanprint 转发层这条通道**必须走 IPv4** —— 它对 IPv6 一律 403，而 Node 20+ 的 fetch
//      默认开 Happy Eyeballs 会先试 AAAA，于是"参数全对却永远 403"（本机实测过）；
//   3. 出错**绝不自动重试**：转发层对猜错的密钥是逐级封禁（第 6 次封 1 分钟并指数累加）。
//
// 运行： node test/search-tool.js

const http = require('http');
const fs = require('fs');
const path = require('path');

// 第 8 段要过一遍真正的设置存取（saveSettings → getSettings），先把它引到临时目录
const TMP = path.join(__dirname, '.tmp-search');
process.env.HATCH_DATA_DIR = path.join(TMP, 'data');
process.env.HATCH_USER_DATA = path.join(TMP, 'userdata');

const web = require('../core/tools/web');
const store = require('../core/store');

const searchTool = web.tools.find((t) => t.alias === 'web_search');
const { resolveSearch, lanprintUrl, ipv4RequestOptions, lanprintError } = web;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra ? '  → ' + extra : ''));
  }
}

const DIGEST = [
  '[1] Title: Limits',
  '[1] URL Source: https://developers.cloudflare.com/workers/platform/limits/',
  '[1] Description: Workers platform limits...',
].join('\n');

/** 本机假转发层：记录每次请求，按 query 里的暗号回不同状态码。 */
function startStub() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const q = u.searchParams.get('q') || '';
    hits.push({ path: u.pathname, q, headers: req.headers, format: u.searchParams.get('format') });

    if (u.pathname === '/search') {                       // SearxNG 形态
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        results: [
          { title: 'Alpha', url: 'https://a.example/', content: 'aaa' },
          { title: 'Beta', url: 'https://b.example/', content: 'bbb' },
          { title: 'Gamma', url: 'https://c.example/', content: 'ccc' },
        ],
      }));
      return;
    }
    if (q.startsWith('http401')) { res.writeHead(401); res.end('invalid key'); return; }
    if (q.startsWith('http429')) { res.writeHead(429, { 'retry-after': '30' }); res.end('banned, retry later'); return; }
    if (q.startsWith('http503')) { res.writeHead(503); res.end('all upstream keys are cooling down'); return; }
    if (q.startsWith('http403')) { res.writeHead(403); res.end('IPv6 access is not allowed'); return; }
    if (q.startsWith('http400')) { res.writeHead(400); res.end('pass ?q=<query> for search or ?url=<url> for read'); return; }
    if (q.startsWith('big')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(5000)); return; }
    if (q.startsWith('slow')) {                            // 慢响应：验超时
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(DIGEST); }, 800);
      return;
    }
    if (q.startsWith('empty')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('   '); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(DIGEST);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** tools/index.js 的 execute() 会把字符串结果归一成 {text,isError}；这里照同一条口径收口。
 *  over = 设置里的 web 段；extraArgs = 工具参数（query 之外的那些，如 maxResults）。 */
async function run(query, over, extraArgs) {
  const out = await searchTool.run({ query, ...(extraArgs || {}) }, { settings: { web: { fetchTimeoutMs: 5000, maxChars: 20000, ...over } } });
  return typeof out === 'string' ? { text: out, isError: false } : out;
}

const lanprintSet = (base, over) => ({
  searchProvider: 'lanprint',
  lanprint: { endpoint: base, key: 'k-test' },
  ...over,
});

(async () => {
  const { server, hits, base } = await startStub();
  const lastHit = () => hits[hits.length - 1];

  try {
    console.log('\n[1] 服务判定（resolveSearch —— 工具与界面共用的唯一一处口径）');
    check('1a 什么都没配 → 没启用', resolveSearch({}).provider === '');
    check('1b 旧字段 searchEndpoint 有值、provider 为空 → 自动按 searxng 走（升级前的配置不被改坏）',
      resolveSearch({ searchEndpoint: 'http://127.0.0.1:8888' }).provider === 'searxng');
    check('1c provider=lanprint 且没填端点 → 用内置默认端点',
      resolveSearch({ searchProvider: 'lanprint' }).endpoint === 'https://jinaapi.lanprint.com');
    check('1d provider=lanprint 填了端点 → 用用户填的',
      resolveSearch({ searchProvider: 'lanprint', lanprint: { endpoint: 'https://x.example' } }).endpoint === 'https://x.example');
    check('1e provider=lanprint 的密钥被透出（且只从 lanprint 那组取）',
      resolveSearch({ searchProvider: 'lanprint', lanprint: { key: 'k1' }, searxng: { endpoint: base } }).key === 'k1');
    check('1f provider=searxng 时**不**带密钥',
      resolveSearch({ searchProvider: 'searxng', searxng: { endpoint: 'http://h' }, lanprint: { key: 'k1' } }).key === '');
    check('1g provider=searxng 端点优先取 searxng 那组，旧字段只当兜底',
      resolveSearch({ searchProvider: 'searxng', searxng: { endpoint: 'http://new' }, searchEndpoint: 'http://old' }).endpoint === 'http://new');
    // 反向对照：把 lanprint 的值塞进 searxng 组，判定结果必须不同 —— 证明这函数真在读对字段
    check('1h 反向对照：searxng 组里有值不代表 lanprint 会用',
      resolveSearch({ searchProvider: 'lanprint', searxng: { endpoint: 'http://searx-only' } }).endpoint !== 'http://searx-only');

    console.log('\n[2] IPv4 钉死（转发层对 IPv6 一律 403）');
    const opts = ipv4RequestOptions({ 'X-Api-Key': 'k' }, 1000);
    check('2a family === 4', opts.family === 4, String(opts.family));
    check('2b autoSelectFamily === false（关掉 Happy Eyeballs，别让它挑到 AAAA）', opts.autoSelectFamily === false);
    check('2c 请求头原样带上', opts.headers['X-Api-Key'] === 'k');
    check('2d 超时传进去', opts.timeout === 1000);

    console.log('\n[3] 未配置时的表现（要说清缺什么，且一个字节都不发出去）');
    let r = await run('hello', {});
    check('3a 没选服务 → isError', r.isError === true);
    check('3b 文案指向设置里的位置', /设置/.test(r.text) && /搜索服务/.test(r.text), r.text);
    check('3c 没发出任何请求', hits.length === 0, '请求数=' + hits.length);
    r = await run('   ', lanprintSet(base));
    check('3d 空查询词 → isError', r.isError === true && /查询词/.test(r.text));
    check('3e 空查询词也没发请求', hits.length === 0, '请求数=' + hits.length);
    r = await run('hello', { searchProvider: 'lanprint', lanprint: { endpoint: base, key: '' } });
    check('3f lanprint 缺密钥 → isError 且指出缺密钥', r.isError === true && /密钥/.test(r.text), r.text);
    check('3g 缺密钥时依然不发请求', hits.length === 0, '请求数=' + hits.length);
    r = await run('hello', { searchProvider: 'searxng', searxng: { endpoint: '' } });
    check('3h 选了 SearxNG 但没填地址 → isError 且指出地址', r.isError === true && /地址/.test(r.text));

    console.log('\n[4] lanprint 正常路径');
    hits.length = 0;
    r = await run('cloudflare workers limits', lanprintSet(base));
    check('4a 不是错误', r.isError === false, r.text);
    check('4b 正文原样透传（Markdown 摘要不加工）', r.text.includes('[1] Title: Limits') && r.text.includes('URL Source: https://developers.cloudflare.com/workers/platform/limits/'));
    check('4c 打的是根路径 / 而不是 /search', lastHit().path === '/', lastHit().path);
    check('4d query 参数名是 q 且已编码', lastHit().q === 'cloudflare workers limits');
    check('4e 密钥走 X-Api-Key 头（不进 URL）', lastHit().headers['x-api-key'] === 'k-test', String(lastHit().headers['x-api-key']));
    check('4f 只发了 1 次请求', hits.length === 1, '请求数=' + hits.length);

    hits.length = 0;
    r = await run('big', lanprintSet(base, { maxChars: 1000 }));
    check('4g 超长结果按 maxChars 截断', r.text.length < 1500, '长度=' + r.text.length);
    check('4h 截断时说明原文长度', /结果截断/.test(r.text) && /5000/.test(r.text), r.text.slice(-60));

    hits.length = 0;
    r = await run('empty', lanprintSet(base));
    check('4i 空正文 → 明确的"没搜到"，不算错误', r.isError === false && /没有搜到/.test(r.text), r.text);

    check('4j 端点没写协议 → 自动补 https（转发层只跑 https）', lanprintUrl('jinaapi.lanprint.com', 'x') === 'https://jinaapi.lanprint.com/?q=x', lanprintUrl('jinaapi.lanprint.com', 'x'));
    check('4k 端点末尾带斜杠 / 多个斜杠 → 归一成单个', lanprintUrl('https://jinaapi.lanprint.com///', 'x') === 'https://jinaapi.lanprint.com/?q=x', lanprintUrl('https://jinaapi.lanprint.com///', 'x'));
    check('4l 反向对照：查询词真的被编码了（不是裸拼）', lanprintUrl('https://h', '中 文').includes('q=%E4%B8%AD+%E6%96%87'), lanprintUrl('https://h', '中 文'));

    console.log('\n[5] 错误码翻译 + 绝不重试（每条都只允许打一次）');
    const cases = [
      ['http401', /密钥不对/, '401 报密钥不对'],
      ['http401', /别反复重试/, '401 提醒别重试（会被封）'],
      ['http429', /频繁/, '429 报太频繁'],
      ['http429', /30 秒/, '429 带上等待秒数'],
      ['http503', /暂时不可用/, '503 报服务暂时不可用'],
      ['http403', /拒绝了这次访问/, '403 报访问被拒'],
      ['http400', /没成功/, '400 报查询被拒'],
    ];
    for (const [q, re, name] of cases) {
      hits.length = 0;
      const out = await run(q, lanprintSet(base));
      check('5x ' + name, out.isError === true && re.test(out.text), out.text);
      check('5y ' + name + '：只打 1 次（不自动重试）', hits.length === 1, '请求数=' + hits.length);
    }
    const z418 = lanprintError(418, 'teapot', {});
    check('5z 未知状态码也不炸（有可读提示、不吐 undefined）', /搜索失败/.test(z418) && !/undefined/.test(z418), z418);

    console.log('\n[6] SearxNG 那条路没被改坏（回归）');
    hits.length = 0;
    r = await run('alpha', { searchProvider: 'searxng', searxng: { endpoint: base } });
    check('6a 打的是 /search', lastHit().path === '/search', lastHit().path);
    check('6b 带 format=json', lastHit().format === 'json');
    check('6c 解析出结果列表', r.isError === false && /1\. Alpha/.test(r.text) && /2\. Beta/.test(r.text), r.text);
    check('6d 反向对照：SearxNG 这条路**不**带转发层密钥', lastHit().headers['x-api-key'] === undefined, String(lastHit().headers['x-api-key']));
    hits.length = 0;
    r = await run('alpha', { searchProvider: 'searxng', searxng: { endpoint: base } }, { maxResults: 2 });
    check('6e maxResults 生效', r.text.includes('Beta') && !r.text.includes('Gamma'), r.text);
    hits.length = 0;
    r = await run('alpha', { searchEndpoint: base });
    check('6f 只有旧字段（没 provider）时照样能搜 —— 升级不掉功能', r.isError === false && /Alpha/.test(r.text), r.text);

    console.log('\n[7] 搜索超时单独一条（真转发层实测一次要 25 秒，跟抓页面共用 20 秒会每次误杀）');
    hits.length = 0;
    r = await run('slow', lanprintSet(base, { searchTimeoutMs: 300 }));
    check('7a 按 searchTimeoutMs 超时', r.isError === true && /超时/.test(r.text), r.text);
    check('7b 超时后不再补发', hits.length === 1, '请求数=' + hits.length);
    hits.length = 0;
    r = await run('slow', lanprintSet(base, { fetchTimeoutMs: 200, searchTimeoutMs: 5000 }));
    check('7c 反向对照：搜索不看 fetchTimeoutMs（它自己那条说了算）', r.isError === false, r.text);

    console.log('\n[8] 设置往返：界面保存的那份载荷存进去，工具读到的是不是同一件事');
    store.saveSettings({
      shell: { shellPath: 'C:/Program Files/Git/bin/bash.exe' },
      web: {
        searchProvider: 'lanprint',
        lanprint: { endpoint: base, key: 'k-test' },
        searxng: { endpoint: 'http://127.0.0.1:8888' },
        searchTimeoutMs: 45000,
      },
    });
    const got = store.getSettings().web;
    check('8a searchProvider 存住了', got.searchProvider === 'lanprint', String(got.searchProvider));
    check('8b 密钥存住了', got.lanprint.key === 'k-test', String(got.lanprint.key));
    check('8c 端点存住了', got.lanprint.endpoint === base, String(got.lanprint.endpoint));
    check('8d 超时存住了', Number(got.searchTimeoutMs) === 45000, String(got.searchTimeoutMs));
    check('8e 另一路的参数没被这次保存覆盖', got.searxng.endpoint === 'http://127.0.0.1:8888', String(got.searxng.endpoint));
    check('8f 老字段 fetchTimeoutMs 还在（没被新结构挤掉）', Number(got.fetchTimeoutMs) === 20000, String(got.fetchTimeoutMs));
    hits.length = 0;
    const e2e = await run('alpha', got);
    check('8g 端到端：拿存下来的设置直接搜，走的是 lanprint 那条路（根路径 + 密钥头）',
      e2e.isError === false && lastHit().path === '/' && lastHit().headers['x-api-key'] === 'k-test',
      lastHit().path + ' / ' + String(lastHit().headers['x-api-key']));
  } finally {
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n搜索结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
