'use strict';
// 数据层：所有状态都落在应用目录内（自包含，搬走即用）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const projectIndex = require('./project-index');

// 打包成绿色版（electron-builder 默认把代码放进 app.asar）后，__dirname 落在 asar 内部 ——
// 那是只读的，而且用户根本看不到它。绿色版的要求是"整个文件夹拷到哪、数据就跟到哪"，
// 所以 packaged 时把根目录换成 exe 所在的文件夹（win-unpacked/One Harness.exe → win-unpacked/）。
// 开发态（npm start）保持 repo 根目录不变，现有的 data/、测试钩子一律不受影响。
const ROOT = (() => {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.dirname(app.getPath('exe'));
  } catch (_) { /* 纯 node 场景（测试/扫描脚本）没有 electron，忽略 */ }
  return path.resolve(__dirname, '..');
})();
// 代码自身的所在：开发态 = repo 根；打包后 = app.asar 内（Electron 能透明读 asar）。
// 随程序分发的只读资源（内置技能等）走这个，用户可见可写的东西一律走 ROOT。
const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.HATCH_DATA_DIR ? path.resolve(process.env.HATCH_DATA_DIR) : path.join(ROOT, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
// 程序在**工程文件夹里**落记录用的子目录：会话、检查点、临时文件都放它下面。
// 记录跟着工程文件夹走 —— 文件夹拷到哪、对话跟到哪；换一个程序版本打开同一个文件夹，
// 对话照样在，因为读的就是这个文件夹。程序数据目录里只留 projects.json 那张指针表。
// （以前记录放在 <数据目录>/projects/<工程 id>/ 下，等于把用户数据收到程序自己的目录里，
//  文件夹一换位置对话就"消失"了 —— 那是不对的。）
const RECORD_DIR = '.one-harness';
// 出厂端点配置读的是随包的 `config/*.json`，不是写死在代码里。两个文件：
//   · config/model.json —— **兜底** 语言模型端点（LLM 用哪个地址、哪把 key、哪个模型名）
//   · config/image.json —— **兜底** 生图端点（generate_image 工具打哪个地址）
// 每个名字都按两处找，谁先有谁算：
//   · ROOT/config/<name>.json      —— 打包后 ROOT = exe 所在目录（绿色版：改这里最顺手）
//   · APP_ROOT/config/<name>.json  —— 代码自带的那份（asar:false 时在 resources/app/ 下）
// 开发态这两个是同一个路径（repo 根），只会命中一个。
function factoryFiles(name) {
  return [path.join(ROOT, 'config', name + '.json'), path.join(APP_ROOT, 'config', name + '.json')];
}
const DEFAULT_MODEL_FILES = factoryFiles('model');
const DEFAULT_IMAGE_FILES = factoryFiles('image');

// 端点三件套 —— 判定、兜底、清空都以这个名单为准，别在别处再抄一遍。
const ENDPOINT_KEYS = ['baseUrl', 'apiKey', 'model'];

/**
 * 思考强度（reasoning_effort）的合法取值 —— **实测**自 agnes 网关，不是从文档或印象里抄的：
 * 故意发一个非法值，它把合法表原样回显了出来：
 *   literal['none','minimal','low','medium','high','xhigh','max']
 * 而且大小写敏感、必须是字符串（发 'NONE' 或数字 123 都是 400）—— 上游是 SGLang，
 * 照 OpenAI 那套 reasoning_effort 收的。因此这里只做"白名单校验"，**不做任何同义词翻译**：
 * 把 'off' 映射成 'none' 这类自作主张，一旦上游改口径就会变成必然 400 的请求。
 * 不在表里的值一律当"没设"（返回空串 = 不往请求里放这个字段），而不是原样发出去。
 */
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function normalizeReasoning(v) {
  const s = String(v == null ? '' : v).trim();
  return REASONING_LEVELS.includes(s) ? s : '';
}

const DEFAULT_SETTINGS = {
  // ⚠️ **用户自己正在用的模型**。它跟下面的 fallback 是两套独立的东西，不要互相写：
  //   · 这一组留空（baseUrl 或 model 没填）→ getSettings() 整体换成 fallback.llm；
  //   · 只要 baseUrl 与 model 都填了，就整个按这一组来 —— **一个字段都不去借兜底的**。
  // 为什么要"整套切"而不是"哪个字段空就补哪个"：地址和钥匙分属两家时补出来的组合
  // 等于把 A 家的 key 发到 B 家的地址上。这种组合不会报错、只会悄悄泄漏，不能靠用户自己发现。
  model: {
    baseUrl: '',
    apiKey: '',
    model: '',
    // 这个模型能不能吃图片输入。**只能手勾，探测不出来** —— 实测这类兼容端点的
    // /v1/models 只回 {id, object}，没有任何能力字段（OpenAI 规范里本来也没有）。
    // 默认 false：不发图永远不会错，勾错了代价是整轮 400（agent.js 会剥图重发并提示）。
    supportsVision: false,
    temperature: 0.3,
    maxTokens: -1,
    contextLength: 16384,      // 仅用于上下文占用估算
  },
  // 兜底端点：用户自己的模型没配时顶上，保证"程序永远有一个能说话的脑子"。
  // 它**只**在用户那一组没配时生效，所以用户改这里不会影响正在用的模型，
  // 反过来也一样 —— 这也正是"用兜底去配置 One Harness、却不会把程序自己配死"的前提。
  // 三个字段留空 = 用随包 config/*.json 里的出厂值（见 getSettings 的 fillEndpoint）。
  // contextLength / reasoning 是另外两项可选的（只有语言模型那份有）：
  // 前者决定"什么时候自动压缩"，后者决定"思考强度"（reasoning_effort）。
  // ⚠️ reasoning **只跟着兜底走**：用户自己那组端点永远不会带上它，
  // 所以在这里调思考强度，动不到用户正在跑的那套模型（见 getSettings 里那两行）。
  fallback: {
    llm: { baseUrl: '', apiKey: '', model: '', supportsVision: false, contextLength: '', reasoning: '' },
    image: { baseUrl: '', apiKey: '', model: '' },
  },
  agent: {
    maxSteps: 40,
    autoCompactRatio: 0.9375,
    requestTimeoutMs: 300000,
    streamIdleTimeoutMs: 180000,
  },
  approval: {
    mode: 'reviewer',          // auto | reviewer | always-ask
    reviewerModel: '',         // 空 = 跟主模型相同
    onReviewerFailure: 'ask',  // 评审调用失败/输出无法解析时：ask（转人工，失败安全）| allow（照常放行）
  },
  shell: {
    timeoutMs: 120000,
    shellPath: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
  },
  web: {
    searchEndpoint: '',        // 留空则关闭联网搜索；填 SearxNG 实例地址即可
    fetchTimeoutMs: 20000,
    maxChars: 20000,
  },
  ui: {
    theme: 'dark',
    inlineDiff: true,
  },
  skills: {
    // 默认分层：常驻（intro）全部直接启用 —— 全文进系统提示，前缀稳定 KV 缓存才命中；
    // 按需（outro）默认停用，用户启用后只进"一行索引"，模型判断相关再 read_skill 读全文。
    introDisabled: [],         // 用户手动停掉的常驻技能名（小写）
    outroEnabled: [],          // 用户手动启用的按需技能名（小写）
  },
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function init() {
  ensureDir(DATA_DIR);
  ensureDir(PROJECTS_DIR);
  if (!fs.existsSync(SETTINGS_FILE)) writeJsonAtomic(SETTINGS_FILE, DEFAULT_SETTINGS);
  if (!fs.existsSync(PROJECTS_FILE)) writeJsonAtomic(PROJECTS_FILE, { projects: [] });
  ensureDir(path.join(DATA_DIR, 'skills'));
  migrateSelfWorkspaces();
}

/**
 * 老记录补丁：把"自建 workspace"那几条标上 self、并把 cwd 改写成当前数据目录下的路径。
 * 起因：绿色版被拷到别的电脑后，老记录里的绝对路径还指着上一台机器的盘
 * （`...\data\projects\<id>\workspace`），程序就去那儿建目录 → EPERM → 启动失败。
 * 只动 projects.json 里这两处，别的一律不碰；没得改就不写盘。
 */
function migrateSelfWorkspaces() {
  const db = readJson(PROJECTS_FILE, { projects: [] });
  let changed = false;
  for (const p of db.projects || []) {
    if (!p || !p.id || !isSelfWorkspace(p)) continue;
    const now = path.join(PROJECTS_DIR, p.id, 'workspace');
    if (p.self !== true) { p.self = true; changed = true; }
    if (path.resolve(String(p.cwd || '')) !== path.resolve(now)) { p.cwd = now; changed = true; }
  }
  if (changed) writeJsonAtomic(PROJECTS_FILE, db);
}

/**
 * 出厂端点：读随包的 config/<name>.json（name = 'model' 语言模型 / 'image' 生图）。
 * 文件被删了、写坏了、或者压根没打包进去 —— 都不能让程序起不来，
 * 退回"全空"（= 让用户自己在设置里填），而不是抛错。
 * 只认 baseUrl / apiKey / model 三个字段；文件里那些 `_说明` 之类的注释键不参与。
 * contextLength 是可选的第 4 项：模型自带的上下文大小（只有语言模型那份会有）。
 * reasoning 是可选的第 5 项：思考强度，只认白名单里的字面值（同样只有语言模型那份会有）。
 */
function readFactory(name) {
  for (const f of factoryFiles(name)) {
    const c = readJson(f, null);
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const out = {};
      for (const k of ENDPOINT_KEYS) out[k] = String(c[k] || '').trim();
      const n = Number(c.contextLength);
      out.contextLength = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      out.reasoning = normalizeReasoning(c.reasoning);
      // models：这个端点**只让选哪些模型**（可选）。空数组 = 不限制（端点列出什么就全给）。
      // 只认字符串、去掉空白与空串；写成一个字符串（而不是数组）也算没写 —— 不猜。
      out.models = Array.isArray(c.models)
        ? c.models.map((m) => String(m || '').trim()).filter(Boolean)
        : [];
      return out;
    }
  }
  return { baseUrl: '', apiKey: '', model: '', contextLength: 0, reasoning: '', models: [] };
}

/**
 * 出厂端点"只让选哪些模型"的名单（配置里那个 models 数组）。
 * **默认只取语言模型那份**（config/model.json）：生图那份（config/image.json）是给
 * generate_image 用的，混进对话模型的候选列表里只会让人在下拉里看到一个
 * agnes-image-2.5-flash —— 它根本不支持对话，选了必然报错。
 * 空数组 = 不限制。**只作用于出厂这一份端点**：用户自己在「常规」里配了端点时，
 * 拉出来的列表一律不经过这里（他的端点有什么就该给什么）。
 */
function factoryAllowlist(name = 'model') {
  return (readFactory(name).models || []).slice();
}

// 0.1.10 时的名字（出厂默认端点就是语言模型那份），保留以免旧探针/脚本断掉。
function readDefaultModel() {
  return readFactory('model');
}

/** 用户填的优先，留空的字段用出厂值补 —— 只在"这一组整体启用"时才调用。 */
function fillEndpoint(saved, factory) {
  const out = {};
  for (const k of ENDPOINT_KEYS) out[k] = String((saved || {})[k] || '').trim() || factory[k];
  return out;
}

/**
 * 用户自己那一组端点填了没有。
 * 判据是 **baseUrl 与 model 都在** —— apiKey 不算数：本机 LM Studio / Ollama /
 * 以及用户自己那台 PCswitch 这类端点本来就不需要 key，要求填 key 等于逼人瞎填一个。
 * 反过来说：只要这两个在，就整体按用户填的来，**连 key 都不去借兜底的**
 * （借了就是把兜底那家的 key 发到用户这家的地址上）。
 */
function hasOwnEndpoint(model) {
  const m = model || {};
  return !!(String(m.baseUrl || '').trim() && String(m.model || '').trim());
}

/**
 * 把"生效端点"**整组**换成兜底那份 —— 给「默认模型」专用会话用。
 * 它和 getSettings 里"用户没配就整套走兜底"是**同一条规则的另一侧**：
 * 同样是整组切（地址、钥匙、模型名、上下文大小、思考强度一起换），不单个字段去借。
 * 之所以放在这个文件里：端点这套语义只有这一处实现，别处再抄一遍就会长出第二套口径
 * （最危险的那种是"地址用兜底、钥匙还用用户的"——不会报错，只会把钥匙发错地方）。
 * 返回新对象，不动传进来的那个；温度/maxTokens 这类不属于端点的照旧保留。
 */
function swapFallback(model, fallbackLlm) {
  const fb = fallbackLlm || {};
  const out = { ...(model || {}) };
  for (const k of ENDPOINT_KEYS) out[k] = String(fb[k] || '');
  out.contextLength = positiveOr(fb.contextLength, DEFAULT_SETTINGS.model.contextLength);
  out.reasoning = normalizeReasoning(fb.reasoning);
  return out;
}

/**
 * 某个会话实际打哪个端点 —— 就这一处判定。
 *   modelSource === 'fallback' → 整组换成兜底那份（「默认模型」专用会话）；
 *   否则                      → 生效设置里那套（用户配的，没配就兜底）。
 * 为什么必须只有一处：模型请求、自动压缩的阈值、界面上的上下文占用条，
 * 说的必须是**同一件事**。分开判的话迟早出现"按 A 估容量、拿 B 发请求"——
 * 要么压缩得太早（还有空间就砍上下文），要么太晚（撑爆，报的是难查的上下文溢出）。
 */
function endpointFor(settings, modelSource) {
  const s = settings || {};
  if (modelSource === 'fallback') return swapFallback(s.model, (s.fallback || {}).llm);
  return s.model || {};
}

/**
 * 生效设置 = 内置默认 ← settings.json，再把兜底端点解析出来。
 * 返回值里三组端点各有各的用途，别混用：
 *   · model      —— **正在用的**那套（用户填了就是他的，没填就是兜底那份）。发给模型请求的就是它。
 *                   其中的 `reasoning`（思考强度）**只在"正在用的 = 兜底"时才有值**；
 *                   用户自己那组一律是空串 —— 这就是"调兜底不动他的模型"的落点。
 *   · modelOwn   —— 用户自己填的原文（可能是空串）。设置界面「模型端点」那几个输入框绑它，
 *                   这样"没填"就显示为空、而不是显示成兜底值被顺手存回去。
 *   · fallback   —— 兜底端点（卡片里填的优先，留空则用随包 config/*.json），设置里的两张兜底卡片绑它。
 */
function getSettings() {
  const saved = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
  const fac = { llm: readFactory('model'), image: readFactory('image') };
  const fallback = {
    llm: fillEndpoint((saved.fallback || {}).llm, fac.llm),
    image: fillEndpoint((saved.fallback || {}).image, fac.image),
  };
  // 上下文大小：留空 → 用该端点自带的（agnes 那份写在 config/model.json 的 512K）；
  // 卡片里填了 → 以卡片为准。
  fallback.llm.contextLength = positiveOr(fallbackRaw('llm', 'contextLength'), fac.llm.contextLength) || DEFAULT_SETTINGS.model.contextLength;
  // 思考强度走同一条路：卡片填了以卡片为准，留空跟出厂值（config/model.json 里那句 reasoning）。
  fallback.llm.reasoning = normalizeReasoning(fallbackRaw('llm', 'reasoning')) || normalizeReasoning(fac.llm.reasoning);
  // 看图开关**两边各管各的**：常规的勾选只作用自己那套端点，兜底卡有独立勾选。
  // 出厂 config 也能声明（缺了当 false）。resolved model 用整组换（300 行），兜底的值自然盖过常规的。
  fallback.llm.supportsVision = typeof fallbackRaw('llm', 'supportsVision') === 'boolean'
    ? fallbackRaw('llm', 'supportsVision')
    : (typeof fac.llm.supportsVision === 'boolean' ? fac.llm.supportsVision : false);
  const own = { ...saved.model };
  const ownInUse = hasOwnEndpoint(own);
  // ⚠️ 用户那一组在用时，`reasoning` 被**显式清空** —— 思考强度只属于兜底那份端点。
  // 不这么写的话，settings.json 里万一留了个 reasoning 键，它就会被当成"用户自己配的"
  // 一并发出去，于是「在兜底卡片里调思考强度」就动到了他正在用的模型。那正是不能发生的事。
  const model = ownInUse ? { ...own, reasoning: '' } : { ...own, ...fallback.llm };
  // 上下文大小单独一条规则（它不是凭据，混着不会出事，所以不跟"整套切"走）：
  //   ① 常规里那个框被**显式改过**（≠ 内置默认）→ 永远按用户填的；
  //   ② 否则按"当前生效端点"自带的：走兜底 → 兜底那份（agnes = 512K）；
  //      自己的端点 → 保守的内置默认（**不能**拿兜底的 512K 去套别人的端点，
  //      真撑爆了是"上下文溢出"，比早压缩难查得多）。
  const ownCtx = Number(own.contextLength) > 0 ? Math.floor(Number(own.contextLength)) : 0;
  const explicit = ownCtx && ownCtx !== DEFAULT_SETTINGS.model.contextLength ? ownCtx : 0;
  model.contextLength = explicit || (ownInUse ? DEFAULT_SETTINGS.model.contextLength : fallback.llm.contextLength);
  return { ...saved, model, modelOwn: own, fallback };

  function fallbackRaw(which, key) {
    return ((saved.fallback || {})[which] || {})[key];
  }
}

/** 正数才认，别的（空串 / null / 负数 / 乱填）一律当"没设"。 */
function positiveOr(v, fallbackValue) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackValue;
}

