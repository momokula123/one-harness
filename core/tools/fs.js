'use strict';
// 文件系统工具。所有路径都限制在会话工作目录内（越界直接报错，不偷偷放行）。

const fs = require('fs');
const path = require('path');

const MAX_READ_LINES = 500;
const MAX_OUTPUT_CHARS = 60000;

function resolveIn(root, target) {
  const abs = path.resolve(root, target || '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界：${target} 不在工作目录内（${root}）。如需访问工作目录以外的位置，请让用户调整工作目录。`);
  }
  return abs;
}

function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function clip(s) {
  const str = String(s ?? '');
  if (str.length <= MAX_OUTPUT_CHARS) return str;
  return str.slice(0, MAX_OUTPUT_CHARS) + `\n…[输出被截断，共 ${str.length} 字符]`;
}

function readLinesSafe(file) {
  const buf = fs.readFileSync(file);
  return buf.toString('utf8').split(/\r?\n/);
}

function fmt(startLine, lines) {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => String(startLine + i).padStart(width, ' ') + ' | ' + l).join('\n');
}

const readFileLines = {
  alias: 'read_file_lines',
  module: 'fs',
  risk: 'low',
  writes: false,
  description:
    'Read a text file from the working directory with line numbers. Always read before editing so you can reference exact line numbers.',
  parameters: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', description: 'Path relative to the working directory' },
      startLine: { type: 'integer', description: 'First line to read, 1-based. Default 1.' },
      endLine: { type: 'integer', description: 'Last line to read, inclusive. Default = startLine + 400.' },
    },
    required: ['relativePath'],
  },
  async run(args, ctx) {
    const root = ctx.workingDir;
    const file = resolveIn(root, args.relativePath);
    if (!fs.existsSync(file)) return `文件不存在：${args.relativePath}`;
    const st = fs.statSync(file);
    if (st.isDirectory()) return `${args.relativePath} 是目录，请用 list_directory。`;
    const all = readLinesSafe(file);
    const start = Math.max(1, Number(args.startLine) || 1);
    const end = Math.min(all.length, Number(args.endLine) || start + 400);
    const slice = all.slice(start - 1, Math.min(end, start - 1 + MAX_READ_LINES));
    const head = `${toRel(root, file)} 共 ${all.length} 行，显示 ${start}-${start + slice.length - 1}：\n`;
    return clip(head + fmt(start, slice));
  },
};

const listDirectory = {
  alias: 'list_directory',
  module: 'fs',
  risk: 'low',
  writes: false,
  description: 'List files and folders in a directory of the working directory.',
  parameters: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', description: 'Directory relative to the working directory. Default "."' },
      depth: { type: 'integer', description: 'Recursion depth, 1-3. Default 1.' },
    },
    required: [],
  },
  async run(args, ctx) {
    const root = ctx.workingDir;
    const dir = resolveIn(root, args.relativePath || '.');
    if (!fs.existsSync(dir)) return `目录不存在：${args.relativePath || '.'}`;
    const depth = Math.min(3, Math.max(1, Number(args.depth) || 1));
    const out = [];
    const ignored = new Set(['node_modules', '.git', '.npm-cache', '__pycache__', '.venv']);
    const walk = (d, level) => {
      let entries = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch (e) {
        out.push(`${toRel(root, d)} [读取失败: ${e.message}]`);
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (ignored.has(e.name)) continue;
        const abs = path.join(d, e.name);
        const rel = toRel(root, abs);
        if (e.isDirectory()) {
          out.push(rel + '/');
          if (level < depth) walk(abs, level + 1);
        } else {
          let size = 0;
          try { size = fs.statSync(abs).size; } catch {}
          out.push(`${rel}  (${size} B)`);
        }
        if (out.length > 800) return;
      }
    };
    walk(dir, 1);
    const body = out.length > 800 ? out.slice(0, 800).join('\n') + '\n…[结果过多已截断]' : out.join('\n');
    return clip(body || '(空目录)');
  },
};

const writeFile = {
  alias: 'write_file',
  module: 'fs',
  risk: 'medium',
  writes: true,
  description: 'Create a new file or fully rewrite an existing file. Prefer replace_file_lines for focused edits.',
  parameters: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', description: 'Path relative to the working directory' },
      content: { type: 'string', description: 'Full file content' },
      append: { type: 'boolean', description: 'Append instead of overwrite. Default false.' },
    },
    required: ['relativePath', 'content'],
  },
  async run(args, ctx) {
    const root = ctx.workingDir;
    const file = resolveIn(root, args.relativePath);
    if (ctx.session.readOnly) return '当前会话是只读的，无法写入文件。';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    ctx.snapshot(file); // 新文件也会记一条 absent 记录，方便回滚时删掉
    if (args.append) fs.appendFileSync(file, args.content, 'utf8');
    else fs.writeFileSync(file, args.content, 'utf8');
    const lines = String(args.content).split('\n').length;
    return `${existed ? '已更新' : '已创建'} ${args.relativePath}（${lines} 行，${Buffer.byteLength(args.content, 'utf8')} 字节）`;
  },
};

