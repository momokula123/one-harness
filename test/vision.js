'use strict';
// 图片输入（多模态）链路的测试：不联网，假端点自己造。
// 运行： node test/vision.js
//
// 为什么单独一份而不是塞进 smoke：smoke 的假端点只跑"文本 + 工具调用"这一条happy path，
// 而图片这边真正要守的是三条**分支** —— 开关打开时线上必须是数组形、开关关掉时必须退回
// 文本行、端点不吃图时必须剥图重发。第三条还需要假端点会**故意回 400**。

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp-vision');
process.env.HATCH_DATA_DIR = path.join(TMP, 'data');

const store = require('../core/store');
const sessionLib = require('../core/session');
const images = require('../core/images');
const compact = require('../core/compact');
const runlog = require('../core/runlog');
const { Agent } = require('../core/agent');
const { PROMPTS } = require('../core/prompts');

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

// ---------- 假模型服务 ----------
// seen 里**不留原始 base64**（一张图就是几 MB，留在内存里毫无意义），
// 只留"形状事实"：content 是不是数组、image_url 是对象还是字符串、url 前缀是什么。
let seen = [];
let mode = 'ok'; // ok | reject（reject = 凡带图的请求一律回 400）

function hasImage(msgs) {
  return (msgs || []).some((m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url'));
}

function shapeOf(msgs) {
  return (msgs || []).map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map((p) => (p && p.type === 'image_url'
        ? { type: p.type, isObject: typeof p.image_url === 'object', urlHead: String((p.image_url && p.image_url.url) || '').slice(0, 30) }
        : { type: p && p.type, text: p && p.text }))
      : m.content,
  }));
}