/**
 * 存盘。**基于 settings.json 的原始内容合并**，而不是基于 getSettings() 的结果 ——
 * 后者带着 model / fallback 这两组"解析出来的"值，拿它当基底等于把兜底值写进用户那一组，
 * 下一轮判定就会以为"用户自己配过端点"。这正是不该发生的那种自我覆盖。
 * 兜底卡片里填的值若与出厂值一模一样，存空串（保留"留空 = 跟出厂走"的语义），
 * 否则改 config/*.json 会永远不生效，用户会觉得"我改了没用"。
 */
function saveSettings(patch) {
  const raw = readJson(SETTINGS_FILE, {});
  const base = deepMerge(DEFAULT_SETTINGS, raw);
  const next = deepMerge(base, stripDerived(patch));
  // 「Python 执行」工具已整体移除，settings.json 里可能还留着老键，顺手摘掉
  delete next.python;
  const factories = { llm: readFactory('model'), image: readFactory('image') };
  for (const which of ['llm', 'image']) {
    const f = factories[which];
    for (const k of ENDPOINT_KEYS) {
      if (String(next.fallback[which][k] || '').trim() === f[k]) next.fallback[which][k] = '';
    }
    // 上下文大小同理：填的就是出厂那个数 → 存空串，将来改 config 还能跟着走
    if (f.contextLength && Number(next.fallback[which].contextLength) === f.contextLength) {
      next.fallback[which].contextLength = '';
    }
    // 思考强度同理。先归一化再比：卡片里万一有 " high " 这种带空格的，别原样落盘。
    next.fallback[which].reasoning = normalizeReasoning(next.fallback[which].reasoning);
    if (f.reasoning && next.fallback[which].reasoning === f.reasoning) next.fallback[which].reasoning = '';
  }
  writeJsonAtomic(SETTINGS_FILE, next);
  return getSettings();
}

