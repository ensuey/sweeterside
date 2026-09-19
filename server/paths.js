'use strict';
/* Where things live on disk.
   In production the database and uploads must sit on a mounted volume, not
   inside the deployed image — containers get a fresh filesystem on every
   deploy, which would silently discard the menu and every uploaded photo. */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');

// Uploads keep the URL prefix /assets/uploads/ whatever directory backs them.
const UPLOAD_URL_PREFIX = 'assets/uploads';
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(ASSETS_DIR, 'uploads');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

module.exports = { ROOT, ASSETS_DIR, UPLOAD_DIR, UPLOAD_URL_PREFIX, DATA_DIR, DB_PATH };
