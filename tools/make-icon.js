'use strict';
// 生成应用图标（One Harness）：assets/icon.png（256，给 Electron 用）+ assets/icon.ico（多尺寸，给 Windows 任务栏用）。
// 运行： NODE_PATH=<托管 node workspace>/node_modules node tools/make-icon.js
// 说明：本机 sharp 装在托管 node 的 workspace 里（不在本工程的 node_modules），所以要带 NODE_PATH。
// 图标本身就是「One」这个词：蓝底圆角方块 + 白色粗体 One。小尺寸把字号相对放大一点，
// 否则 16/24/32 这几个任务栏真正会用到的尺寸上字会糊成一团。

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.resolve(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function svg(size) {
  const r = Math.round(size * 0.22);                       // 圆角按比例
  const fs2 = Math.round(size * (size <= 32 ? 0.50 : 0.425)); // 小尺寸加粗放大
  const y = Math.round(size * 0.5 + fs2 * 0.355);          // 视觉居中（按字身高度对齐）
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#3d86ff"/>
      <stop offset="0.55" stop-color="#155dfc"/>
      <stop offset="1" stop-color="#0b3ea8"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#g)"/>
  <text x="${size * 0.5}" y="${y}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="${fs2}" font-weight="700" letter-spacing="${size <= 32 ? 0 : -size * 0.012}"
        fill="#ffffff">One</text>
</svg>`;
}

// ICO 容器：现代 Windows 支持"条目直接放 PNG"（Vista 起），所以把 sharp 渲染的 PNG 塞进去即可。
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = icon
  header.writeUInt16LE(count, 4);
  const dirs = [];
  let offset = 6 + count * 16;
  for (const p of pngs) {
    const d = Buffer.alloc(16);
    d.writeUInt8(p.size >= 256 ? 0 : p.size, 0);   // 0 表示 256
    d.writeUInt8(p.size >= 256 ? 0 : p.size, 1);
    d.writeUInt8(0, 2);                            // 调色板数
    d.writeUInt8(0, 3);                            // reserved
    d.writeUInt16LE(1, 4);                         // planes
    d.writeUInt16LE(32, 6);                        // bpp
    d.writeUInt32LE(p.buf.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += p.buf.length;
    dirs.push(d);
  }
  return Buffer.concat([header, ...dirs, ...pngs.map((p) => p.buf)]);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pngs = [];
  for (const size of SIZES) {
    const buf = await sharp(Buffer.from(svg(size))).png().toBuffer();
    pngs.push({ size, buf });
    if (size === 256) fs.writeFileSync(path.join(OUT, 'icon.png'), buf);
    if (size === 512) fs.writeFileSync(path.join(OUT, 'icon-512.png'), buf);
  }
  fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(pngs));
  // 顺手出一张 512 的大图给人看
  fs.writeFileSync(path.join(OUT, 'icon-512.png'), await sharp(Buffer.from(svg(512))).png().toBuffer());
  console.log('已生成：' + ['icon.png', 'icon.ico', 'icon-512.png'].join(' / ') +
    '（ico 内含 ' + SIZES.join('/') + '）');
})();