// 派生字段（读的时候算出来的，不是用户存过的）—— 万一被谁原样回传，落盘前摘掉，
// 免得它们在 settings.json 里安家、下一轮又变成"用户填的值"。
const DERIVED_KEYS = ['modelOwn'];
function stripDerived(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...patch };
  for (const k of DERIVED_KEYS) delete out[k];
  return out;
}

function newId() {
  return crypto.randomUUID();
}

function shortId(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8);
}

// ---- projects ----
function listProjects() {
  return readJson(PROJECTS_FILE, { projects: [] }).projects;
}

/**
 * 建工程 —— **先按地址查重**：同一个工程文件夹永远只对应一个工程。
 * 以前每个 id 各认各的，同一个文件夹被打开两次就是两个工程、两套记录
 * （本机数据里同一个 someidea 有三条、rmzmv1070 有四条），所以必须先认地址。
 * 没给地址（或给的目录不存在）时，在数据目录里给它一个自建 workspace 当工程文件夹。
 */
function createProject(name, cwd) {
  const want = cwd && String(cwd).trim() ? path.resolve(String(cwd)) : null;
  if (want && fs.existsSync(want)) {
    const same = listProjects().find((p) => p.cwd && path.resolve(p.cwd) === want);
    if (same) return same;
  }
  const id = newId();
  // 自建的 workspace 要打 self 标记：它的路径以后**现算**（跟着当前数据目录走），
  // 记录里那份绝对路径只当显示用 —— 否则绿色版一挪地方，它就指向上一台机器的盘。
  const self = !(want && fs.existsSync(want));
  const root = self ? path.join(PROJECTS_DIR, id, 'workspace') : want;
  ensureDir(root);
  const project = { id, name: name || '未命名项目', cwd: root, createdAt: Date.now() };
  if (self) project.self = true;
  const db = readJson(PROJECTS_FILE, { projects: [] });
  db.projects.push(project);
  writeJsonAtomic(PROJECTS_FILE, db);
  return project;
}

