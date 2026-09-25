'use strict';
// 联网工具：web_fetch（抓页面转文本）+ web_search（服务二选一：lanprint 私有转发层 / 自建 SearxNG）

const http = require('http');
const https = require('https');

// lanprint 转发层：端点随包给，密钥由用户填（母版是公开仓库，密钥不进 git）
const LANPRINT_DEFAULT_ENDPOINT = 'https://jinaapi.lanprint.com';
const LANPRINT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OneHarness/0.1 (+local agent)';

/**
 * 搜索服务解析 —— **只此一处判定**，工具与探针共用。
 * 返回 { provider: 'lanprint' | 'searxng' | '', endpoint, key }。
 *
 * provider 为空时：旧设置里如果留着 SearxNG 端点（那个字段比 provider 早），照旧按 SearxNG 走 ——
 * 升级前就在用的人不该被改坏；两者都没有才算"没启用"。
 */
function resolveSearch(web) {
  const w = web || {};
  const provider = String(w.searchProvider || '').trim();
  const lan = w.lanprint || {};
  const searx = w.searxng || {};
  const searxEndpoint = String(searx.endpoint || w.searchEndpoint || '').trim();
  if (provider === 'lanprint') {
    return {
      provider,
      endpoint: String(lan.endpoint || '').trim() || LANPRINT_DEFAULT_ENDPOINT,
      key: String(lan.key || '').trim(),
    };
  }
  if (provider === 'searxng') return { provider, endpoint: searxEndpoint, key: '' };
  if (searxEndpoint) return { provider: 'searxng', endpoint: searxEndpoint, key: '' };
  return { provider: '', endpoint: '', key: '' };
}

/**
 * 走转发层这条通道**不用全局 fetch 的唯一原因就是 IPv4**：
 * 转发层对 IPv6 一律 403（原话 "IPv6 access is not allowed" —— IPv6 单段地址量太大，
 * 按 IP 封禁会失效，所以它整体拒绝）。而 Node 20+ 的 fetch 默认开 autoSelectFamily
 * （Happy Eyeballs），本机有 IPv6 时会先试 AAAA —— 于是"参数全对却永远 403"。
 * family:4 + autoSelectFamily:false 把这条通道钉死在 A 记录上（探针里有断言）。
 */
function ipv4RequestOptions(headers, timeoutMs) {
  return { method: 'GET', headers, family: 4, autoSelectFamily: false, timeout: timeoutMs };
}

/** 转发层的搜索地址：没写协议就补 https（转发层只跑 https）、末尾斜杠归一、q 走标准编码。 */
function lanprintUrl(endpoint, query) {
  const base = /^https?:\/\//i.test(endpoint) ? endpoint : 'https://' + endpoint;
  const u = new URL(base.replace(/\/+$/, '') + '/');
  u.searchParams.set('q', query);
  return u.toString();
}

