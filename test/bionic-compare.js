'use strict';
// 拿**本机真实安装的 Bionic**（LM Studio 的 agent 界面）当参照物，逐字段核对 One Harness 的 ui-state 复刻。
//
// 为什么值得做：core/uistate.js 开头写着"字段名跟 Bionic 保持一致，方便两边逐字段对照"，
// 但在此之前从没真的对照过 —— 那句话只是注释里的一句自我声明。这个脚本把它变成可验证的。
//
// 运行： node test/bionic-compare.js
//   BIONIC_UI_STATE_DIR  覆盖 Bionic 的 ui-state 目录（默认 ~/.lmstudio/.internal/ui-state/bionic）
//   HATCH_DATA_DIR       覆盖 One Harness 的数据目录（默认 <repo>/data）
//
// 注意这是**对照报告**而不是严格断言：One Harness 是有意只复刻一部分字段的，
// 所以"Bionic 有而 One Harness 没有"属于正常；真正该失败的是——
// One Harness 自己用了的字段名，在 Bionic 里根本不存在（那就等于借了一个不存在的名字）。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';const BIONIC_DIR = process.env.BIONIC_UI_STATE_DIR || path.join(HOME, '.lmstudio', '.internal', 'ui-state', 'bionic');
const HATCH_DIR = process.env.HATCH_DATA_DIR
  ? path.join(path.resolve(ROOT, process.env.HATCH_DATA_DIR), 'ui-state')
  : path.join(ROOT, 'data', 'ui-state');

// One Harness 有意改名/自创的字段（每加一个都要能说出理由，否则就是复刻走样了）
const INTENTIONAL = {
  workspace: 'Bionic 里这个段叫 bionic，One Harness 叫 workspace（core/uistate.js 注明）',
  activeSessionPerProjectIdentifier: 'One Harness 自创：Bionic 的会话激活态存在 chat.activeConversationIdentifier（单值），One Harness 要按项目各记一个',
  composerHeight: 'One Harness 自创：输入框高度记忆，Bionic 没有对应字段',
  windowMaximized: 'One Harness 自创：无边框窗口要自己记最大化状态（Bionic 有 lastExpandedWindowBounds，语义相近但形状不同）',
  tabLayouts: '同名，但 key 是 "workspace.sessions"（Bionic 是 "bionic.sessions"）',
};