/**
 * 这个工程的文件夹是不是"程序自建的那个 workspace"（只有它才归程序自己管）。
 * 判据两条：
 *  1. 登记时打了 self 标记（新记录都有）；
 *  2. 路径**形状**正好是 <任意数据目录>/projects/<本工程 id>/workspace —— 老记录只有路径。
 * 为什么按形状判、不按 `path.join(PROJECTS_DIR, id, 'workspace')` 前缀比：
 * 绿色版被拷到别的盘/别的电脑之后，老记录里那个绝对路径的前缀**已经不是当前数据目录**了，
 * 前缀比会漏判 → 程序就会跑去别人的 C:\Users\... 里建目录（EPERM）。
 */
function isSelfWorkspace(p) {
  if (!p) return false;
  if (p.self === true) return true;
  if (!p.cwd) return false;
  const parts = String(p.cwd).split(/[\\/]+/).filter(Boolean);
  const n = parts.length;
  return (
    n >= 3 &&
    parts[n - 1].toLowerCase() === 'workspace' &&
    parts[n - 2].toLowerCase() === String(p.id || '').toLowerCase() &&
    parts[n - 3].toLowerCase() === 'projects'
  );
}

/** 工程文件夹 —— 用户自己的目录，也是记录的落脚点。读路径，不建目录。 */
function projectRoot(projectId) {
  const p = getProject(projectId);
  // 自建 workspace：**现算**，永远贴着当前数据目录 —— 记录里那份绝对路径只在老版本/老记录里
  if (p && isSelfWorkspace(p)) return path.join(PROJECTS_DIR, p.id, 'workspace');
  if (p && p.cwd) return p.cwd;
  // 索引里没有这一行、或那一行没有 cwd：退回它自建的 workspace
  return path.join(PROJECTS_DIR, projectId, 'workspace');
}

