'use strict';
// 真鼠标 + 截图：0.1.13 的「设置 → 兜底模型」改完文案之后长什么样。
// 顺带核两件这次一起改的事：模型候选是否只剩白名单、底部胶囊是否还重复。
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-09-16-16-28-57/hatch/lo-recon/shots-copy';
let n = 0;
const shot = async (api, name) => {
  n += 1;
  const p = OUT + '/' + String(n) + '-' + name + '.png';
  const r = await api.shot(p);
  api.log('shot ' + (r ? 'saved' : 'skipped') + ' ' + p);
  return r;
};

module.exports = async (api) => {
  const wait = api.wait;
  for (let i = 0; i < 60; i += 1) {
    if (await api.js('!!document.getElementById("btn-open-settings")')) break;
    await wait(300);
  }
  await wait(900);
  const steps = {};

  steps.clickSettings = await api.click('#btn-open-settings', '左下角「设置」');
  await wait(800);
  await shot(api, '设置');

  steps.clickFb = await api.click('#settings-nav .item[data-sec="fallback"]', '「兜底模型」');
  await wait(800);
  await shot(api, '兜底模型');

  steps.copy = await api.js(`(() => {
    const box = document.getElementById('settings-content');
    const t = box ? box.innerText : '';
    return {
      text: t.replace(/\\n{2,}/g, '\\n').slice(0, 900),
      hasStars: t.includes('**'),
      tips: [...box.querySelectorAll('.fb-card .hint')].map((e) => e.innerText.trim()),
      names: [...box.querySelectorAll('.fb-card-name')].map((e) => e.innerText.trim()),
      pills: [...box.querySelectorAll('.fb-card .pill')].map((e) => e.innerText.trim()),
      notes: [...box.querySelectorAll('.fb-card .state')].map((e) => e.innerText.trim()),
    };
  })()`);

  // 顺带看「常规」页的模型候选：白名单是否生效
  steps.clickGeneral = await api.click('#settings-nav .item[data-sec="general"]', '「常规」');
  await wait(700);
  steps.modelOptions = await api.js(`[...document.querySelectorAll('#model-options option')].map((o) => o.value)`);
  await shot(api, '常规');

  // 底部胶囊是否还重复
  steps.pills = await api.js(`[...document.querySelectorAll('#session-pills .pill')].map((e) => e.innerText.trim())`);

  const dupOne = steps.pills.filter((x) => x === 'One Harness').length;
  steps.verdict = {
    '兜底页里不再有字面 **': steps.copy.hasStars === false,
    '顶部说明是新文案（一句话）': /不填就用程序自带的那套/.test(steps.copy.text),
    '两张卡名简化（语言模型 / 图像生成）': steps.copy.names.join('|') === '语言模型|图像生成',
    '卡片说明是一行（不再是长段落）': steps.copy.tips.every((t) => t.length <= 60),
    '模型候选只剩白名单里的': steps.modelOptions.length === 1 && steps.modelOptions[0] === 'agnes-3.0-flash',
    '底部没有两枚同名 One Harness': dupOne <= 1,
  };
  const bad = Object.entries(steps.verdict).filter(([, v]) => !v);
  api.log('断言 ' + (Object.keys(steps.verdict).length - bad.length) + '/' + Object.keys(steps.verdict).length +
    (bad.length ? ' 失败：' + JSON.stringify(bad.map(([k]) => k)) : ''));
  api.log('文案 ' + JSON.stringify(steps.copy));
  api.log('候选 ' + JSON.stringify(steps.modelOptions) + ' / 胶囊 ' + JSON.stringify(steps.pills));
  return steps;
};
