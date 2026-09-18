'use strict';
// Office 文档：用 LibreOffice 引擎校验与渲染（转换走 @deepseek-ai/libreoffice-kit）。
//
// 引擎是**可选依赖**：装了就注册工具，没装就一个工具都不注册。
// 刻意不做「注册了但必然失败」的工具 —— 那会让模型拿着错的环境反馈反复重试
// （2026-09-17 那次 41 分钟空转就是这么来的）。Bionic 的同名工具也是这个语义：
// 引擎不在，工具直接从工具表里消失，而不是报错。
//
// 本模块只做适配：路径边界复用 fs 工具那条规则，引擎能力原样暴露，不额外发明行为。

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { resolveIn, toRel } = require('./fs');
// 同名产物往后加 -1/-2、永不覆盖 —— 这条语义只允许一处实现（拖入的附件复制也用它）
const { uniquePath } = require('../store');

const KIT = '@deepseek-ai/libreoffice-kit';
const PDFIUM = '@hyzyla/pdfium';

// 引擎直接吃的后缀。kit 的契约：二进制 .doc/.xls/.ppt 必须是 OLE 复合文档，
// 改后缀的 RTF/HTML 和 .wps 一律不吃。
const OFFICE_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

// 三档质量 → 光栅化缩放倍数。PDF 基准是 72 DPI，故 1x/2x/3x = 72/144/216。
const QUALITY_SCALE = { low: 1, medium: 2, high: 3 };
const MAX_PAGES = 8;

/** 本地检查，不发网络请求（和 dsh 的 available() 同一条纪律）。 */
function engineUsable() {
  try {
    require.resolve(KIT);
    return true;
  } catch {
    return false;
  }
}

// ---- 引擎句柄：懒加载、进程内复用一个 ----
// 转换器自带字体索引快照，每次调用重建会重复索引字体，所以复用一个；
// 转换本身由 kit 串行化，每个 render 起一个全新引擎进程 + 私有配置目录，状态不串味。
let kitPromise = null;
let converter = null;

function loadKit() {
  if (!kitPromise) kitPromise = import(KIT);
  return kitPromise;
}

async function getConverter() {
  if (converter) return converter;
  const { createConverter } = await loadKit();
  converter = await createConverter({ timeoutMs: 180000 });
  return converter;
}

function disposeConverter() {
  const c = converter;
  converter = null;
  if (c) c.dispose().catch(() => {});
}
process.once('exit', disposeConverter);

// ---- 输出路径：引擎拒绝覆盖已存在的文件，所以先找一个空位 ----
function extOf(absPath) {
  return path.extname(absPath).toLowerCase();
}

/** 转换前统一把关：后缀、存在性、是否常规文件。返回错误文本，null 表示通过。 */
function precheck(abs, rel) {
  if (!fs.existsSync(abs)) return `文件不存在：${rel}`;
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    return `无法读取 ${rel}：${e.message}`;
  }
  if (!st.isFile()) return `不是文件：${rel}`;
  const ext = extOf(abs);
  if (!OFFICE_EXT.has(ext)) {
    return (
      `引擎不支持 ${ext || '(无后缀)'}。可转换的后缀只有 ` +
      `${[...OFFICE_EXT].join(' / ')}；不要把 RTF、HTML、WPS 改后缀冒充 —— 引擎按内部结构判断，会直接拒绝。`
    );
  }
  return null;
}

/** 把 kit 的分类错误码翻成给模型看的、可据以决定下一步的说法。 */
function explainConversionError(e) {
  const code = (e && e.code) || '';
  const msg = (e && e.message ? e.message : String(e)).slice(0, 400);
  switch (code) {
    case 'invalid-document':
      return `文档结构已损坏，引擎打不开（invalid-document）。不要再重试同一个文件，先修复或换文件。\n引擎原文：${msg}`;
    case 'unsupported-format':
      return `引擎不支持这种格式（unsupported-format）。换支持的格式，别重试。\n引擎原文：${msg}`;
    case 'input-too-large':
      return `文件超过引擎输入上限（默认 64 MiB，input-too-large）。\n引擎原文：${msg}`;
    case 'output-too-large':
      return `转换产出的 PDF 超过上限（默认 128 MiB，output-too-large）。\n引擎原文：${msg}`;
    case 'timeout':
      return `转换超时（timeout）。这个文件要么太大要么有拖慢排版的内容，不要原样重试。\n引擎原文：${msg}`;
    case 'unavailable':
      return `引擎不可用（unavailable）：LibreOffice 引擎包缺失或安装不完整。这是环境问题，重试没有意义 —— 需要重新安装 @deepseek-ai/libreoffice-kit。\n引擎原文：${msg}`;
    default:
      // 没有 code 的多半是我们自己的校验或内部错误，原样报出去。
      // 别一律包装成「引擎故障」—— 那会把排查方向带偏到引擎上去。
      return code ? `引擎报错（${code}）。\n引擎原文：${msg}` : msg;
  }
}