/** 程序为这个工程写下的记录目录：<工程文件夹>/.one-harness */
function projectDataDir(projectId) {
  return path.join(projectRoot(projectId), RECORD_DIR);
}

function getProject(projectId) {
  return listProjects().find((p) => p.id === projectId) || null;
}

function updateProject(projectId, patch) {
  const db = readJson(PROJECTS_FILE, { projects: [] });
  const i = db.projects.findIndex((p) => p.id === projectId);
  if (i < 0) return null;
  db.projects[i] = { ...db.projects[i], ...patch };
  writeJsonAtomic(PROJECTS_FILE, db);
  return db.projects[i];
}

/**
 * 删除项目 —— **只摘索引**：把这一条从 projects.json 里移除，别的一律不动。
 * 磁盘上的 <数据目录>/projects/<id>/（会话记录、检查点、自动创建的 workspace）与项目的
 * 工作目录都原样保留，所以这一步是可逆的：反悔了可以手工把这条记录写回去，
 * 想彻底清掉则手工删掉那个目录。语义与「删除会话只删会话记录」一致 ——
 * 只摘掉登记表上的一行，不动任何内容文件。
 * （工作目录尤其不能碰：用户选的是自己的目录，里面是用户的文件。）
 */
function deleteProject(projectId) {
  const db = readJson(PROJECTS_FILE, { projects: [] });
  const i = db.projects.findIndex((p) => p.id === projectId);
  if (i < 0) return false;
  db.projects.splice(i, 1);
  writeJsonAtomic(PROJECTS_FILE, db);
  return true;
}

