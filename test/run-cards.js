'use strict';
// 「设置 → 技能卡片」套件的跑分器：先自己铺好技能，再起界面跑 test/settings-cards.js。
//
// 为什么要单独一个跑分器：卡片是"技能库非空才渲染"的，而 run-ui.js 默认每次清空数据目录
// （那条默认值别改，别的套件靠它保证计数断言不受历史累积影响）。这里自己铺两份技能
// —— 一份放 intro（常驻）、一份放 outro（按需），于是两种 tier、两种来源（随包/自装）
// 都能被断言覆盖，且不依赖这台机器上装过什么技能。
//
// 跑法：node test/run-cards.js   （见 package.json 的 npm run test:cards）

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp-cards');
const DATA = path.join(TMP, 'data');
const REL_DATA = 'test/.tmp-cards/data';

fs.rmSync(TMP, { recursive: true, force: true });
const writeSkill = (tier, name, desc) => {
  const dir = path.join(DATA, 'skills', tier, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n这是 ${name} 的正文，写给探针看的。\n`, 'utf8');
};
writeSkill('intro', 'probe-intro-skill', '探针：常驻技能（正文进系统提示）');
writeSkill('outro', 'probe-outro-skill', '探针：按需技能（模型自己读全文）');
console.log('[run-cards] 技能已铺好：' + path.join(DATA, 'skills'));

const r = spawnSync(process.execPath, [path.join(__dirname, 'run-ui.js'), 'test/settings-cards.js'], {
  cwd: ROOT,
  env: { ...process.env, HATCH_UI_KEEP_DATA: '1', HATCH_UI_DATA_DIR: REL_DATA },
  stdio: 'inherit',
});
process.exit(r.status === null ? 1 : r.status);