/** GET 一个地址、拿回 { status, headers, body }（不自动跳转、不重试 —— 转发层猜错密钥会逐级封禁）。 */
function httpGetText(target, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(target);
    } catch (e) {
      reject(new Error(`地址不合法：${target}`));
      return;
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, ipv4RequestOptions(headers, timeoutMs), (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 转发层的错误码翻译成人话（状态码表见它自己的 /stats 文档）。**任何一条都不重试**。 */
function lanprintError(status, body, headers) {
  const b = String(body || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  const retryAfter = headers ? headers['retry-after'] : '';
  if (status === 400) return `搜索没成功：这个查询被拒绝了。${b}`;
  if (status === 401) {
    return '搜索失败：密钥不对。请在「设置 → 高级 → 工具」里核对 —— 连错几次会被暂时封禁，别反复重试。';
  }
  if (status === 403) return `搜索失败：对方拒绝了这次访问。${b}`;
  if (status === 429) return `搜索太频繁，被暂时挡下了${retryAfter ? `，${retryAfter} 秒后再试` : '，稍等一会儿再试'}。`;
  if (status === 503) return '搜索服务暂时不可用，稍后再试。';
  if (status >= 500) return `搜索失败：搜索服务出错了。${b}`;
  return `搜索失败。${b}`;
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  const entities = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&mdash;': '—', '&hellip;': '…' };
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => entities[m.toLowerCase()] ?? ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return s.trim();
}

function titleOf(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

async function fetchWithTimeout(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
  try {
    return await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OneHarness/0.1 (+local agent)',
        Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
    });
  } finally {
    clearTimeout(t);
  }
}

const webFetch = {
  alias: 'web_fetch',
  module: 'web',
  risk: 'low',
  writes: false,
  description: 'Fetch a URL over the network and return its readable text content (HTML is converted to plain text).',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch. The scheme may be omitted — then it is tried as http first and https as a fallback.' },
      maxChars: { type: 'integer', description: 'Max characters to return. Default from settings.' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const input = String(args.url || '').trim();
    if (!input) return { text: '抓取失败：地址是空的。', isError: true };
    // 与 browser_open 同一口径（那份的说明见 core/tools/browser.js 的 urlCandidates）：
    // 没写协议就 http 先试、https 兜底 —— 旧写法一律补 https，本机/内网的 http 服务抓不到。
    // fetch 用 redirect:'follow'，支持 https 的站点在 http 上会自己 301 过去，所以先走 http 不吃亏。
    const cands = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? [input] : ['http://' + input, 'https://' + input];
    let url = cands[0];
    try {
      let res = null;
      let lastErr = null;
      for (const u of cands) {
        try {
          res = await fetchWithTimeout(u, ctx.settings.web.fetchTimeoutMs);
          url = u;
          break;
        } catch (e) {
          lastErr = e;                      // 网络级失败（拒绝连接/DNS/SSL）才轮得到下一个候选
        }
      }
      if (!res) throw lastErr;
      const ctype = res.headers.get('content-type') || '';
      const raw = await res.text();
      const cap = Math.min(Number(args.maxChars) || ctx.settings.web.maxChars, 200000);
      if (ctype.includes('json') || ctype.includes('text/plain')) {
        return `HTTP ${res.status} ${url}\n\n` + raw.slice(0, cap);
      }
      const title = titleOf(raw);
      const text = htmlToText(raw);
      const body = text.length > cap ? text.slice(0, cap) + `\n…[内容截断，原文 ${text.length} 字符]` : text;
      return `HTTP ${res.status} ${url}${title ? '\n标题：' + title : ''}\n\n${body}`;
    } catch (e) {
      return { text: `抓取失败：${e.message}`, isError: true };
    }
  },
};

const webSearch = {
  alias: 'web_search',
  module: 'web',
  risk: 'low',
  writes: false,
  description:
    'Search the web and return readable results. The service comes from settings: either a remote search service (returns a prepared Markdown digest, needs a key) or a self-hosted SearxNG JSON API. When it is not configured the tool reports exactly what is missing instead of guessing.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'integer', description: 'Max results, default 8. Only meaningful for SearxNG — the other service returns its own digest.' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const web = (ctx.settings || {}).web || {};
    const svc = resolveSearch(web);
    // 搜索有自己那条超时（实测转发层一次要 20~30 秒），别跟抓页面共用 20 秒的默认值
    const timeoutMs = Number(web.searchTimeoutMs) || 90000;
    const cap = Math.max(1000, Math.min(Number(web.maxChars) || 20000, 200000));
    const q = String(args.query || '').trim();
    if (!q) return { text: '搜索失败：查询词是空的。', isError: true };
    if (!svc.provider) {
      return {
        text:
          '联网搜索还没开：请在「设置 → 高级 → 工具」里选一种搜索服务并填好参数。',
        isError: true,
      };
    }

    // lanprint 转发层：GET {端点}/?q=… ，密钥走 X-Api-Key 头（不进 URL，免得落进日志）
    if (svc.provider === 'lanprint') {
      if (!svc.key) {
        return {
          text: '搜索失败：还差密钥。请在「设置 → 高级 → 工具」里选中 One 搜索 并填入密钥。',
          isError: true,
        };
      }
      try {
        const res = await httpGetText(lanprintUrl(svc.endpoint, q), { 'X-Api-Key': svc.key, 'User-Agent': LANPRINT_UA, Accept: 'text/plain' }, timeoutMs);
        if (res.status !== 200) return { text: lanprintError(res.status, res.body, res.headers), isError: true };
        const body = res.body.trim();
        if (!body) return `没有搜到 "${q}" 的结果。`;
        const text = body.length > cap ? body.slice(0, cap) + `\n…[结果截断，原文 ${body.length} 字符]` : body;
        return `搜索：${q}\n\n${text}`;
      } catch (e) {
        return { text: `搜索失败：${e.message}`, isError: true };
      }
    }

    // SearxNG：保持原形态（{端点}/search?q=…&format=json，解析 results 数组）
    if (!svc.endpoint) {
      return {
        text: '搜索失败：还差地址。请在「设置 → 高级 → 工具」里填 SearxNG 地址（例如 http://127.0.0.1:8888）。',
        isError: true,
      };
    }
    try {
      const u = new URL(svc.endpoint.replace(/\/+$/, '') + '/search');
      u.searchParams.set('q', q);
      u.searchParams.set('format', 'json');
      const res = await fetchWithTimeout(u.toString(), timeoutMs);
      if (!res.ok) return { text: `搜索接口返回 HTTP ${res.status}`, isError: true };
      const data = await res.json();
      const results = (data.results || []).slice(0, Math.min(Number(args.maxResults) || 8, 20));
      if (!results.length) return `没有搜到 "${q}" 的结果。`;
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n\n');
    } catch (e) {
      return { text: `搜索失败：${e.message}`, isError: true };
    }
  },
};

module.exports = { tools: [webFetch, webSearch], htmlToText, resolveSearch, lanprintUrl, ipv4RequestOptions, lanprintError };