/**
 * 删除前给界面写确认文案用的事实（只读，不删任何东西）：
 * 工程文件夹（用户自己的目录）、程序写下的记录目录、会话数，
 * 以及工作目录是不是程序自建的那个 workspace（只有那种才归程序自己管）。
 */
function projectDeleteInfo(projectId) {
  const p = getProject(projectId);
  if (!p) return null;
  let sessionCount = 0;
  try { sessionCount = listSessions(projectId).length; } catch (_) { sessionCount = 0; }
  return {
    id: p.id,
    name: p.name,
    cwd: p.cwd || null,
    root: p.cwd || null,
    recordDir: projectDataDir(projectId),
    sessionCount,
    selfWorkspace: isSelfWorkspace(p),
  };
}

// ---- 工程索引的导出 / 导入 ----
// 两件事都**只动 projects.json**：会话正文（projects/<id>/sessions/）与工作目录一律不碰。
// 判定逻辑（打包形状、合并规则）全在 core/project-index.js 里，这里只负责读写盘 ——
// 于是"导入会不会覆盖我的工程"这种问题能在单测里回答，不用起界面。
function writeProjects(list) {
  const out = Array.isArray(list) ? list : [];
  writeJsonAtomic(PROJECTS_FILE, { projects: out });
  return out;
}

