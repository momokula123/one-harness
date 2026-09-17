'use strict';
// 批量回归专用的"安静"鼠标巡检包装器。
//
// 为什么需要它：真实鼠标巡检为了收到滚轮/悬停事件，必须开一个**抢焦点 + 置顶**的窗口，
// 跑一次屏幕上就冒出一个几十秒的窗口压在用户所有窗口上面。2026-09-17 的事故：
// 连着跑了几次回归，恰好用户在点自己那个确认框的「确定」—— 他那一击落在我的测试窗口上，
// 现象就是"按钮点了没反应"，白查半天。（更早还有"用户在打游戏被弹窗打断"。）
//
// 所以：
//   npm run test         → 走这里（屏幕外、不抢焦点，绝不打扰用户）
//   npm run test:mouse   → 同上
//   npm run test:mouse:visible → 才弹可见窗口（要验悬停/滚轮时用，跑一次就够）
//
// 屏幕外模式下：点击/拖拽/双击/键盘/可点性断言全部照常可靠；
// **悬停与滚轮会不准**（屏幕外窗口合成帧率极低），所以这两条在这里是"已知不准"，
// 输出里会明确标出来，而不是假装它通过了。

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STEPS = process.argv[2] || 'test/mouse-steps.js';

const child = spawn(process.execPath, [path.join(__dirname, 'run-mouse.js'), STEPS], {
  cwd: ROOT,
  env: { ...process.env, HATCH_MOUSE_OFFSCREEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

child.on('exit', (code) => {
  // 屏幕外模式下悬停/滚轮那两条不可靠 —— 把它们从判定里摘出去并说明，
  // 而不是让整批回归因此变红（也不是假装通过）。
  // 注意：它们可能表现为"通过"（恰好蒙对）也可能"失败"（测不准），两种都要摘，
  // 且**通过数也要相应减掉**，否则会算出 47/45 这种荒唐的账。
  const unreliable = ['滚轮事件真的送到页面', '指针移到发送按钮上会触发 mouseenter'];
  const lines = out.split('\n');
  const detailLines = [];   // 那两条的明细行（可能带 ✓ 或 ✗）
  const rest = [];
  for (const l of lines) {
    if (unreliable.some((n) => l.includes(n)) && /^[✓✗\s]/.test(l)) { detailLines.push(l.trim()); continue; }
    rest.push(l);
  }
  const printed = rest.join('\n');
  const passedUnreliable = detailLines.filter((l) => l.startsWith('✓')).length;
  const cleaned = printed.split('\n')
    .filter((l) => !(l.trim().startsWith('- ') && unreliable.some((n) => l.includes(n))))
    .join('\n')
    .replace(/通过 (\d+)\/(\d+)/, (m, p, t) => {
      const P = Number(p) - passedUnreliable;
      const T = Number(t) - unreliable.length;
      return '通过 ' + P + '/' + T + '（另有 ' + unreliable.length + ' 条屏幕外模式测不准，已剔出判定）';
    });

  console.log(cleaned.trimEnd());
  if (detailLines.length) {
    console.log('\n屏幕外模式下测不准的 ' + detailLines.length + ' 条（不参与判定，要验请跑 npm run test:mouse:visible）：');
    for (const l of detailLines) console.log('  ' + l);
  }
  process.exit(code);
});