/** 缺字体会被替换字体顶上，版式可能和预期不一样 —— 这条值得让模型看到。 */
function fontNote(missingFonts) {
  if (!missingFonts || !missingFonts.length) return '';
  return `\n缺失字体：${missingFonts.join('、')}（这些位置会用替代字体渲染，行宽和分页可能与预期不同）`;
}

// ---- PNG 编码：pdfium 只吐 BGRA 原始位图，PNG 自己封 ----
// 用 node:zlib 压 IDAT，全程无额外依赖；输入恒为 RGBA8，所以 filter 固定 0。
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** BGRA 原始位图 → RGBA8 PNG。 */
function encodePng(bgra, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + 1 + x * 4;
      raw[d] = bgra[s + 2];
      raw[d + 1] = bgra[s + 1];
      raw[d + 2] = bgra[s];
      raw[d + 3] = bgra[s + 3] === 0 ? 255 : bgra[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PDF → 选定的若干页 PNG。pages 为空则全部页（上限 MAX_PAGES）。 */
async function rasterize(pdfBuffer, pages, scale, outDir, base) {
  const { PDFiumLibrary } = await import(PDFIUM);
  const library = await PDFiumLibrary.init();
  const written = [];
  try {
    const doc = await library.loadDocument(pdfBuffer);
    try {
      const total = doc.getPageCount();
      const wanted = pages && pages.length ? pages : Array.from({ length: total }, (_, i) => i + 1);
      if (wanted.length > MAX_PAGES) {
        throw new Error(`一次最多渲染 ${MAX_PAGES} 页（收到 ${wanted.length} 页）。分几次调用。`);
      }
      const outOfRange = wanted.filter((n) => !Number.isInteger(n) || n < 1 || n > total);
      if (outOfRange.length) {
        throw new Error(`页码超出范围：${outOfRange.join('、')}（本文档共 ${total} 页，页码从 1 开始）。`);
      }
      for (const n of wanted) {
        const page = doc.getPage(n - 1);
        const img = await page.render({
          scale,
          colorSpace: 'BGRA',
          render: async (o) => encodePng(o.data, o.width, o.height),
        });
        const file = uniquePath(outDir, `${base}-p${n}`, '.png');
        fs.writeFileSync(file, Buffer.from(img.data));
        written.push({ page: n, file, width: img.width, height: img.height });
      }
      return { total, written };
    } finally {
      doc.destroy();
    }
  } finally {
    library.destroy();
  }
}

// ---- 工具 ----

const validateDocument = {
  alias: 'validate_document',
  module: 'office',
  risk: 'low',
  writes: false,
  description:
    'Check whether an Office document (doc/docx/xls/xlsx/ppt/pptx) can be opened cleanly, by having the real LibreOffice engine actually convert it. Also reports font families the document declares but the system lacks. Read-only: nothing is written into the working directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Document path, relative to the working directory.',
      },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const rel = String(args.path || '').trim();
    if (!rel) return { text: '缺少 path 参数。', isError: true };
    let abs;
    try {
      abs = resolveIn(ctx.workingDir, rel);
    } catch (e) {
      return { text: e.message, isError: true };
    }
    const bad = precheck(abs, rel);
    if (bad) return { text: bad, isError: true };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-office-'));
    const out = path.join(tmp, 'probe.pdf');
    const started = Date.now();
    try {
      const c = await getConverter();
      const r = await c.render({ inputPath: abs, outputPath: out });
      const ms = Date.now() - started;
      let pdfBytes = 0;
      try {
        pdfBytes = fs.statSync(out).size;
      } catch {
        /* 引擎没产出就不用报大小 */
      }
      return {
        text:
          `${rel}：可以干净打开。\n` +
          `引擎：${r.backend}　耗时：${ms} ms　转换出 PDF ${(pdfBytes / 1024).toFixed(1)} KB` +
          fontNote(r.missingFonts),
        isError: false,
      };
    } catch (e) {
      return { text: `${rel}：打不开。\n${explainConversionError(e)}`, isError: true };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
};

const renderDocument = {
  alias: 'render_document',
  module: 'office',
  risk: 'low',
  writes: true,
  description:
    'Convert an Office document (doc/docx/xls/xlsx/ppt/pptx) to PDF with the real LibreOffice engine, and optionally rasterize selected pages to PNG so a human can inspect layout. Never overwrites: an existing name gets a -1/-2 suffix. Note the model itself cannot view images — the PNGs are for the user.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Document path, relative to the working directory.' },
      pages: {
        type: 'array',
        items: { type: 'number' },
        description: `Optional 1-based page numbers to rasterize as PNG, at most ${MAX_PAGES}. Omit to get the PDF only.`,
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Rasterization resolution. low=72dpi (layout), medium=144dpi (default), high=216dpi (small text).',
      },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const rel = String(args.path || '').trim();
    if (!rel) return { text: '缺少 path 参数。', isError: true };
    let abs;
    try {
      abs = resolveIn(ctx.workingDir, rel);
    } catch (e) {
      return { text: e.message, isError: true };
    }
    const bad = precheck(abs, rel);
    if (bad) return { text: bad, isError: true };

    const quality = String(args.quality || 'medium').toLowerCase();
    const scale = QUALITY_SCALE[quality];
    if (!scale) return { text: `quality 只能是 low / medium / high，收到 ${args.quality}。`, isError: true };
    // 页码上限在转换前就挡住：等 PDF 转完再报错，会在工作目录里留下一个用不上的孤儿 PDF。
    const wantPages = Array.isArray(args.pages) ? args.pages : [];
    if (wantPages.length > MAX_PAGES) {
      return { text: `pages 一次最多 ${MAX_PAGES} 页（收到 ${wantPages.length} 页）。分几次调用。`, isError: true };
    }

    const outDir = path.dirname(abs);
    const base = path.basename(abs, path.extname(abs));
    const pdfPath = uniquePath(outDir, base, '.pdf');
    const started = Date.now();

    try {
      const c = await getConverter();
      const r = await c.render({ inputPath: abs, outputPath: pdfPath });
      const ms = Date.now() - started;
      const pdfBytes = fs.statSync(pdfPath).size;
      const relPdf = toRel(ctx.workingDir, pdfPath);

      const lines = [
        `已转换：${rel} → ${relPdf}`,
        `引擎：${r.backend}　耗时：${ms} ms　PDF ${(pdfBytes / 1024).toFixed(1)} KB`,
      ];

      if (wantPages.length) {
        try {
          const buf = fs.readFileSync(pdfPath);
          const { total, written } = await rasterize(buf, wantPages, scale, outDir, base);
          lines.push(`文档共 ${total} 页，已光栅化 ${written.length} 页（${quality} / ${scale}x）：`);
          for (const w of written) {
            lines.push(`  第 ${w.page} 页 → ${toRel(ctx.workingDir, w.file)}（${w.width}×${w.height}）`);
          }
          lines.push('这些图是给人看的：模型看不到图片内容，不要声称「我看了版式」。');
        } catch (e) {
          // 转换已经成功，PDF 是真的产出了。把这一步单独报出来，不谎报成「转换失败」。
          lines.push(`但光栅化失败：${e.message}`);
          lines.push('PDF 已生成、可以正常使用；要图的话先解决上面这个原因再重试。');
          return { text: lines.join('\n') + fontNote(r.missingFonts), isError: true };
        }
      }

      const note = fontNote(r.missingFonts);
      return { text: lines.join('\n') + note, isError: false };
    } catch (e) {
      return { text: `${rel}：转换失败。\n${explainConversionError(e)}`, isError: true };
    }
  },
};

// 引擎不在就一个工具都不注册。
const tools = engineUsable() ? [validateDocument, renderDocument] : [];

module.exports = { tools, engineUsable };
