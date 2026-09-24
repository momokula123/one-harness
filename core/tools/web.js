'use strict';
// 联网工具：web_fetch（抓页面转文本）+ web_search（需自行配置 SearxNG 之类端点）

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
    'Search the web and return result titles, URLs and snippets. Requires a search endpoint to be configured in settings (any SearxNG-compatible JSON API).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'integer', description: 'Max results, default 8' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const endpoint = (ctx.settings.web.searchEndpoint || '').trim();
    if (!endpoint) {
      return {
        text:
          '联网搜索未配置：请在「设置 → 联网」里填写一个 SearxNG 实例地址（例如 http://127.0.0.1:8888）。\n' +
          '在此之前你可以用 web_fetch 直接抓取已知网址。',
        isError: true,
      };
    }
    const u = new URL(endpoint.replace(/\/+$/, '') + '/search');
    u.searchParams.set('q', String(args.query || ''));
    u.searchParams.set('format', 'json');
    try {
      const res = await fetchWithTimeout(u.toString(), ctx.settings.web.fetchTimeoutMs);
      if (!res.ok) return { text: `搜索接口返回 HTTP ${res.status}`, isError: true };
      const data = await res.json();
      const results = (data.results || []).slice(0, Math.min(Number(args.maxResults) || 8, 20));
      if (!results.length) return `没有搜到 "${args.query}" 的结果。`;
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n\n');
    } catch (e) {
      return { text: `搜索失败：${e.message}`, isError: true };
    }
  },
};

module.exports = { tools: [webFetch, webSearch], htmlToText };
