'use strict';
// 技能库：SKILL.md（带 frontmatter）分两层 —— intro 常驻正文，outro 按需索引

const fs = require('fs');
const path = require('path');
const store = require('../store');

// 目录约定就是技能与程序之间的全部契约：程序只认 intro / outro 两个目录名，
// 不认识任何具体技能。放进 intro = 正文常驻系统提示；放进 outro = 只进索引
// （名字 + 一句话描述），模型判断相关后自己 read_skill 读全文。
function skillSources() {
  // APP_ROOT/skills = 随程序分发的只读技能（打包后在 app.asar 内，Electron 可透明读取），天然属于 intro
  // DATA_DIR/skills/intro = 用户放入的规范类技能
  // DATA_DIR/skills/outro = 用户放入的按需技能
  // DATA_DIR/skills/<name> = 未分类的历史布局，按 outro 处理
  // source 只用于界面区分"随包 / 你自己放的"，不参与加载逻辑。
  return [
    // 随包技能的规范布局：skills/intro（正文常驻）/ skills/outro（只进索引）
    // —— 官方自带的技能就该走这里：随包走、任何数据目录都看得到、换版本不用再拷一遍。
    { dir: path.join(store.APP_ROOT, 'skills', 'intro'), tier: 'intro', source: 'builtin' },
    { dir: path.join(store.APP_ROOT, 'skills', 'outro'), tier: 'outro', source: 'builtin' },
    // 兼容最早的老布局：直接摊在 skills/ 下面的一律当常驻（chinese-report 那批原本就在这儿）
    { dir: path.join(store.APP_ROOT, 'skills'), tier: 'intro', source: 'builtin' },
    { dir: path.join(store.DATA_DIR, 'skills', 'intro'), tier: 'intro', source: 'user' },
    { dir: path.join(store.DATA_DIR, 'skills', 'outro'), tier: 'outro', source: 'user' },
    { dir: path.join(store.DATA_DIR, 'skills'), tier: 'outro', source: 'user' },
  ];
}

function parseFrontmatter(text) {
  const m = String(text || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!m) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: String(text || '').slice(m[0].length) };
}

function listSkills() {
  const out = [];
  const seen = new Set();
  for (const src of skillSources()) {
    if (!fs.existsSync(src.dir)) continue;
    for (const name of fs.readdirSync(src.dir)) {
      const file = path.join(src.dir, name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      let parsed;
      try {
        parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const key = String(parsed.meta.name || name).toLowerCase();
      if (seen.has(key)) continue; // 先扫到的优先：内置技能不会被用户同名技能顶掉
      seen.add(key);
      out.push({
        name: parsed.meta.name || name,
        displayName: parsed.meta['display-name'] || parsed.meta.displayName || name,
        description: parsed.meta.description || '',
        userInvocable: parsed.meta['user-invocable'] !== 'false',
        tier: src.tier,
        source: src.source || 'user',
        path: file,
        dir: path.dirname(file),
      });
    }
  }
  return out;
}

function findSkill(name) {
  const key = String(name || '').toLowerCase();
  return listSkills().find((s) => s.name.toLowerCase() === key || path.basename(path.dirname(s.path)).toLowerCase() === key) || null;
}

// intro 层常驻正文的总预算（字符）。超出预算的技能自动降级为"只留标题 + 提示"，
// 避免技能库自己把上下文吃光。
const INTRO_MAX_CHARS = 24000;

// 注入系统提示的常驻正文（intro 层全文）
function introText() {
  const list = listSkills().filter((s) => s.tier === 'intro');
  if (!list.length) return null;
  const parts = [];
  let used = 0;
  for (const s of list) {
    let body = '';
    try {
      body = parseFrontmatter(fs.readFileSync(s.path, 'utf8')).body.trim();
    } catch {
      continue;
    }
    if (!body) continue;
    const head = `## ${s.name}`;
    if (used + body.length > INTRO_MAX_CHARS) {
      parts.push(`${head}\n(本条超出常驻预算，需要时用 read_skill 读取全文)`);
      continue;
    }
    used += body.length;
    parts.push(`${head}\n${body}`);
  }
  if (!parts.length) return null;
  return (
    '# Skills — always loaded\n' +
    '以下规范已常驻，直接遵守，不必再 read_skill。\n\n' +
    parts.join('\n\n')
  );
}

// 注入系统提示的索引（outro 层：只有名字 + 一句话描述）
function skillsIndex() {
  const all = listSkills().filter((s) => s.tier === 'outro');
  if (!all.length) return null;
  return (
    '# Skills — on demand\n' +
    'Reusable procedures are stored as skills. When a task matches one, call read_skill to load its full instructions before working.\n' +
    all.map((s) => `- ${s.name}: ${s.description || '(无描述)'}`).join('\n')
  );
}

// 系统提示里技能相关内容的全部 = 常驻正文 + 按需索引
function systemSuffix() {
  return [introText(), skillsIndex()].filter(Boolean).join('\n\n') || null;
}

const listSkillsTool = {
  alias: 'list_skills',
  module: 'skills',
  risk: 'low',
  writes: false,
  description: 'List the available skills (reusable procedures) with their names and descriptions.',
  parameters: { type: 'object', properties: {}, required: [] },
  async run() {
    const all = listSkills();
    if (!all.length) return '当前没有任何技能。可以在「技能」面板里新建一个。';
    return all
      .map((s) => `- ${s.name}（${s.displayName}）[${s.tier === 'intro' ? '已常驻' : '按需'}]：${s.description || '(无描述)'}\n  路径：${s.path}`)
      .join('\n');
  },
};

const readSkillTool = {
  alias: 'read_skill',
  module: 'skills',
  risk: 'low',
  writes: false,
  description: 'Load the full instructions of a skill by name. Read it before doing a task the skill covers.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name' } },
    required: ['name'],
  },
  async run(args) {
    const skill = findSkill(args && args.name);
    if (!skill) {
      const all = listSkills().map((s) => s.name).join(', ') || '(无)';
      return { text: `找不到技能 "${args && args.name}"。可用技能：${all}`, isError: true };
    }
    const text = fs.readFileSync(skill.path, 'utf8');
    return text.length > 40000 ? text.slice(0, 40000) + '\n…[技能内容被截断]' : text;
  },
};

module.exports = { tools: [listSkillsTool, readSkillTool], listSkills, findSkill, skillsIndex, introText, systemSuffix, parseFrontmatter, skillSources };
