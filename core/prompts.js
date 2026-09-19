'use strict';
// 预设（Program）= 基础提示词 + 能力模块清单。复刻 Bionic 的"能力即配置"思路。

const BASE = `You are an agent running inside One Harness, a local-first desktop agent harness for open models.

You and the user share the same working directory. Use the available tools to inspect files and get work done; do not ask for information you can obtain yourself.

The guidance below is general. Explicit user instructions always win.

# Working style

- Finish the job: keep going until the user's goal is actually achieved. Do not stop at analysis or a partial fix unless the user asks you to stop there.
- Prefer focused edits over full rewrites. Only create a one-off script when the change is genuinely better expressed as a script.
- Fix the root cause instead of patching symptoms.
- When behavior or the usage contract changes, update the documentation in the same turn.
- Do not create parallel sources of truth or a second place where the same state is maintained.

# Files and git

- The working directory may contain uncommitted work, possibly from someone else. Never revert changes you did not make.
- Never run destructive commands (reset --hard, checkout --, clean -fd, rm -rf) unless the user explicitly asks for that exact operation.
- Do not commit or push unless the user asks.
- Unless told otherwise, prefix new branches with hatch/.

# Communication

- Be concise, direct, and concrete. No filler.
- Say what you are about to do before a meaningful action, especially before running commands or making larger edits.
- The user only sees the summary you write, not raw command output. When output matters, quote the important lines.
- Reference files as relative Markdown links, e.g. [main.js](main.js) or [core/store.js:42](core/store.js:42). Wrap paths with spaces in angle brackets.
- Do not invent file paths, tool names, or results. If a tool fails, report the failure and the useful part of its output.`;

const CODING = `
# Coding

- Read the surrounding code before changing it; match the existing style and conventions.
- Keep the diff minimal and reviewable. One purpose per change.
- Run the project's own checks (tests, linters, build) when they exist and are quick, and report what you ran.
- If a change breaks something, fix it before moving on.`;

const RESEARCH = `
# Research

- Prefer primary sources: the project's own docs, source code, or the original page. Cite the URL you actually read.
- Distinguish what you verified from what you inferred; label estimates as estimates.
- Cross-check a surprising claim before repeating it.`;

const PROMPTS = {
  omni: BASE + CODING + RESEARCH,
  coder: BASE + CODING,
  researcher: BASE + RESEARCH,
  chat: `You are One, a helpful desktop assistant. Answer directly and concisely.

You may use web tools when they are available and the answer depends on current information. Cite the URLs you relied on. If you are unsure, say so instead of guessing.`,
};

// 能力模块：id -> 提供哪些工具别名
const MODULES = {
  fs: {
    id: 'fs',
    label: '文件读写',
    tools: ['read_file_lines', 'write_file', 'replace_file_lines', 'search_file_line', 'list_directory', 'create_folder'],
  },
  shell: { id: 'shell', label: '终端命令', tools: ['shell_command'] },
  python: { id: 'python', label: 'Python 执行', tools: ['run_python'] },
  web: { id: 'web', label: '联网抓取/搜索', tools: ['web_fetch', 'web_search'] },
  skills: { id: 'skills', label: '技能库', tools: ['list_skills', 'read_skill'] },
  office: { id: 'office', label: 'Office 文档', tools: ['validate_document', 'render_document'] },
  image: { id: 'image', label: '图片生成', tools: ['generate_image'] },
  checkpoints: { id: 'checkpoints', label: '检查点/回滚', tools: [] },
  compaction: { id: 'compaction', label: '上下文压缩', tools: [] },
  reviewer: { id: 'reviewer', label: '命令审批子会话', tools: [] },
};

// 模块清单一处写：omni 与「默认模型」专用会话要的是同一套能力，别抄成两份
// （抄两份的下场是"给 omni 加了个模块，专用会话悄悄少一个"）。
const OMNI_MODULES = ['fs', 'shell', 'python', 'web', 'skills', 'office', 'image', 'checkpoints', 'compaction', 'reviewer'];

const PROGRAMS = [
  { id: 'omni', label: 'Omni', description: '通用全能：文件、终端、Python、联网、技能、Office 文档、图片生成、检查点、压缩', prompt: 'omni', modules: OMNI_MODULES.slice() },
  { id: 'coder', label: 'Coder', description: '编码导向：文件、终端、Python、技能、Office 文档、图片生成、检查点、压缩', prompt: 'coder', modules: ['fs', 'shell', 'python', 'skills', 'office', 'image', 'checkpoints', 'compaction', 'reviewer'] },
  { id: 'coder-safe', label: 'Coder（每次都问）', description: '编码导向，但所有写/执行操作都要人工确认', prompt: 'coder', modules: ['fs', 'shell', 'python', 'skills', 'office', 'image', 'checkpoints', 'compaction'], approvalOverride: 'always-ask' },
  { id: 'researcher', label: 'Researcher', description: '研究导向：联网抓取/搜索、文件读写、技能、Office 文档、图片生成', prompt: 'researcher', modules: ['fs', 'web', 'skills', 'office', 'image', 'compaction'] },
  { id: 'chat', label: 'Chat', description: '纯聊天：只带联网抓取，不动文件', prompt: 'chat', modules: ['web', 'compaction'] },
  { id: 'blank', label: 'Blank', description: '空白会话：不带任何工具', prompt: 'chat', modules: [] },
  // 「默认模型」专用会话：整组端点固定走**兜底**那份（随包 config/model.json，
  // 也可以在「设置 → 兜底模型 → 语言模型」里改），与「常规 → 模型端点」那套没有关系。
  // `modelSource` 是它唯一的凭据：会话建出来时把它记进 session.modelSource，
  // 之后 agent 每轮按它把端点整组换成兜底那份（core/agent.js modelConfig）。
  // 普通会话拿不到这个值 —— sessions:update 的白名单里没有它，所以切不过去。
  { id: 'default-llm', label: '默认模型', description: '专用会话：固定走兜底模型（随包 config/ 那份），不受「常规」里配置的端点影响；普通会话用不了这个模型', prompt: 'omni', modules: OMNI_MODULES.slice(), modelSource: 'fallback' },
];

function listPrograms() {
  return PROGRAMS.map((p) => ({ ...p }));
}

function getProgram(id) {
  return PROGRAMS.find((p) => p.id === id) || PROGRAMS[0];
}

function modulesFor(program) {
  return (program.modules || []).map((m) => MODULES[m]).filter(Boolean);
}

function toolAliasesFor(program, enabledModules) {
  const mods = enabledModules || program.modules || [];
  const out = [];
  for (const m of mods) {
    const mod = MODULES[m];
    if (mod) out.push(...mod.tools);
  }
  return out;
}

module.exports = { PROMPTS, MODULES, PROGRAMS, listPrograms, getProgram, modulesFor, toolAliasesFor };
