// 把参考图的某个区域裁出来放大，方便肉眼核对间距/圆角/配色（只读，不产出交付物）
const sharp = require('sharp');
const [src, out, l, t, w, h, scale] = process.argv.slice(2);
const s = Number(scale || 3);
sharp(src)
  .extract({ left: Number(l), top: Number(t), width: Number(w), height: Number(h) })
  .resize({ width: Math.round(Number(w) * s), kernel: 'nearest' })
  .toFile(out)
  .then((info) => console.log(`${info.width}x${info.height} -> ${out}`))
  .catch((e) => { console.error(e.message); process.exit(1); });
