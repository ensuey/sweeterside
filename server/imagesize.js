'use strict';
/* Minimal intrinsic-size reader for JPEG, PNG and WebP.
   Used to validate that a crop window actually falls inside its image, and to
   drive the crop editor in the admin UI. Also doubles as a magic-byte check:
   anything it cannot parse is not an image we accept. */

const fs = require('node:fs');

function fromBuffer(buf) {
  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (buf.length >= 24 &&
      buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // WebP: "RIFF"…"WEBP", then a VP8 / VP8L / VP8X chunk.
  if (buf.length >= 30 &&
      buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { type: 'webp', width: w, height: h };
    }
    return null;
  }

  // JPEG: walk the marker segments to the start-of-frame.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // Standalone markers carry no length payload.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 all carry the dimensions.
      const isSOF = (marker >= 0xc0 && marker <= 0xcf) &&
                    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }

  return null;
}

function fromFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    // 64KB is far more than enough to reach the SOF marker in practice.
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return fromBuffer(buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { fromBuffer, fromFile };
