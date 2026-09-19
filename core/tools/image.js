'use strict';
// 生图工具：打 OpenAI 兼容的 `POST {baseUrl}/images/generations`（agnes 家是 agnes-image-2.5-flash）。
//
// 与 office 那条纪律一致：工具读取调用方给的配置（ctx.settings.fallback.image），
// 自己不读文件、不碰 store —— 端点从哪来是设置层的事，这里只负责"按图办事"。
//
// 产出的图**落进会话工作目录**（不返回 URL 了事）：URL 是别人的存储、过一阵就没了，
// 而用户要的是自己文件夹里的一张图。落盘用 store.uniquePath —— 同名往后加 -1，永不覆盖。

const fs = require('fs');
const path = require('path');
const model = require('../model');
const images = require('../images');
const { resolveIn, toRel } = require('./fs');
const { uniquePath } = require('../store');

const SIZES = ['1K', '2K', '3K', '4K'];
const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];
const MAX_REFS = 6;                       // 多图合成的参考图张数上限
const MAX_REF_BYTES = 10 * 1024 * 1024;   // 单张参考图上限（base64 之后约 ×1.37）
const REQUEST_TIMEOUT_MS = 300000;        // 官方建议 60~360s：出图要几秒到几十秒
const DOWNLOAD_TIMEOUT_MS = 120000;

