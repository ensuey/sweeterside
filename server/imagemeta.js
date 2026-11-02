'use strict';
/* Removes hidden metadata from uploaded JPEG, PNG and WebP files before they
   are saved: GPS location, camera and phone model, dates, comments, editing
   history and embedded thumbnails. Plain buffer parsing, no dependencies.

   A phone photo is often stored sideways with an EXIF "orientation" tag that
   tells the browser to turn it. Dropping that tag would show the photo
   sideways, so a JPEG keeps a new, tiny EXIF block holding the orientation
   and nothing else.

   strip() returns the cleaned file, or null when the file is not a well-formed
   image of a type we accept. A null means the upload is refused. */

const imagesize = require('./imagesize');

/* ---------------------------- JPEG ---------------------------- */

// Marker segments kept as they are. Everything else before the image data is
// dropped: APP1 (EXIF, XMP), APP3-APP13 and APP15 (maker notes, IPTC,
// Photoshop), and COM (comments). APP2 is kept only for an ICC colour profile.
const JPEG_KEEP_APP = new Set([0xe0, 0xee]); // JFIF, Adobe (colour transform)

/** The orientation (1-8) in an EXIF block, or null. body starts at "Exif\0\0". */
function exifOrientation(body) {
  if (body.length < 14 || body.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const tiff = body.subarray(6);
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const u16 = (o) => (order === 'II' ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (order === 'II' ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > tiff.length) return null;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** A complete APP1 segment holding only an orientation tag. */
function orientationSegment(orientation) {
  const seg = Buffer.alloc(36);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(34, 2); // length, counting itself
  seg.write('Exif\0\0', 4, 'latin1');
  seg.write('MM', 10, 'latin1');
  seg.writeUInt16BE(42, 12);
  seg.writeUInt32BE(8, 14); // IFD0 straight after the header
  seg.writeUInt16BE(1, 18); // one entry
  seg.writeUInt16BE(0x0112, 20); // Orientation
  seg.writeUInt16BE(3, 22); // SHORT
  seg.writeUInt32BE(1, 24); // one value
  seg.writeUInt16BE(orientation, 28);
  // Bytes 30-31 pad the value; 32-35 say there is no next IFD.
  return seg;
}

function stripJpeg(buf) {
  const out = [Buffer.from([0xff, 0xd8])];
  let pos = 2;
  let orientationKept = false;
  let inScan = false;

  while (pos < buf.length) {
    if (inScan) {
      // Entropy-coded data runs until a marker that is not a stuffed 0xFF00
      // or a restart marker.
      const start = pos;
      while (pos < buf.length) {
        if (buf[pos] === 0xff && pos + 1 < buf.length) {
          const n = buf[pos + 1];
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7)) break;
          pos += 2;
        } else {
          pos++;
        }
      }
      out.push(buf.subarray(start, pos));
      inScan = false;
      continue;
    }

    if (buf[pos] !== 0xff) return null;
    while (pos < buf.length && buf[pos] === 0xff) pos++; // fill bytes
    if (pos >= buf.length) return null;
    const marker = buf[pos++];

    if (marker === 0xd9) {
      // End of image. Anything after it (extra images some phones append,
      // each with its own metadata) is dropped.
      out.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (marker === 0xd8) return null; // a second start of image

    if (pos + 2 > buf.length) return null;
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) return null;
    const body = buf.subarray(pos + 2, pos + len);
    const segment = buf.subarray(pos - 2, pos + len);
    pos += len;

    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xe1) {
      const orientation = exifOrientation(body);
      if (orientation && orientation !== 1 && !orientationKept) {
        out.push(orientationSegment(orientation));
        orientationKept = true;
      }
      continue;
    }
    if (marker === 0xe2) {
      if (body.toString('latin1', 0, 12) === 'ICC_PROFILE\0') out.push(segment);
      continue;
    }
    if ((isApp && !JPEG_KEEP_APP.has(marker)) || marker === 0xfe) continue;

    out.push(segment);
    if (marker === 0xda) inScan = true; // start of scan: image data follows
  }

  // The data stopped before the end-of-image marker: finish it.
  if (out.length > 1) {
    out.push(Buffer.from([0xff, 0xd9]));
    return Buffer.concat(out);
  }
  return null;
}

/* ---------------------------- PNG ---------------------------- */

// Text, EXIF and timestamp chunks. Colour (iCCP, gAMA…) and image data stay.
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > buf.length) return null;
    if (!PNG_DROP.has(type)) out.push(buf.subarray(pos, end));
    pos = end;
    if (type === 'IEND') return Buffer.concat(out); // anything after it is dropped
  }
  return null;
}

/* ---------------------------- WebP ---------------------------- */

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(buf) {
  const end = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= end) {
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (pos + 8 + size > end) return null;
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const chunk = Buffer.from(buf.subarray(pos, pos + 8 + size)); // a copy: VP8X is edited
      if (fourcc === 'VP8X' && size >= 1) chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
      chunks.push(chunk);
      if (size % 2) chunks.push(Buffer.alloc(1)); // chunks are padded to an even size
    }
    pos += 8 + size + (size % 2);
  }
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/* ---------------------------- all types ---------------------------- */

/**
 * @returns {Buffer|null} the image without its metadata, or null if it is not
 *   a well-formed JPEG, PNG or WebP. The result is checked again, and must
 *   still be the same kind of image at the same size.
 */
function strip(buf) {
  const info = imagesize.fromBuffer(buf);
  if (!info) return null;
  let clean;
  try {
    clean = info.type === 'jpeg' ? stripJpeg(buf) : info.type === 'png' ? stripPng(buf) : stripWebp(buf);
  } catch {
    return null; // a read past the end of a malformed file
  }
  if (!clean) return null;
  const after = imagesize.fromBuffer(clean);
  if (!after || after.type !== info.type || after.width !== info.width || after.height !== info.height) return null;
  return clean;
}

module.exports = { strip, exifOrientation };
