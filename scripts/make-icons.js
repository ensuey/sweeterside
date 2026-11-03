'use strict';
/* Makes the favicon and app icons from the logo, with Node built-ins only
   (node:zlib for PNG). The logo has a wide empty margin, so it is cropped:
   - small icons (browser tab, 16-48 px) show the ice cream cup, the part
     that still reads at that size, on the logo's cream circle colour;
   - big icons (Home Screen, 180-512 px) show the whole round logo, filling
     the square, on white so iOS does not paint the corners black.

   node scripts/make-icons.js            write assets/icons/*
   node scripts/make-icons.js --measure  print where the circle and cup are

   Run again only if the logo changes. */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'assets', 'Sweeter Side - PNG.png');
const OUT = path.join(ROOT, 'assets', 'icons');

/* ---------------------------- PNG in ---------------------------- */

/** Decode an 8-bit RGBA or RGB, non-interlaced PNG. @returns { width, height, px: Uint8Array RGBA } */
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'IDAT') {
      idat.push(data);
    } else if (kind === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (depth !== 8 || (type !== 6 && type !== 2) || interlace) throw new Error('only 8-bit RGB/RGBA, not interlaced');
  const channels = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  const px = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    px[i * 4] = rows[j]; px[i * 4 + 1] = rows[j + 1]; px[i * 4 + 2] = rows[j + 2];
    px[i * 4 + 3] = channels === 4 ? rows[j + 3] : 255;
  }
  return { width, height, px };
}

/* ---------------------------- PNG out ---------------------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(kind, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** Encode RGBA pixels as a PNG (no metadata). */
function writePng({ width, height, px }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    Buffer.from(px.buffer, px.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico holding PNG images (every browser since IE 11 reads these). */
function writeIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

/* ---------------------------- pixels ---------------------------- */

const isInk = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  const [r, g, b, a] = [img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3]];
  return a > 16 && !(r > 245 && g > 245 && b > 245); // not transparent, not white
};

/** The box around everything that is not white or transparent. */
function inkBox(img, test = isInk) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!test(img, x, y)) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

/** The colour at the middle of the logo's circle background (just inside its left edge). */
function circleColour(img, box) {
  const y = Math.round((box.y0 + box.y1) / 2);
  const x = box.x0 + Math.round((box.x1 - box.x0) * 0.06);
  const i = (y * img.width + x) * 4;
  return [img.px[i], img.px[i + 1], img.px[i + 2]];
}

/** Crop the square (cx, cy, side) and scale it to size x size by averaging
    (area sampling), laid over a solid background colour. */
function iconFrom(img, { cx, cy, side }, size, bg) {
  const px = new Uint8Array(size * size * 4);
  const scale = side / size;
  const left = cx - side / 2, top = cy - side / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      const sx0 = left + x * scale, sy0 = top + y * scale;
      const steps = Math.max(1, Math.ceil(scale));
      for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
          const sx = Math.floor(sx0 + (i + 0.5) * scale / steps);
          const sy = Math.floor(sy0 + (j + 0.5) * scale / steps);
          let pr = bg[0], pg = bg[1], pb = bg[2];
          if (sx >= 0 && sy >= 0 && sx < img.width && sy < img.height) {
            const k = (sy * img.width + sx) * 4;
            const a = img.px[k + 3] / 255;
            pr = img.px[k] * a + bg[0] * (1 - a);
            pg = img.px[k + 1] * a + bg[1] * (1 - a);
            pb = img.px[k + 2] * a + bg[2] * (1 - a);
          }
          r += pr; g += pg; b += pb; n++;
        }
      }
      const o = (y * size + x) * 4;
      px[o] = Math.round(r / n); px[o + 1] = Math.round(g / n); px[o + 2] = Math.round(b / n); px[o + 3] = 255;
    }
  }
  return { width: size, height: size, px };
}

/* ---------------------------- the icons ---------------------------- */

const img = readPng(fs.readFileSync(LOGO));
const circle = inkBox(img);
const bg = circleColour(img, circle);

if (process.argv.includes('--measure')) {
  console.log(JSON.stringify({ size: [img.width, img.height], circle, circleColour: bg }));
  process.exit(0);
}

// Whole logo: the circle, filling the square with a hair of margin.
const whole = {
  cx: (circle.x0 + circle.x1) / 2, cy: (circle.y0 + circle.y1) / 2,
  side: Math.max(circle.x1 - circle.x0, circle.y1 - circle.y0) * 1.02,
};
// Small sizes: the ice cream cup with its straws and strawberries, from the
// logo itself (x 545-1020, y 480-1105 of 1563), on the circle colour. The
// lettering is left out: it cannot be read at 16-48 px.
const cup = { cx: 783, cy: 795, side: 680 };

fs.mkdirSync(OUT, { recursive: true });
const small = (size) => writePng(iconFrom(img, cup, size, bg));
const big = (size) => writePng(iconFrom(img, whole, size, [255, 255, 255]));
const files = {
  'favicon-16.png': small(16),
  'favicon-32.png': small(32),
  'favicon-48.png': small(48),
  'apple-touch-icon.png': big(180),
  'icon-192.png': big(192),
  'icon-512.png': big(512),
};
for (const [name, png] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), png);
fs.writeFileSync(path.join(OUT, 'favicon.ico'), writeIco([16, 32, 48].map((size) => ({ size, png: files[`favicon-${size}.png`] }))));
console.log('wrote', Object.keys(files).length + 1, 'icons to assets/icons/', JSON.stringify({ cup, whole }));
