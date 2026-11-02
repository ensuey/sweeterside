'use strict';
/* F2: uploaded photos lose their metadata (GPS, camera, comments, appended
   images) but keep their picture and their orientation. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-imagemeta-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');
process.env.UPLOAD_DIR = path.join(TEST_DIR, 'uploads');

const { seedIfEmpty } = require('../server/db');
const auth = require('../server/auth');
const cakes = require('../server/cakes');
const imagesize = require('../server/imagesize');
const { strip, exifOrientation } = require('../server/imagemeta');
seedIfEmpty();

const ROOT = path.join(__dirname, '..');
const JPEG = fs.readFileSync(path.join(ROOT, 'assets', 'Meals.jpg'));
const PNG = fs.readFileSync(path.join(ROOT, 'assets', 'Sweeter Side - PNG.png'));
const SECRET = 'SECRET-14.5995N-120.9842E';

const has = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));

/** A JPEG marker segment. */
function segment(marker, body) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** An EXIF block (little-endian) with an orientation and a Make tag holding the secret. */
function exifBody(orientation) {
  const make = Buffer.from(`${SECRET}\0`, 'latin1');
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  // Make (ASCII), stored after the IFD.
  tiff.writeUInt16LE(0x010f, 10); tiff.writeUInt16LE(2, 12); tiff.writeUInt32LE(make.length, 14); tiff.writeUInt32LE(tiff.length, 18);
  // Orientation (SHORT).
  tiff.writeUInt16LE(0x0112, 22); tiff.writeUInt16LE(3, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt16LE(orientation, 30);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, make]);
}

/** Meals.jpg with EXIF, XMP, IPTC, a comment and an image appended after the end. */
function jpegWithMetadata(orientation = 6) {
  return Buffer.concat([
    JPEG.subarray(0, 2),
    segment(0xe1, exifBody(orientation)),
    segment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${SECRET}</x:xmpmeta>`, 'latin1')),
    segment(0xed, Buffer.from(`Photoshop 3.0\0${SECRET}`, 'latin1')),
    segment(0xfe, Buffer.from(`comment ${SECRET}`, 'latin1')),
    JPEG.subarray(2),
    // Some phones put a second image (a depth map, say) after the end.
    Buffer.from([0xff, 0xd8]), segment(0xe1, exifBody(1)), Buffer.from([0xff, 0xd9]),
  ]);
}

/** The bytes from the first start-of-scan to the end of the image. */
function scanData(buf) {
  const sos = buf.indexOf(Buffer.from([0xff, 0xda]));
  return buf.subarray(sos, buf.lastIndexOf(Buffer.from([0xff, 0xd9])) + 2);
}

test('a JPEG loses EXIF, XMP, IPTC, comments and appended images, and keeps its picture and orientation', () => {
  const dirty = jpegWithMetadata(6);
  assert.ok(has(dirty, SECRET));
  const clean = strip(dirty);
  assert.ok(clean, 'a valid JPEG is accepted');
  assert.ok(!has(clean, SECRET), 'no metadata is left');
  assert.ok(!has(clean, 'xmpmeta') && !has(clean, 'Photoshop'));
  assert.deepStrictEqual(imagesize.fromBuffer(clean), imagesize.fromBuffer(JPEG), 'same image, same size');
  assert.ok(clean.includes(scanData(JPEG)), 'the picture data is untouched');
  assert.strictEqual(clean.readUInt16BE(clean.length - 2), 0xffd9, 'ends at the end of the image');

  // The orientation survives, alone, in a small EXIF block.
  const app1 = clean.indexOf(Buffer.from([0xff, 0xe1]));
  assert.ok(app1 > 0);
  const len = clean.readUInt16BE(app1 + 2);
  assert.strictEqual(exifOrientation(clean.subarray(app1 + 4, app1 + 2 + len)), 6);
  assert.strictEqual(len, 34, 'nothing but the orientation');
});

test('an upright JPEG keeps no EXIF at all, and a clean one goes through unchanged', () => {
  const clean = strip(jpegWithMetadata(1));
  assert.strictEqual(clean.indexOf(Buffer.from([0xff, 0xe1])), -1);
  assert.deepStrictEqual(strip(clean), clean, 'stripping twice changes nothing');
});

/** A PNG chunk (the CRC is not checked by strip, so zeros will do). */
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

test('a PNG loses its text, EXIF and time chunks, and keeps the image', () => {
  const ihdrEnd = 8 + 25; // signature, then the IHDR chunk
  const dirty = Buffer.concat([
    PNG.subarray(0, ihdrEnd),
    pngChunk('tEXt', Buffer.from(`Comment\0${SECRET}`, 'latin1')),
    pngChunk('eXIf', exifBody(6).subarray(6)),
    pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${SECRET}`, 'latin1')),
    pngChunk('tIME', Buffer.alloc(7)),
    PNG.subarray(ihdrEnd),
    Buffer.from(`trailing ${SECRET}`, 'latin1'),
  ]);
  const clean = strip(dirty);
  assert.ok(clean);
  assert.ok(!has(clean, SECRET) && !has(clean, 'tIME'));
  assert.deepStrictEqual(imagesize.fromBuffer(clean), imagesize.fromBuffer(PNG));
  assert.ok(clean.includes(PNG.subarray(PNG.indexOf('IDAT', 0, 'latin1') - 4, PNG.indexOf('IEND', 0, 'latin1') + 8)),
    'image data and the end chunk are kept');
});

