'use strict';
// 一次性诊断：CDP 输入到底哪一步生效、哪种事件不派发。
// 跑法： HATCH_MOUSE_TIMEOUT=150000 node test/run-mouse.js test/.probe-cdp.js
module.exports = async ({ click, probe, js, wait, log, input, hover, dblclick }) => {
  const st = async () => js("document.getElementById('app-root').className");
  const mm = async (tag) => log('   ' + tag + ' mm=' + (await js('window.__mm')) +
    ' mo=' + (await js('window.__mo')) + ' wh=' + (await js('window.__wh')) + ' enter=' + (await js('window.__ent')));

  await js(`window.__mm = 0; window.__mo = 0; window.__wh = 0; window.__ent = 0;
    document.addEventListener('mousemove', () => window.__mm++);
    document.addEventListener('mouseover', () => window.__mo++);
    document.addEventListener('wheel', () => window.__wh++);
    document.getElementById('btn-toggle-left').addEventListener('mouseenter', () => window.__ent++);`);
  await mm('注入后（基线，应为 0）');

  log('A. probe');
  const c = await probe('#btn-toggle-left');
  log('A done ' + JSON.stringify({ found: c.found, at: [c.x, c.y], reachable: c.reachable }));
  await mm('A 后');

  log('B. hover（内部会 moveTo）');
  await hover('#btn-toggle-left', 'pure-move');
  await mm('B 后');

  log('B2. 再 hover 一次同一个元素');
  await hover('#btn-toggle-left', 'pure-move-2');
  await mm('B2 后');

  log('C. click');
  await click('#btn-toggle-left', 'click-it');
  log('C done cls=' + (await st()));
  await mm('C 后');

  log('D. wheel');
  await input({ type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 150 });
  await wait(400);
  await mm('D 后');

  log('E. dblclick');
  await dblclick('#split-left', 'dbl');
  log('E done cls=' + (await st()));
  await mm('E 后');

  log('F. 键盘');
  await js("document.getElementById('input').focus();");
  log('F done focused=' + (await js("document.activeElement && document.activeElement.id")));

  return { finalMm: await js('window.__mm'), finalMo: await js('window.__mo'), finalWh: await js('window.__wh'), enter: await js('window.__ent') };
};
