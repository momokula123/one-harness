'use strict';
// 内置浏览器 / web_fetch 的「地址没写协议」口径探针。
// 纯 node，不需要 Electron、不联网（web_fetch 那几条把 fetch 换了桩）。
//
// 背景（用户报的 bug）：旧代码对不带协议的地址一律补 `https://`，
// 于是 `localhost:3000`、`192.168.1.9:8080` 这类**只跑 http 的服务永远打不开** ——
// 用户看到的就是「内置浏览器只接受 https」。现在的口径：
//   · 调用方写了协议 → 照它走（不自作主张换）；
//   · 没写协议       → http 先试，失败再 https。
//
// 运行： node test/browser-nav.js

const browser = require('../core/tools/browser');
const web = require('../core/tools/web');

let pass = 0;
const fails = [];
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fails.push(name); console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

const cands = (s) => browser.urlCandidates(s);

(async () => {
  console.log('— 地址候选（urlCandidates）—');

  // ① 核心：裸地址默认 http 打头，https 兜底
  const bare = cands('localhost:3000');
  check('裸地址 localhost:3000 → [http, https] 两个候选',
    bare.list && bare.list[0] === 'http://localhost:3000' && bare.list[1] === 'https://localhost:3000', bare);
  check('★ 反向对照：裸地址的第一个候选**不是** https（旧代码正是补 https，本机服务必挂）',
    bare.list && !/^https:/.test(bare.list[0]), bare.list && bare.list[0]);

  check('裸域名 example.com/a?b=1 → [http, https]',
    JSON.stringify(cands('example.com/a?b=1').list) === JSON.stringify(['http://example.com/a?b=1', 'https://example.com/a?b=1']),
    cands('example.com/a?b=1'));
  check('裸内网 IP 192.168.1.9:8080 → [http, https]',
    cands('192.168.1.9:8080').list[0] === 'http://192.168.1.9:8080', cands('192.168.1.9:8080'));

  // ② 写了协议就尊重，只有一个候选
  check('http:// 原样、不换协议',
    JSON.stringify(cands('http://example.com/x').list) === JSON.stringify(['http://example.com/x']), cands('http://example.com/x'));
  check('https:// 原样（大写协议也认）',
    JSON.stringify(cands('HTTPS://Example.com/A').list) === JSON.stringify(['HTTPS://Example.com/A']), cands('HTTPS://Example.com/A'));

  // ③ 安全边界没被放开：只有 http/https
  check('file:// 一律拒（那是执行本地文件的原语）', !!cands('file:///C:/Windows/win.ini').error, cands('file:///C:/Windows/win.ini'));
  check('chrome:// 也拒', !!cands('chrome://settings').error, cands('chrome://settings'));
  check('空地址给明确提示，不发请求', !!cands('   ').error, cands('   '));
  check('畸形地址不抛异常、给 error', !!cands('http://').error || !!cands('http://').list, cands('http://'));

  console.log('— web_fetch 的尝试顺序（fetch 用桩）—');
  const realFetch = global.fetch;
  const stub = (failFor) => {
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (failFor(String(url))) throw new Error('桩：连接失败 ' + url);
      return {
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><head><title>桩页面</title></head><body>hello</body></html>',
      };
    };
    return seen;
  };
  const ctx = { settings: { web: { fetchTimeoutMs: 1000, maxChars: 500 } } };
  const run = (url) => web.tools.find((t) => t.alias === 'web_fetch').run({ url }, ctx);

  // ④ http 通的站点：只试一次 http 就收工
  let seen = stub(() => false);
  let r = await run('127.0.0.1:8899/bw-http-probe.html');
  check('裸地址 + http 服务 → 用 http:// 抓到，且只请求了一次',
    seen.length === 1 && seen[0] === 'http://127.0.0.1:8899/bw-http-probe.html' && /HTTP 200/.test(r),
    { seen, head: String(r).slice(0, 60) });

  // ⑤ http 打不通（443-only 站点）→ 自动回落 https
  seen = stub((u) => u.startsWith('http://'));
  r = await run('example.com');
  check('裸地址 + https-only 站点 → http 失败后自动换 https 成功',
    seen.length === 2 && seen[1] === 'https://example.com' && /https:\/\/example\.com/.test(String(r)),
    { seen, head: String(r).slice(0, 60) });

  // ⑥ 写了协议就不换（失败就是失败，别偷偷改调用方的意图）
  seen = stub((u) => u.startsWith('http://'));
  r = await run('http://example.com');
  check('显式 http:// 打不通 → 报错、不会悄悄改成 https',
    seen.length === 1 && seen[0] === 'http://example.com' && /抓取失败/.test(String(r.text || r)),
    { seen, r: String(r.text || r).slice(0, 80) });

  global.fetch = realFetch;

  console.log('\n通过 ' + pass + ' / 失败 ' + fails.length);
  if (fails.length) console.log('失败项：\n  ' + fails.join('\n  '));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.log('测试异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e));
  process.exit(1);
});