function exportProjectIndex(destPath, meta) {
  const bundle = projectIndex.build(listProjects(), meta);
  writeJsonAtomic(destPath, bundle);
  return { path: destPath, count: bundle.projects.length, bytes: fs.statSync(destPath).size };
}

/**
 * 导入：解析 → 合并（只增不减，见 core/project-index.js 的 merge）→ 写回。
 * 索引导入只接回**指针**，所以要照实说两件事（都不代表出错，但用户得知道）：
 *   gone  = 指向的工程文件夹在本机不存在 —— 这条目前指不到东西（文件夹放回原处就恢复）；
 *   empty = 文件夹在、但里面还没有记录 —— 就是个空工程。
 * 会话正文本来就在工程文件夹里、跟着文件夹走，所以这里没有"搬正文"这回事。
 */
function importProjectIndex(srcPath) {
  let text;
  try {
    text = fs.readFileSync(srcPath, 'utf8');
  } catch (e) {
    return { ok: false, error: '读不到这个文件：' + String((e && e.message) || e) };
  }
  const parsed = projectIndex.parse(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const before = listProjects();
  const merged = projectIndex.merge(before, parsed.projects);
  if (merged.added) writeProjects(merged.projects);

  let gone = 0;
  let empty = 0;
  for (const id of merged.addedIds) {
    const p = getProject(id);
    if (!p || !p.cwd || !fs.existsSync(p.cwd)) { gone++; continue; }
    let n = 0;
    try { n = listSessions(id).length; } catch (_) { n = 0; }
    if (!n) empty++;
  }
  return {
    ok: true,
    path: srcPath,
    added: merged.added,
    skipped: merged.skipped,
    total: merged.projects.length,
    gone,
    empty,
    declared: parsed.meta.declared,
    // 文件里声称 N 条、实际能用的只有 M 条 → 差额是"缺 id 之类被忽略"的行数。
    // 单独报出来，免得手工整理过的清单里少了几条却没人发现（skipped 只说"已有"）。
    invalid: Math.max(0, parsed.meta.declared - merged.added - merged.skipped),
    legacy: parsed.meta.legacy,
  };
}

// ---- sessions ----
// 会话记录落在**工程文件夹**里：<工程文件夹>/.one-harness/sessions/<会话 id>.json。
// 读路径不建目录（ensureDir 只在写的时候调）—— 否则工程文件夹被删掉后，程序光看一眼列表
// 就会把它又"建"出来。
function sessionsDir(projectId) {
  return path.join(projectDataDir(projectId), 'sessions');
}

function sessionFile(projectId, sessionId) {
  return path.join(sessionsDir(projectId), sessionId + '.json');
}

function listSessions(projectId) {
  const dir = sessionsDir(projectId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean)
    .map((s) => ({
      id: s.id,
      name: s.name,
      programId: s.programId,
      updatedAt: s.updatedAt,
      entryCount: s.entries.length,
      parentSessionId: s.parentSessionId || null,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 会话的工作目录也要跟着工程走 —— 建会话那一刻的绝对路径被写死在记录里
 * （core/session.js 的 `workingDir`），绿色版换机器/换盘之后它就指着**上一台机器的盘**；
 * 而工具沙箱根（`core/tools/fs.js resolveIn`）、拖入落点（`files:attach`）、
 * 取缩略图像素（`files:preview`）全用它 → 一操作就是 EPERM。
 * 两条边界，别越：
 *  1. **只修"工程本身就是自建 workspace"的那种**（`isSelfWorkspace(p)`），且会话里那条
 *     路径形状确实是 `<某个数据目录>/projects/<本工程 id>/workspace` —— 用户自己选的目录
 *     一律不碰（那可能只是移动盘没插，改了等于替用户做决定）。
 *  2. **读的时候现算**：loadSession 改的是内存里那份，盘上的记录不动。它会**顺带**落盘
 *     （`sessions:update` 那种"读一份、改、存回去"的路径会把改好的值写进记录）——
 *     这是**想要的**：写回去的是当前这台机器的正确路径，等于把老记录顺手治好了；
 *     而"用户自己选的目录"永远不满足第 1 条，所以用户的选择不会被改掉。
 */
function fixSessionWorkingDir(projectId, s) {
  if (!s) return s;
  const p = getProject(projectId);
  if (!p || !isSelfWorkspace(p)) return s;
  if (!isSelfWorkspace({ id: projectId, cwd: s.workingDir })) return s;
  const now = path.join(PROJECTS_DIR, projectId, 'workspace');
  if (path.resolve(String(s.workingDir || '')) !== path.resolve(now)) s.workingDir = now;
  return s;
}

function loadSession(projectId, sessionId) {
  return fixSessionWorkingDir(projectId, readJson(sessionFile(projectId, sessionId), null));
}

/**
 * 一次性迁移：把所有会话记录里**冻结的模块清单**删掉（改成"跟程序预设实时走"，
 * 见 core/prompts.js resolveModules）。不删的话，升级带来的新模块永远到不了老会话，
 * 用户看到的就是"改个功能还得新建会话"。用户在能力模块里手动调过的自定义也会被
 * 一起清掉 —— 这是这次语义变更的代价（2026-09-20 拍板"全部删除"），调回来点一下就行。
 * 标记文件保证只跑一次：之后再点开的自定义不会被下次启动误删。
 */
function migrateUnfreezeModules() {
  const marker = path.join(DATA_DIR, 'migration-modules-unfrozen.flag');
  if (fs.existsSync(marker)) return 0;
  let stripped = 0;
  for (const p of listProjects()) {
    const dir = sessionsDir(p.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(dir, f);
      const rec = readJson(file, null);
      if (!rec || !Array.isArray(rec.modules)) continue;
      delete rec.modules;
      writeJsonAtomic(file, rec);
      stripped += 1;
    }
  }
  writeJsonAtomic(marker, { doneAt: new Date().toISOString(), stripped });
  return stripped;
}

function saveSession(projectId, session) {
  session.updatedAt = Date.now();
  ensureDir(sessionsDir(projectId));
  writeJsonAtomic(sessionFile(projectId, session.id), session);
  return session;
}

function copyFileIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

// 同名就往后加 -1 / -2 …，**永不覆盖**已有文件。
// 两处在用：office 工具的产物落盘（core/tools/office.js）、拖入的附件复制进工作目录（main.js）。
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

module.exports = {
  ROOT, APP_ROOT, DATA_DIR, PROJECTS_DIR, SETTINGS_FILE, DEFAULT_SETTINGS,
  init, ensureDir, readJson, writeJsonAtomic, deepMerge, getSettings, saveSettings,
  readDefaultModel, readFactory, factoryFiles, factoryAllowlist, fillEndpoint, hasOwnEndpoint, ENDPOINT_KEYS,
  swapFallback, endpointFor, REASONING_LEVELS, normalizeReasoning,
  DEFAULT_MODEL_FILES, DEFAULT_IMAGE_FILES,
  newId, shortId, listProjects, createProject, getProject, updateProject, deleteProject,
  uniquePath,
  projectDeleteInfo, projectRoot, projectDataDir, RECORD_DIR,
  writeProjects, exportProjectIndex, importProjectIndex,
  listSessions, loadSession, saveSession, sessionFile, copyFileIfExists,
  migrateUnfreezeModules,
};
