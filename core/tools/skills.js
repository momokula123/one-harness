'use strict';
// 技能库：SKILL.md（带 frontmatter）按需加载，避免把长文档常驻上下文

const fs = require('fs');
const path = require('path');
const store = require('../store');

function skillDirs() {
  // APP_ROOT = 随程序分发的只读技能（打包后在 app.asar 内，Electron 可透明读取）
  // DATA_DIR/skills = 用户自己的技能，绿色版里就在 exe 旁边，可增删改
  return [path.join(store.APP_ROOT, 'skills'), path.join(store.DATA_DIR, 'skills')];
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
  for (const dir of skillDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      let parsed;
      try {
        parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      out.push({
        name: parsed.meta.name || name,
        displayName: parsed.meta['display-name'] || parsed.meta.displayName || name,
        description: parsed.meta.description || '',
        userInvocable: parsed.meta['user-invocable'] !== 'false',
        path: file,
        dir,
      });
    }
  }
  return out;
}

function findSkill(name) {
  const key = String(name || '').toLowerCase();
  return listSkills().find((s) => s.name.toLowerCase() === key || path.basename(path.dirname(s.path)).toLowerCase() === key) || null;
}

// 注入系统提示的索引（只有名字 + 一句话描述）
function skillsIndex() {
  const all = listSkills();
  if (!all.length) return null;
  return (
    '# Skills\n' +
    'Reusable procedures are stored as skills. When a task matches one, call read_skill to load its full instructions before working.\n' +
    all.map((s) => `- ${s.name}: ${s.description || '(无描述)'}`).join('\n')
  );
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
    return all.map((s) => `- ${s.name}（${s.displayName}）：${s.description || '(无描述)'}\n  路径：${s.path}`).join('\n');
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

module.exports = { tools: [listSkillsTool, readSkillTool], listSkills, findSkill, skillsIndex, parseFrontmatter, skillDirs };