function readJsonFile(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function listJson(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
}

const failures = [];
const lines = [];
function say(s) { lines.push(s); console.log(s); }

if (!fs.existsSync(BIONIC_DIR)) {
  console.error('找不到 Bionic 的 ui-state 目录：' + BIONIC_DIR + '\n（用 BIONIC_UI_STATE_DIR 指定）');
  process.exit(1);
}

// 先把 One Harness 侧的状态文件按**当前代码**归一化一遍（旧字段名迁移、废弃字段清理）再比较，
// 否则比的是"升级前的老文件"，永远差一口气。顺带也就验证了迁移逻辑真的有效。
// 注意必须在**读文件之前**做，否则读到的是归一化前的旧内容。
const uistate = require('../core/uistate');
uistate.patchGlobal({}); // readGlobal 只认白名单，这一写顺手清掉废弃字段
{
  const f = listJson(HATCH_DIR).find((x) => x.startsWith('window-'));
  if (f) uistate.patchWindow(f.replace(/^window-/, '').replace(/\.json$/, ''), {});
}

// ---------- global.json ----------
const bg = readJsonFile(path.join(BIONIC_DIR, 'global.json'));
const hg = readJsonFile(path.join(HATCH_DIR, 'global.json'));
say('=============== global.json ===============');
if (!bg || !hg) {
  say('有一边读不到（Bionic=' + !!bg + ' One Harness=' + !!hg + '），跳过');
} else {
  const bk = Object.keys(bg);
  const hk = Object.keys(hg);
  const shared = hk.filter((k) => bk.includes(k));
  say('两边都有：' + shared.join(', '));
  say('Bionic 有、One Harness 没复刻（' + (bk.length - shared.length) + ' 个）：' +
    bk.filter((k) => !hk.includes(k)).join(', '));
  const onlyHatch = hk.filter((k) => !bk.includes(k));
  say('只有 One Harness 有（' + onlyHatch.length + ' 个）：' + onlyHatch.join(', '));
  if (onlyHatch.length) failures.push('global.json 里 One Harness 自创了没登记的字段：' + onlyHatch.join(', '));
}

// ---------- window-*.json ----------
const bWinFile = listJson(BIONIC_DIR).find((f) => f.startsWith('window-'));
const hWinFile = listJson(HATCH_DIR).find((f) => f.startsWith('window-'));
const bw = bWinFile ? readJsonFile(path.join(BIONIC_DIR, bWinFile)) : null;
const hw = hWinFile ? readJsonFile(path.join(HATCH_DIR, hWinFile)) : null;

say('');
say('=============== window-*.json ===============');
if (!bw || !hw) {
  say('有一边读不到（Bionic=' + bWinFile + ' One Harness=' + hWinFile + '），跳过');
} else {
  say('Bionic: ' + bWinFile + '   One Harness: ' + hWinFile);

  // 顶层字段
  const bk = Object.keys(bw);
  const hk = Object.keys(hw);
  const shared = hk.filter((k) => bk.includes(k));
  say('');
  say('-- 顶层字段 --');
  say('两边都有：' + shared.join(', '));
  const onlyHatchTop = hk.filter((k) => !bk.includes(k));
  say('只有 One Harness 有：' + onlyHatchTop.join(', '));
  for (const k of onlyHatchTop) {
    if (!INTENTIONAL[k]) failures.push('window 顶层字段 ' + k + ' 在 Bionic 里不存在，也没登记为有意自创');
  }

  // workspace 段 ↔ bionic 段
  const bsec = bw.bionic || {};
  const hsec = hw.workspace || {};
  const bsk = Object.keys(bsec);
  const hsk = Object.keys(hsec);
  const secShared = hsk.filter((k) => bsk.includes(k));
  say('');
  say('-- One Harness 的 workspace.*  vs  Bionic 的 bionic.* --');
  say('同名（' + secShared.length + ' 个）：' + secShared.join(', '));
  const notInBionic = hsk.filter((k) => !bsk.includes(k));
  say('One Harness 用了但 Bionic 没有的字段名（' + notInBionic.length + ' 个）：' + notInBionic.join(', '));
  for (const k of notInBionic) {
    if (!INTENTIONAL[k]) failures.push('workspace.' + k + ' 这个名字在 Bionic 的 bionic 段里不存在，也没登记为有意自创');
  }
  say('Bionic 有、One Harness 没复刻（' + (bsk.length - secShared.length) + ' 个）：' +
    bsk.filter((k) => !hsk.includes(k)).join(', '));

  // 同名同义的字段顺手比一下值（类型不同或值差异很大才提一句）
  say('');
  say('-- 同名字段的值对照（仅列两边都有的）--');
  for (const k of secShared) {
    const bv = JSON.stringify(bsec[k]);
    const hv = JSON.stringify(hsec[k]);
    const same = bv === hv;
    say('  ' + (same ? '= ' : '≠ ') + k.padEnd(44) + 'Bionic=' + bv + '  One Harness=' + hv);
  }

  // tabLayouts 的 key 与 pane 结构
  say('');
  say('-- tabLayouts --');
  const bt = bw.tabLayouts || {};
  const ht = hw.tabLayouts || {};
  say('Bionic 的 key：' + Object.keys(bt).join(', ') + '   One Harness 的 key：' + Object.keys(ht).join(', '));
  const bp = Object.values(bt)[0];
  const hp = Object.values(ht)[0];
  if (bp && hp) {
    say('Bionic pane 字段：' + Object.keys(bp).join(', '));
    say('One Harness  pane 字段：' + Object.keys(hp).join(', '));
    if (Array.isArray(bp.tabs) && bp.tabs[0]) say('Bionic 的 tab id 样例：' + bp.tabs[0]);
    if (Array.isArray(hp.tabs) && hp.tabs[0]) say('One Harness  的 tab id 样例：' + hp.tabs[0]);
    else say('One Harness  当前没有打开的标签');
  }
}

say('');
say('=============== 结论 ===============');
if (failures.length) {
  say('发现 ' + failures.length + ' 处问题：');
  for (const f of failures) say('  - ' + f);
  process.exit(1);
}
say('One Harness 用到的每个 ui-state 字段名，都能在真实 Bionic 里找到出处（或已登记为有意自创）。');