const replaceFileLines = {
  alias: 'replace_file_lines',
  module: 'fs',
  risk: 'medium',
  writes: true,
  description:
    'Replace an inclusive line range [startLine, endLine] of a file with the given lines. Use endLine = startLine - 1 to insert without deleting. Read the file first.',
  parameters: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', description: 'Path relative to the working directory' },
      startLine: { type: 'integer', description: 'First line to replace, 1-based' },
      endLine: { type: 'integer', description: 'Last line to replace, inclusive. Use startLine - 1 for pure insertion.' },
      lines: { type: 'array', items: { type: 'string' }, description: 'Replacement lines (no trailing newlines)' },
    },
    required: ['relativePath', 'startLine', 'endLine', 'lines'],
  },
  async run(args, ctx) {
    const root = ctx.workingDir;
    const file = resolveIn(root, args.relativePath);
    if (ctx.session.readOnly) return '当前会话是只读的，无法修改文件。';
    if (!fs.existsSync(file)) return `文件不存在：${args.relativePath}`;
    const all = readLinesSafe(file);
    const start = Number(args.startLine);
    const end = Number(args.endLine);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'startLine / endLine 必须是数字。';
    if (start < 1 || start > all.length + 1) return `startLine=${start} 超出范围（文件共 ${all.length} 行）。`;
    if (end < start - 1) return `endLine=${end} 必须大于等于 startLine-1 (${start - 1})。`;
    if (end > all.length) return `endLine=${end} 超出范围（文件共 ${all.length} 行）。请重新 read_file_lines 确认。`;
    ctx.snapshot(file);
    const next = all.slice(0, start - 1).concat(args.lines.map((l) => String(l)), all.slice(end));
    const trailingNewline = /\r?\n$/.test(fs.readFileSync(file, 'utf8'));
    let out = next.join('\n');
    if (trailingNewline && !out.endsWith('\n')) out += '\n';
    fs.writeFileSync(file, out, 'utf8');
    const removed = Math.max(0, end - start + 1);
    return `已修改 ${args.relativePath}：第 ${start}-${end} 行（删除 ${removed} 行，写入 ${args.lines.length} 行）`;
  },
};

const searchFileLine = {
  alias: 'search_file_line',
  module: 'fs',
  risk: 'low',
  writes: false,
  description: 'Search text or a regular expression across files in the working directory. Returns matching lines with line numbers.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regular expression to search for' },
      glob: { type: 'string', description: 'Optional filename filter, e.g. "*.js" or "core"' },
      isRegex: { type: 'boolean', description: 'Treat pattern as a regular expression. Default false.' },
      maxResults: { type: 'integer', description: 'Max matches, default 60' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const root = ctx.workingDir;
    const max = Math.min(300, Number(args.maxResults) || 60);
    const re = args.isRegex ? new RegExp(args.pattern, 'i') : null;
    const needle = String(args.pattern);
    const glob = args.glob ? String(args.glob).replace(/^\*+/, '') : null;
    const hits = [];
    const skipDirs = new Set(['node_modules', '.git', '.npm-cache', '__pycache__', '.venv', 'dist', 'build']);
    const walk = (dir) => {
      if (hits.length >= max) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= max) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (skipDirs.has(e.name)) continue;
          walk(abs);
        } else {
          if (glob && !e.name.includes(glob)) continue;
          let st;
          try { st = fs.statSync(abs); } catch { continue; }
          if (st.size > 2 * 1024 * 1024) continue;
          let text;
          try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
          if (text.includes('\u0000')) continue;
          text.split(/\r?\n/).forEach((line, i) => {
            if (hits.length >= max) return;
            const hit = re ? re.test(line) : line.includes(needle);
            if (hit) hits.push(`${toRel(root, abs)}:${i + 1}: ${line.trim().slice(0, 240)}`);
          });
        }
      }
    };
    walk(root);
    if (!hits.length) return `未找到匹配 "${args.pattern}"${glob ? '（文件名含 ' + glob + '）' : ''}。`;
    return clip(hits.join('\n') + (hits.length >= max ? `\n…[已达上限 ${max} 条]` : ''));
  },
};

const createFolder = {
  alias: 'create_folder',
  module: 'fs',
  risk: 'low',
  writes: true,
  description: 'Create a folder (and parents) inside the working directory.',
  parameters: {
    type: 'object',
    properties: { relativePath: { type: 'string', description: 'Folder path relative to the working directory' } },
    required: ['relativePath'],
  },
  async run(args, ctx) {
    const root = ctx.workingDir;
    const dir = resolveIn(root, args.relativePath);
    if (ctx.session.readOnly) return '当前会话是只读的。';
    if (fs.existsSync(dir)) return `目录已存在：${args.relativePath}`;
    fs.mkdirSync(dir, { recursive: true });
    return `已创建目录 ${args.relativePath}`;
  },
};

module.exports = { tools: [readFileLines, listDirectory, writeFile, replaceFileLines, searchFileLine, createFolder], resolveIn, toRel, clip };
