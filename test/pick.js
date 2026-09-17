// 采样参考图若干坐标的像素色，用来定 CSS 变量（只读）
const sharp = require('sharp');
const src = process.argv[2];
const pts = [
  ['侧栏底', 80, 300],
  ['侧栏选中', 90, 347],
  ['侧栏选中2', 140, 347],
  ['主区底', 700, 300],
  ['顶栏底-侧栏侧', 80, 14],
  ['顶栏底-主区侧', 700, 14],
  ['tab底', 230, 14],
  ['会话项文字', 60, 207],
  ['会话项文字2', 52, 155],
  ['section标签', 20, 69],
  ['聊天标签', 16, 383],
  ['输入框底', 600, 536],
  ['输入框边框', 348, 536],
  ['发送按钮', 917, 546],
  ['滚动条-ish', 172, 300],
  ['分割线', 172, 90],
  ['主区右空白', 1000, 200],
  ['正文文字', 380, 20],
  ['用户气泡?', 900, 60],
  ['底部左小字', 355, 578],
  ['底部右小字', 890, 579],
];
sharp(src).raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => {
  const ch = info.channels;
  for (const [name, x, y] of pts) {
    const i = (y * info.width + x) * ch;
    const hex = '#' + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    console.log(`${name.padEnd(16)} (${String(x).padStart(4)},${String(y).padStart(3)})  ${hex}`);
  }
});
