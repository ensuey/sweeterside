'use strict';
/* Removes metadata (GPS, camera, comments…) from photos uploaded before
   uploads were cleaned on arrival: menu photos in UPLOAD_DIR and cake
   reference photos in CAKE_PHOTO_DIR.

   node scripts/strip-photo-metadata.js           report only
   node scripts/strip-photo-metadata.js --apply   clean the files

   Each file is written to a temporary file next to it and renamed over the
   original, so a file is never left half-written. A file that cannot be
   read as an image is left alone and counted. File names are random, so
   they are safe to print. */

const fs = require('node:fs');
const path = require('node:path');
const { UPLOAD_DIR, CAKE_PHOTO_DIR } = require('../server/paths');
const { strip } = require('../server/imagemeta');

const apply = process.argv.includes('--apply');

function clean(dir, label) {
  const counts = { cleaned: 0, unchanged: 0, skipped: 0, bytesSaved: 0 };
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n));
  } catch {
    console.log(`${label}: no folder at ${dir}`);
    return counts;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const buf = fs.readFileSync(file);
    const out = strip(buf);
    if (!out) {
      counts.skipped++;
      console.log(`${label}: skipped ${name} (not a readable image)`);
      continue;
    }
    if (out.equals(buf)) { counts.unchanged++; continue; }
    counts.cleaned++;
    counts.bytesSaved += buf.length - out.length;
    if (apply) {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, file);
    }
  }
  console.log(`${label}: ${names.length} files, ${counts.cleaned} ${apply ? 'cleaned' : 'to clean'}, `
    + `${counts.unchanged} already clean, ${counts.skipped} skipped, ${Math.round(counts.bytesSaved / 1024)} KB of metadata`);
  return counts;
}

clean(UPLOAD_DIR, 'Menu photos');
clean(CAKE_PHOTO_DIR, 'Cake photos');
if (!apply) console.log('Report only. Run again with --apply to clean the files.');