/** A WebP chunk, padded to an even size. */
function webpChunk(fourcc, data) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

test('a WebP loses its EXIF and XMP chunks and the flags that announce them', () => {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF, XMP and alpha
  vp8x.writeUIntLE(640 - 1, 4, 3);
  vp8x.writeUIntLE(480 - 1, 7, 3);
  const body = Buffer.concat([
    webpChunk('VP8X', vp8x),
    webpChunk('VP8L', Buffer.from([0x2f, 1, 2, 3, 4])), // odd size: padded
    webpChunk('EXIF', Buffer.from(SECRET, 'latin1')),
    webpChunk('XMP ', Buffer.from(`<x:xmpmeta>${SECRET}</x:xmpmeta>`, 'latin1')),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  const clean = strip(Buffer.concat([head, body]));
  assert.ok(clean);
  assert.ok(!has(clean, SECRET) && !has(clean, 'EXIF') && !has(clean, 'XMP '));
  assert.strictEqual(clean[20] & 0x0c, 0, 'the EXIF and XMP flags are off');
  assert.strictEqual(clean[20] & 0x10, 0x10, 'other flags are kept');
  assert.strictEqual(clean.readUInt32LE(4), clean.length - 8, 'the RIFF size matches');
  assert.deepStrictEqual(imagesize.fromBuffer(clean), { type: 'webp', width: 640, height: 480 });
});

test('broken or fake images are refused', () => {
  assert.strictEqual(strip(Buffer.from('not an image at all')), null);
  assert.strictEqual(strip(JPEG.subarray(0, 40)), null, 'a JPEG cut off in its headers');
  assert.strictEqual(strip(PNG.subarray(0, PNG.indexOf('IEND', 0, 'latin1') - 4)), null, 'a PNG without its end');
  const lying = Buffer.from(JPEG);
  lying.writeUInt16BE(0xffff, 4); // the first segment says it runs past the end of the file
  assert.strictEqual(strip(lying), null);
});

test('cake photos and menu photo uploads are saved without metadata', async () => {
  const token = cakes.savePhoto(jpegWithMetadata(6));
  assert.ok(token);
  const saved = fs.readFileSync(cakes.photoPath(token));
  assert.ok(!has(saved, SECRET), 'the cake photo on disk is clean');
  assert.strictEqual(cakes.savePhoto(Buffer.from('nope')), null);

  const email = 'meta@example.com';
  auth.createUser(email, 'a-long-enough-password');
  const { token: session, csrf } = auth.createSession(auth.findUserByEmail(email).id);
  const { server } = require('../server/index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/images`, {
      method: 'POST',
      headers: { Cookie: `${auth.SESSION_COOKIE}=${session}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' },
      body: jpegWithMetadata(3),
    });
    assert.strictEqual(res.status, 201);
    const { path: rel } = await res.json();
    const file = fs.readFileSync(path.join(process.env.UPLOAD_DIR, path.basename(rel)));
    assert.ok(!has(file, SECRET), 'the menu photo on disk is clean');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
