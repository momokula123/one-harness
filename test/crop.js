const sharp = require('sharp');
const [src, out, l, t, w, h] = process.argv.slice(2);
sharp(src).metadata().then((m) => {
  const left = Math.min(Number(l || 0), m.width - 1);
  const top = Math.min(Number(t || 0), m.height - 1);
  return sharp(src)
    .extract({ left, top, width: Math.min(Number(w || m.width), m.width - left), height: Math.min(Number(h || m.height), m.height - top) })
    .toFile(out)
    .then(() => console.log(`源 ${m.width}x${m.height} → 裁 [${left},${top} ${w}x${h}] → ${out}`));
}).catch((e) => { console.error(e.message); process.exit(1); });
