'use strict';
/*
 * 探针：出厂默认端点 —— 现在它住在随包的 config/model.json 里，不在代码里。
 * 要证的四件事（前三条是"配置生效"，第四条最容易漏）：
 *   1. 全新装好（空数据目录）→ 端点来自 config/model.json
 *   2. 用户自己填过 → 以他填的为准（配置文件不许盖掉他）
 *   3. 清空/没填 → 回落 config/model.json
 *   4. ★ 改 config/model.json 后马上生效（这是"做成配置文件"的全部意义），
 *      且 settings.json 里没有被钉死的默认值（否则第 4 条永远不成立）
 * 每一项都带反向对照，避免"断言恒真"。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = 'C:/Users/Administrator/WorkBuddy/2026-09-16-16-28-57/hatch';
const CFG_FILE = path.join(REPO, 'config', 'model.json');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-cfg-'));
process.env.HATCH_DATA_DIR = TMP;
const store = require(path.join(REPO, 'core', 'store.js'));

let fails = 0;
const ck = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  OK   ' : '  失败 ') + label + (ok ? '' : `\n        期望 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`));
};
const savedModel = () => (JSON.parse(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8')).model) || {};
const eff = () => store.getSettings().model;

console.log('配置文件：' + CFG_FILE);
console.log('它现在是：' + JSON.stringify(store.readDefaultModel()));
console.log();

console.log('① 全新装好（空数据目录、用户什么都没填）');
store.init();
const fromCfg = store.readDefaultModel();
ck('settings.json 里没有把默认值钉进去（端点三项都是空串）',
  { baseUrl: savedModel().baseUrl, apiKey: savedModel().apiKey, model: savedModel().model },
  { baseUrl: '', apiKey: '', model: '' });
ck('生效端点 = 配置文件里的', { baseUrl: eff().baseUrl, apiKey: eff().apiKey, model: eff().model },
  { baseUrl: fromCfg.baseUrl, apiKey: fromCfg.apiKey, model: fromCfg.model });
ck('配置文件确实有内容（不是空对空）', fromCfg.model !== '' && fromCfg.baseUrl !== '', true);
console.log();

console.log('② 用户自己填了端点 → 以他填的为准');
store.saveSettings({ model: { baseUrl: 'http://example.com/v1', apiKey: 'user-key-123', model: 'my-own-model' } });
ck('生效 = 用户的值', { baseUrl: eff().baseUrl, apiKey: eff().apiKey, model: eff().model },
  { baseUrl: 'http://example.com/v1', apiKey: 'user-key-123', model: 'my-own-model' });
ck('用户的值落盘保留（没被当成默认值擦掉）', savedModel().model, 'my-own-model');
const cfgNow = store.readDefaultModel();
ck('反向对照：此时配置文件仍是另一套值（证明上一条比的是用户值，不是碰巧相等）',
  cfgNow.model !== 'my-own-model', true);
console.log();

console.log('③ 用户清空 → 回落配置文件');
store.saveSettings({ model: { baseUrl: '', apiKey: '', model: '' } });
ck('生效 = 配置文件的值', eff().model, cfgNow.model);
console.log();

console.log('④ ★ 保存"和默认一样"的值不会被钉死，改配置文件当场生效');
store.saveSettings({ model: { baseUrl: cfgNow.baseUrl, apiKey: cfgNow.apiKey, model: cfgNow.model } });
ck('存进去的是空串（不是把默认值固化）',
  { baseUrl: savedModel().baseUrl, apiKey: savedModel().apiKey, model: savedModel().model },
  { baseUrl: '', apiKey: '', model: '' });
ck('但读出来仍然是那个值（行为不变）', eff().model, cfgNow.model);

const original = fs.readFileSync(CFG_FILE);           // 原样字节
const originalHash = require('crypto').createHash('sha256').update(original).digest('hex');
try {
  const edited = JSON.parse(original.toString('utf8'));
  edited.model = 'edited-by-probe';
  fs.writeFileSync(CFG_FILE, JSON.stringify(edited, null, 2), 'utf8');
  ck('改了 config/model.json 之后，生效值立刻跟着变', eff().model, 'edited-by-probe');
  ck('反向对照：readDefaultModel() 也读到了改动', store.readDefaultModel().model, 'edited-by-probe');
} finally {
  fs.writeFileSync(CFG_FILE, original);                // 还原
}
const restoredHash = require('crypto').createHash('sha256').update(fs.readFileSync(CFG_FILE)).digest('hex');
ck('配置文件已原样还原（sha256 一致）', restoredHash === originalHash, true);
ck('还原后生效值回到原样', eff().model, cfgNow.model);
console.log();

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