/** 从返回的字节流认后缀 —— 别信 Content-Type，也别一律写 .png。 */
function extForBuffer(buf) {
  if (!buf || buf.length < 12) return '.png';
  if (buf.readUInt32BE(0) === 0x89504e47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '.png';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** save_as 只当文件名用：路径分隔符一律剥掉，别让它把产物写到工作目录外面去。 */
function safeBase(name) {
  const s = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '');
  return s ? s.slice(0, 80) : '';
}

/** 读参考图 → data URI。路径边界复用 fs 工具那条规则（越界就是越界，不偷偷放行）。 */
function readRefs(ctx, list) {
  const out = [];
  for (const raw of list) {
    const rel = String(raw || '').trim();
    if (!rel) continue;
    let abs;
    try {
      abs = resolveIn(ctx.workingDir, rel);
    } catch (e) {
      return { error: `${rel}：${e.message}` };
    }
    const mime = images.mimeFor(abs);
    if (!mime) return { error: `${rel}：不是支持的图片格式（png / jpg / gif / webp）` };
    let st;
    try {
      st = fs.statSync(abs);
    } catch (e) {
      return { error: `${rel}：读不到（${e.code === 'ENOENT' ? '文件不在了' : e.message}）` };
    }
    if (!st.isFile()) return { error: `${rel}：不是文件` };
    if (st.size > MAX_REF_BYTES) {
      return { error: `${rel}：${(st.size / 1048576).toFixed(1)}MB，超过 ${MAX_REF_BYTES / 1048576}MB 上限` };
    }
    out.push(`data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`);
  }
  return { refs: out };
}

/** 把接口返回的那一条（{url|b64_json}）变成字节。 */
async function bytesFromItem(item, signal) {
  if (item && typeof item.b64_json === 'string' && item.b64_json.trim()) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), via: 'b64_json' };
  }
  const url = item && typeof item.url === 'string' ? item.url.trim() : '';
  if (!url) return { error: '返回里既没有 url 也没有 b64_json：' + JSON.stringify(item).slice(0, 300) };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('下载图片超时')), DOWNLOAD_TIMEOUT_MS);
  const onAbort = () => ac.abort(signal && signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return { error: `图片地址下载失败：HTTP ${res.status} ${res.statusText}\n${url}` };
    return { buffer: Buffer.from(await res.arrayBuffer()), via: 'url' };
  } catch (e) {
    return { error: `图片地址下载失败：${(e && e.message) || e}\n${url}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const generateImage = {
  alias: 'generate_image',
  module: 'image',
  risk: 'low',
  writes: true,
  description:
    'Generate an image from a text prompt, or edit/compose existing images, with an OpenAI-compatible /images/generations endpoint. ' +
    'The image is written into the working directory and its relative path is returned. ' +
    'This calls a remote model (it may consume the provider\'s quota) and takes seconds to a minute — use it when the user actually wants an image, and do not call it twice for the same request. ' +
    'You cannot see the generated image yourself: the result is text only, so never claim you checked how it looks. ' +
    'Parameters: size is a tier (1K/2K/3K/4K), ratio is the aspect ratio; pass images to do image-to-image or multi-image composition.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'What to draw, in the user\'s own language. A good structure is: subject + scene/environment + style + lighting + composition + quality. ' +
          'For image-to-image, describe the change first and what must be preserved last.',
      },
      size: {
        type: 'string',
        enum: SIZES,
        description: 'Output tier. 1K is fine for drafts and screen use (default), 2K–4K for print or heavy detail.',
      },
      ratio: {
        type: 'string',
        enum: RATIOS,
        description: 'Aspect ratio, paired with size (default 1:1). Use 16:9 for wallpapers/banners, 9:16 for phone screens, 3:4 or 2:3 for portraits.',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description:
          `Optional input images for image-to-image or multi-image composition: relative paths inside the working directory (at most ${MAX_REFS}). ` +
          'Explain each reference image\'s role in the prompt.',
      },
      save_as: {
        type: 'string',
        description: 'Optional file name base (no extension, no path). Defaults to image-<timestamp>. An existing name gets -1/-2, so nothing is ever overwritten.',
      },
    },
    required: ['prompt'],
  },

  async run(args, ctx) {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return { text: '缺少 prompt 参数（要画什么）。', isError: true };

    const cfgOut = (ctx.settings && ctx.settings.fallback && ctx.settings.fallback.image) || {};
    const cfg = {
      baseUrl: String(cfgOut.baseUrl || '').trim(),
      apiKey: String(cfgOut.apiKey || '').trim(),
      model: String(cfgOut.model || '').trim(),
    };
    const missing = [];
    if (!cfg.baseUrl) missing.push('Base URL');
    if (!cfg.model) missing.push('模型名');
    if (missing.length) {
      return {
        text:
          `生图端点还没配（缺 ${missing.join(' / ')}），所以这次没发请求。\n` +
          '让用户到「设置 → 兜底模型 → 生图」里填上，或者改随包的 config/image.json（三者都可以填：地址填到 /v1 即可）。',
        isError: true,
      };
    }
    if (!cfg.apiKey) {
      return {
        text:
          '生图端点没有 API Key，这次没发请求 —— 没有 key 打过去只会拿回 401，还白等一轮。\n' +
          '请用户在「设置 → 兜底模型 → 生图」里填上自己的 key（在 agnes 官网注册后可在控制台领取），或改 config/image.json。',
        isError: true,
      };
    }

    const size = String(args.size || '1K').trim().toUpperCase();
    if (!SIZES.includes(size)) {
      return { text: `size 只能是 ${SIZES.join(' / ')}，收到 ${args.size}。`, isError: true };
    }
    const ratio = String(args.ratio || '1:1').trim();
    if (!RATIOS.includes(ratio)) {
      return { text: `ratio 只能是 ${RATIOS.join(' / ')}，收到 ${args.ratio}。`, isError: true };
    }

    const rawRefs = Array.isArray(args.images) ? args.images.filter((x) => String(x || '').trim()) : [];
    if (rawRefs.length > MAX_REFS) {
      return { text: `参考图一次最多 ${MAX_REFS} 张（收到 ${rawRefs.length} 张）。分几次做。`, isError: true };
    }
    let refs = [];
    if (rawRefs.length) {
      const r = readRefs(ctx, rawRefs);
      if (r.error) return { text: '参考图读不了：' + r.error, isError: true };
      refs = r.refs;
    }

    // 文档明确说过的一条：**不要**把 response_format 放在请求体顶层，要放 extra_body。
    // 这里两种返回形状都能接（url 下载 / b64_json 解码），所以只挑一种请求即可。
    const extra = { response_format: 'url' };
    if (refs.length) extra.image = refs;
    const body = { model: cfg.model, prompt, size, ratio, extra_body: extra };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('生图请求超时')), REQUEST_TIMEOUT_MS);
    const onAbort = () => ac.abort(ctx.signal && ctx.signal.reason);
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

    let json;
    const started = Date.now();
    try {
      const res = await fetch(model.joinUrl(cfg.baseUrl, '/images/generations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403 ? '\n（这个状态码多半是 key 不对或没生效：去「设置 → 兜底模型 → 生图」核对。）'
          : res.status === 429 ? '\n（被限流了：等一会儿再试，或换自己的 key。）'
          : res.status === 404 ? '\n（多半是 model 名字在这个端点上不存在。可用名字看端点的 /v1/models。）'
          : '';
        return { text: `生图接口返回 HTTP ${res.status} ${res.statusText}${hint}\n响应：${text.slice(0, 500)}`, isError: true };
      }
      try {
        json = text ? JSON.parse(text) : {};
      } catch (e) {
        return { text: `生图接口返回的不是 JSON：${text.slice(0, 300)}`, isError: true };
      }
    } catch (e) {
      const aborted = !!(ctx.signal && ctx.signal.aborted);
      return { text: aborted ? '这一轮已被停止。' : `生图请求失败：${(e && e.message) || e}`, isError: true };
    } finally {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
    }

    const item = (Array.isArray(json.data) ? json.data[0] : null) || null;
    if (!item) {
      return { text: '生图接口没有返回 data[0]：' + JSON.stringify(json).slice(0, 400), isError: true };
    }
    const got = await bytesFromItem(item, ctx.signal);
    if (got.error) return { text: got.error, isError: true };

    const base = safeBase(args.save_as) || 'image-' + stamp();
    const file = uniquePath(ctx.workingDir, base, extForBuffer(got.buffer));
    try {
      fs.writeFileSync(file, got.buffer);
    } catch (e) {
      return { text: `图片没能写进工作目录：${(e && e.message) || e}`, isError: true };
    }

    const rel = toRel(ctx.workingDir, file);
    const dim = images.dimensionsOf(got.buffer);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const lines = [
      `已生成：${rel}（${dim ? dim.width + '×' + dim.height + '　' : ''}${(got.buffer.length / 1024).toFixed(0)} KB　${secs}s）`,
      `参数：model=${cfg.model}　size=${size}　ratio=${ratio}${refs.length ? '　参考图 ' + refs.length + ' 张' : ''}`,
    ];
    if (item.revised_prompt) lines.push(`模型改写后的提示词：${String(item.revised_prompt).slice(0, 400)}`);
    lines.push('图已经落进工作目录，用户能在对话里直接看到缩略图，也能在右栏「文件」里打开。');
    lines.push('**你（模型）看不到这张图**：工具结果只能是文本，别声称自己看过效果；要确认成什么样，让用户看一眼。');

    return { text: lines.join('\n'), isError: false, images: [{ rel, mime: images.mimeFor(rel) || null }] };
  },
};

const tools = [generateImage];

module.exports = { tools, SIZES, RATIOS };
