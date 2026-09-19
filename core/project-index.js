'use strict';
// 工程索引的**打包与合并** —— 索引就是 data/projects.json 里那几行（id / 工程名 / 工作目录 / 创建时间）。
//
// 纯逻辑：不 require fs、不 require electron。于是它能在 smoke 里直接单测，
// 宿主（main.js）只剩两件没法单测的事：弹对话框选文件、调 store 读写盘。
//
// 索引就是**指针**：会话正文不在里面，它在**工程文件夹**自己下面
// （<工程文件夹>/.one-harness/sessions/），跟着文件夹走、跟着用户走。
// 所以"导入索引"这件事的语义很轻 —— 把指针接回来就行：
//   文件夹还在本机 → 工程和它的对话立刻都在（对话本来就在那个文件夹里）；
//   文件夹不在本机 → 这一条只是个指向空处的指针，导入结果会照实说出来。

const KIND = 'one-harness/project-index';
const VERSION = 1;

/**
 * 规范化一条工程记录 —— 只保留索引自己的字段。
 * 这一步是**导入方向的唯一入口**：备份文件里可能有额外信息（比如导出时附带的
 * 会话条数，那是给人看的），绝不原样写回 projects.json，否则索引会被外来字段污染。
 * id 缺失视为无效记录（索引靠 id 认工程），由调用方计入 skipped。
 * ★ `self` 是**索引自己的字段**，必须留着：它标记"这个工程用程序自建的 workspace"，
 * 丢了之后老记录就只剩一条绝对路径 —— 换台机器（用户拿这份索引去别的电脑导入）
 * 那条路径就指着上一台机器的盘。store 那边虽有"按路径形状兜底"，但那只是兼容下限，
 * 不该把导出/导入当漏斗把它过一次滤。
 */
function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id == null ? '' : raw.id).trim();
  if (!id) return null;
  const name = String(raw.name == null ? '' : raw.name).trim() || '未命名项目';
  const cwd = raw.cwd == null || raw.cwd === '' ? null : String(raw.cwd);
  const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now();
  const out = { id, name, cwd, createdAt };
  if (raw.self === true) out.self = true;
  return out;
}

/**
 * 打包成备份文件的内容。meta.version = 导出的程序版本，只作记录（用来回答
 * "这份备份是哪个版本做的"），导入时不参与判断。
 */
function build(projects, meta) {
  const rows = (Array.isArray(projects) ? projects : []).map(normalizeProject).filter(Boolean);
  return {
    kind: KIND,
    version: VERSION,
    exportedAt: Date.now(),
    app: { name: 'One Harness', version: (meta && meta.version) || '' },
    count: rows.length,
    projects: rows,
  };
}

/**
 * 解析备份文件。能认三种形状，越宽松越好 —— 这是用户自己要导入的文件，
 * 卡在格式上没有任何收益：
 *   ① 本程序导出的 {kind, version, exportedAt, projects:[…]}
 *   ② 直接就是数组 [ {id,name,cwd,createdAt}, … ]
 *   ③ 手写的 {projects:[…]}（没有 kind）
 * 认得出 kind 但不等于本程序的 kind → 明确报错（别把别人的 json 当索引导进来）。
 */
function parse(text) {
  let obj;
  try {
    obj = JSON.parse(String(text));
  } catch (e) {
    return { ok: false, error: '这个文件不是合法的 JSON：' + String((e && e.message) || e) };
  }
  let list = null;
  let legacy = false;
  if (Array.isArray(obj)) {
    list = obj;
    legacy = true;
  } else if (obj && typeof obj === 'object') {
    if (obj.kind && obj.kind !== KIND) {
      return { ok: false, error: '这不是 One Harness 的工程索引（文件里写着 kind = ' + String(obj.kind) + '）' };
    }
    if (Array.isArray(obj.projects)) {
      list = obj.projects;
      legacy = !obj.kind;
    }
  }
  if (!list) return { ok: false, error: '文件里没有 projects 列表，看不出是工程索引' };
  const projects = list.map(normalizeProject).filter(Boolean);
  return {
    ok: true,
    projects,
    meta: {
      legacy,
      exportedAt: (obj && obj.exportedAt) || null,
      app: (obj && obj.app) || null,
      bundleVersion: (obj && obj.version) || null,
      declared: list.length,   // 文件里声称有几条
      usable: projects.length, // 其中能用的有几条（缺 id 的会被丢掉）
    },
  };
}

/**
 * 合并索引 —— **只增不减**：
 *   - 同 id 视为同一个工程 → 跳过（**不覆盖**已有的名字与工作目录：备份里的旧值
 *     盖掉本机的新值会静默丢改动，而"改名"这种改动用户根本不会先想到去备份）；
 *   - 本机有、备份里没有的工程 → 原样保留。
 * 去重只按 id：**同一个工作目录下开两个工程是合法的**（本机数据里就有一例），
 * 按 cwd 去重会把合法记录吃掉。
 * 不修改入参，返回新数组。
 */
function merge(existing, incoming) {
  const out = (Array.isArray(existing) ? existing : []).map(normalizeProject).filter(Boolean);
  const seen = new Set(out.map((p) => p.id));
  const addedIds = [];
  let skipped = 0;
  for (const raw of (Array.isArray(incoming) ? incoming : [])) {
    const p = normalizeProject(raw);
    if (!p || seen.has(p.id)) { skipped++; continue; }
    seen.add(p.id);
    out.push(p);
    addedIds.push(p.id);
  }
  return { projects: out, added: addedIds.length, skipped, addedIds };
}

// 保存对话框里用户把扩展名删掉了也认：补回 .json，否则导出的文件双击打不开
function ensureJsonExt(p) {
  const s = String(p == null ? '' : p);
  return /\.json$/i.test(s) ? s : s + '.json';
}

// 默认文件名：带本地时间到分钟，同一天导多次也不会在保存框里撞成同名
function defaultFileName(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return 'one-harness-projects-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
}

module.exports = { KIND, VERSION, normalizeProject, build, parse, merge, ensureJsonExt, defaultFileName };