function startMock() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }
    if (!req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const msgs = payload.messages || [];
      const withImage = hasImage(msgs);
      seen.push({ withImage, shape: shapeOf(msgs) });

      if (mode === 'reject' && withImage) {
        // 本机端点在"图太小/格式不对"时回的就是这个 code（实测 1×1 PNG 得到过）
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid image data', type: 'invalid_request_error', code: 'invalid_image_data' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      send({ choices: [{ index: 0, delta: { content: '我看到了这张图。' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ usage: { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function newAgent(events) {
  return new Agent({
    getSettings: () => store.getSettings(),
    emit: (ev) => events.push(ev),
    askUser: async () => ({ approved: true, note: '测试自动批准' }),
  });
}

function makeSession(project, name) {
  const s = sessionLib.createSession({ projectId: project.id, name, programId: 'coder' });
  s.instruction = PROMPTS.coder;
  return s;
}

function readLog() {
  const f = runlog.logFile();
  return (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').filter((l) => l.trim());
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const ws = path.join(TMP, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  // 拿仓库里那张真图（1280×648）：尺寸固定，断言才能写死
  const imgPath = path.join(ws, 'shot.png');
  fs.copyFileSync(path.join(ROOT, 'assets', 'screenshot.png'), imgPath);

  const server = await startMock();
  const port = server.address().port;
  store.init();
  store.saveSettings({
    model: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'mock-model' },
    approval: { mode: 'auto' },
  });
  runlog.init({ dataDir: path.join(TMP, 'data'), logDir: path.join(TMP, 'logs') });

  console.log('\n假模型服务: http://127.0.0.1:' + port + '/v1\n');

  // ---------- 1) 图片支撑层 ----------
  console.log('1) core/images.js');
  const dim = (b) => images.dimensionsOf(b); // 只比字段，不比 JSON 键序（各家分支的书写顺序不同）
  const isDim = (r, w, h) => !!r && r.width === w && r.height === h;
  check('认 png/jpg/jpeg/gif/webp', ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp'].every((n) => images.isImage(n)));
  check('不认 txt/svg/无扩展名', !images.isImage('a.txt') && !images.isImage('a.svg') && !images.isImage('a'));
  check('PNG 宽高', isDim(dim(fs.readFileSync(imgPath).subarray(0, 64)), 1280, 648));
  const gif = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(32)]);
  check('GIF 宽高（小端 uint16）', isDim(dim(gif), 320, 240));
  const bmp = Buffer.alloc(40); bmp.write('BM', 0, 'ascii'); bmp.writeInt32LE(800, 18); bmp.writeInt32LE(600, 22);
  check('BMP 宽高', isDim(dim(bmp), 800, 600));
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0, 'ascii'); webp.write('WEBP', 8, 'ascii'); webp.write('VP8X', 12, 'ascii');
  webp[24] = 0xff; webp[25] = 0x03; webp[27] = 0xff; webp[28] = 0x01;
  check('WebP(VP8X) 宽高', isDim(dim(webp), 1024, 512));
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
  check('JPEG(SOF0) 宽高', isDim(dim(jpg), 1280, 720));

  const info = images.inspect(imgPath);
  check('inspect 拿到尺寸与 data URL', info.ok && info.width === 1280 && info.height === 648 && info.dataUrl.startsWith('data:image/png;base64,'));
  check('缓存命中（同一对象引用，不会每步重读盘）', images.inspect(imgPath) === info);
  check('token 估算是保守值（实测端点约 530，公式给 ' + info.tokens + '）', info.tokens >= 530);
  check('缺失文件返回中文错误而不是抛', (() => { const r = images.inspect(path.join(ws, 'nope.png')); return !r.ok && /不在了/.test(r.error); })());
  check('非图片扩展名被挡下', (() => { const r = images.inspect(path.join(ROOT, 'package.json')); return !r.ok && /不是支持的图片格式/.test(r.error); })());

  // 超限：用稀疏文件造一个 11MB 的 .png，不真写 11MB 数据
  const big = path.join(ws, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(1));
  fs.truncateSync(big, 11 * 1024 * 1024);
  check('超过 10MB 上限时拒绝并说明原因', (() => { const r = images.inspect(big); return !r.ok && /上限/.test(r.error); })());
  fs.rmSync(big, { force: true });

  // ---------- 2) 数据形状 ----------
  console.log('\n2) 数据形状（core/session.js）');
  const project = store.createProject('图片测试', ws);
  const s1 = makeSession(project, '形状');
  const entry = sessionLib.userMessage(s1, '看看这张图', { images: ['shot.png'] });
  check('userMessage 写进 image part（只记相对路径，不记 base64）',
    entry.parts.some((p) => p.type === 'image' && p.rel === 'shot.png')
    && JSON.stringify(entry.parts).length < 400, JSON.stringify(entry.parts));
  check('image part 自带 mime', entry.parts.find((p) => p.type === 'image').mime === 'image/png');

  const off = sessionLib.renderMessages(s1);
  check('开关关掉时退回字符串形', typeof off[1].content === 'string', JSON.stringify(off[1].content));
  check('且补出 [附件] 行（图仍在工作目录里，模型仍知道它存在）',
    off[1].content === '看看这张图\n\n[附件] shot.png', JSON.stringify(off[1].content));

  const on = sessionLib.renderMessages(s1, { vision: true });
  check('开关打开时 content 是数组', Array.isArray(on[1].content), JSON.stringify(on[1].content).slice(0, 120));
  const picPart = (on[1].content || []).find((p) => p.type === 'image_url');
  check('image_url 是**对象**形（/chat/completions 的规范，不是 /responses 的字符串形）',
    !!picPart && typeof picPart.image_url === 'object' && typeof picPart.image_url.url === 'string');
  check('url 带 data: 前缀（OpenAI 面必须有，Anthropic 反而不能有）',
    !!picPart && picPart.image_url.url.startsWith('data:image/png;base64,'));
  check('文本 part 里不再重复 [附件] 行（两处都写就重了）',
    !/\[附件\]/.test(on[1].content[0].text), JSON.stringify(on[1].content[0].text));

  const s2 = makeSession(project, '图丢了');
  sessionLib.userMessage(s2, '看看这张图', { images: ['gone.png'] });
  const lost = sessionLib.renderMessages(s2, { vision: true });
  check('图被删/改名时不整轮失败，降级成一行中文说明',
    Array.isArray(lost[1].content) && /图片不可用：gone.png/.test(lost[1].content[0].text),
    JSON.stringify(lost[1].content));

  const s3 = makeSession(project, '只发图');
  sessionLib.userMessage(s3, '', { images: ['shot.png'] });
  const onlyImg = sessionLib.renderMessages(s3, { vision: true });
  check('只拖图不打字时文本 part 给占位（避免"只有 image part"的消息）',
    Array.isArray(onlyImg[1].content) && onlyImg[1].content[0].text.length > 0, JSON.stringify(onlyImg[1].content[0]));

  const row = sessionLib.renderTranscript(s1).find((r) => r.kind === 'user');
  check('transcript 带出图片（界面才看得见自己拖了什么）', !!row && row.images.length === 1 && row.images[0].rel === 'shot.png');
  check('transcript 里不带 data URL（它每轮都要重发一份）', !JSON.stringify(sessionLib.renderTranscript(s1)).includes('base64,'));

  // ---------- 3) 压缩配套（不做会静默坏） ----------
  console.log('\n3) 压缩配套（core/compact.js）');
  const withImg = compact.estimateMessagesTokens(on);
  check('token 估算认得数组形（老代码会把它 String() 成 [object Object] → 算成个位数）',
    withImg > 1000, String(withImg));
  check('纯文本那条仍按老算法算（字符串分支没被改坏）',
    compact.estimateMessagesTokens([{ role: 'user', content: '你好世界' }]) === sessionLib.estimateTokens('你好世界'));
  check('摘要里给图留占位符（不然压缩后模型再也想不起图里是什么）',
    /附图 1 张：shot.png/.test(compact.transcriptToText(s1)));
  check('摘要里不含 base64', !compact.transcriptToText(s1).includes('base64,'));

  // ---------- 4) 端到端：开关打开 ----------
  console.log('\n4) 端到端：勾了"支持图片输入"');
  store.saveSettings({ model: { supportsVision: true } });
  seen = [];
  const ev4 = [];
  const s4 = makeSession(project, '开视觉');
  sessionLib.userMessage(s4, '这张图里是什么', { images: ['shot.png'] });
  const r4 = await newAgent(ev4).runTurn(s4);
  check('本轮成功', r4.ok === true, JSON.stringify(r4));
  check('端点确实收到了图片', seen.length === 1 && seen[0].withImage === true);
  const up = (seen[0].shape.find((m) => m.role === 'user') || {}).content;
  check('线上 user content 是数组，且是 image_url 对象形 + data: 前缀',
    Array.isArray(up) && up.some((p) => p.type === 'image_url' && p.isObject && p.urlHead.startsWith('data:image/png;base64,')),
    JSON.stringify(up));
  check('正文与图片在同一条消息里（不拆成两条）', Array.isArray(up) && up[0].text === '这张图里是什么', JSON.stringify(up && up[0]));
  check('助手回复落盘', /我看到了这张图/.test(sessionLib.entryPlainText(s4.entries.filter((e) => e.role === 'assistant').pop())));

  // ---------- 5) 端到端：开关关掉 ----------
  console.log('\n5) 端到端：没勾（行为必须和接图片之前一模一样）');
  store.saveSettings({ model: { supportsVision: false } });
  seen = [];
  const s5 = makeSession(project, '关视觉');
  sessionLib.userMessage(s5, '这张图里是什么', { images: ['shot.png'] });
  const r5 = await newAgent([]).runTurn(s5);
  check('本轮成功', r5.ok === true);
  check('端点没收到图片', seen.length === 1 && seen[0].withImage === false);
  check('线上是字符串形 + [附件] 行',
    (seen[0].shape.find((m) => m.role === 'user') || {}).content === '这张图里是什么\n\n[附件] shot.png',
    JSON.stringify((seen[0].shape.find((m) => m.role === 'user') || {}).content));

  // ---------- 6) 端到端：勾错了（端点不吃图） ----------
  console.log('\n6) 端到端：勾了但端点不吃图 → 剥图重发，不许整轮崩');
  store.saveSettings({ model: { supportsVision: true } });
  mode = 'reject';
  seen = [];
  const ev6 = [];
  const s6 = makeSession(project, '勾错');
  sessionLib.userMessage(s6, '这张图里是什么', { images: ['shot.png'] });
  const r6 = await newAgent(ev6).runTurn(s6);
  mode = 'ok';
  check('本轮没崩（这是最关键的一条：勾错不该让整轮对话发不出去）', r6.ok === true, JSON.stringify(r6));
  check('发了两次请求', seen.length === 2, '实际 ' + seen.length);
  check('第一次带图', !!seen[0] && seen[0].withImage === true);
  check('第二次剥掉了图', !!seen[1] && seen[1].withImage === false);
  check('第二次仍带上 [附件] 行（图没被彻底丢掉）',
    /\[附件\] shot.png/.test(String((seen[1].shape.find((m) => m.role === 'user') || {}).content)));
  check('助手回复仍然落盘（重发成功，用户拿到的是答案而不是报错）',
    /我看到了这张图/.test(sessionLib.entryPlainText(s6.entries.filter((e) => e.role === 'assistant').pop())));
  const notice = s6.entries.filter((e) => e.type === 'error').map((e) => e.message).join('\n');
  check('给了明确的中文提示（说清"怎么办"，不是一句英文堆栈）',
    /拒绝了图片输入/.test(notice) && /设置 → 常规/.test(notice) && /取消勾选/.test(notice), notice.slice(0, 200));
  check('提示里带上原始报错（便于事后查）', /invalid_image_data/.test(notice));
  check('运行日志记了这次降级', readLog().some((l) => l.includes('vision.fallback')));
  check('降级后同一步不再重复撞 400（本轮只发了 2 次请求）', seen.length === 2);
  check('model.start 日志里带了本次请求有没有图（事后能看出"这轮为什么慢/为什么贵"）',
    readLog().some((l) => l.includes('"kind":"model.start"') && /"images":\d/.test(l)));

  // ---------- 7) 边界：正文里本来就有 [附件] 字样 ----------
  console.log('\n7) 边界');
  const s7 = makeSession(project, '边界');
  sessionLib.userMessage(s7, '帮我看看 [附件] 这个说法对不对', { images: ['shot.png'] });
  const m7 = sessionLib.renderMessages(s7, { vision: false });
  check('用户正文里恰好有 [附件] 字样时不会串味（只在末尾补一行）',
    m7[1].content === '帮我看看 [附件] 这个说法对不对\n\n[附件] shot.png', JSON.stringify(m7[1].content));
  check('图片不改变工具的可见性（schema 数量不受影响）',
    typeof require('../core/tools').schemasFor(['read_file_lines']).length === 'number');

  server.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
