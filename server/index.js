'use strict';
/* Sweeter Side — menu site plus admin backend.
   Zero dependencies: node:http, node:sqlite and node:crypto only. */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { seedIfEmpty } = require('./db');
const { ROOT, UPLOAD_DIR, UPLOAD_URL_PREFIX } = require('./paths');
const auth = require('./auth');
const menu = require('./menu');
const render = require('./render');
const imagesize = require('./imagesize');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_JSON = 64 * 1024;          // 64KB
const MAX_UPLOAD = 5 * 1024 * 1024;  // 5MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline style attributes carry the validated crop windows.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/* ---------------------------- helpers ---------------------------- */

function isSecure(req) {
  if (process.env.FORCE_SECURE_COOKIES === '1') return true;
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function baseHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, baseHeaders(headers));
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj),
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function sendHtml(res, status, html, headers = {}) {
  send(res, status, html,
    { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function redirect(res, location, headers = {}) {
  send(res, 302, '', { Location: location, ...headers });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected an object');
    }
    return parsed;
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* ---------------------------- static ---------------------------- */

function serveFile(req, res, absPath, { cache = 'public, max-age=300' } = {}) {
  let stat;
  try {
    stat = fs.statSync(absPath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const etag = `"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    send(res, 304, '', { ETag: etag, 'Cache-Control': cache });
    return true;
  }

  const type = MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, baseHeaders({
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cache,
    ETag: etag,
  }));
  fs.createReadStream(absPath).pipe(res);
  return true;
}

/** Map a URL path to a file inside one of the allowed roots, or null. */
function safeResolve(urlPath, allowedRoots) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const rel = decoded.replace(/^\/+/, '').replace(/\\/g, '/');
  for (const root of allowedRoots) {
    const abs = path.resolve(ROOT, rel);
    const rootAbs = path.resolve(ROOT, root);
    if (abs === rootAbs || abs.startsWith(rootAbs + path.sep)) return abs;
  }
  return null;
}

/* ---------------------------- auth gate ---------------------------- */

function currentSession(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.getSession(cookies[auth.SESSION_COOKIE]);
}

/** For JSON endpoints: returns the session or sends 401/403 and returns null. */
function requireApiAuth(req, res, { csrf = false } = {}) {
  const session = currentSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return null;
  }
  if (csrf && !auth.csrfOk(session, req.headers['x-csrf-token'])) {
    sendJson(res, 403, { error: 'Invalid CSRF token. Reload the page and try again.' });
    return null;
  }
  return session;
}

/* ---------------------------- routes ---------------------------- */

async function handleLogin(req, res) {
  const body = await readJson(req);
  const email = String(body.email ?? '').trim();
  const password = String(body.password ?? '');
  const key = auth.throttleKey(email, clientIp(req));

  const locked = auth.lockRemaining(key);
  if (locked > 0) {
    return sendJson(res, 429, {
      error: `Too many attempts. Try again in ${Math.ceil(locked / 60000)} minute(s).`,
    });
  }

  const user = auth.findUserByEmail(email);
  // Always run a hash comparison so a missing account and a wrong password
  // take a similar amount of time.
  const ok = user
    ? auth.verifyPassword(password, user.password_hash)
    : auth.verifyPassword(password, auth.hashPassword('placeholder-for-timing'));

  if (!user || !ok) {
    const { fails } = auth.recordFailure(key);
    const left = Math.max(0, auth.MAX_FAILS - fails);
    return sendJson(res, 401, {
      error: 'Incorrect email or password.' + (left <= 2 && left > 0 ? ` ${left} attempt(s) left.` : ''),
    });
  }

  auth.clearFailures(key);
  const { token, csrf } = auth.createSession(user.id);
  return sendJson(res, 200, { ok: true, email: user.email, csrf },
    { 'Set-Cookie': auth.sessionCookie(token, { secure: isSecure(req) }) });
}

function handleLogout(req, res) {
  const cookies = auth.parseCookies(req.headers.cookie);
  auth.destroySession(cookies[auth.SESSION_COOKIE]);
  return sendJson(res, 200, { ok: true },
    { 'Set-Cookie': auth.clearCookie({ secure: isSecure(req) }) });
}

async function handleUpload(req, res, session) {
  const buf = await readBody(req, MAX_UPLOAD);
  if (!buf.length) return sendJson(res, 400, { error: 'No file received.' });

  // Trust the bytes, not the filename or the declared content type.
  const info = imagesize.fromBuffer(buf);
  if (!info) {
    return sendJson(res, 400, { error: 'That file is not a JPEG, PNG or WebP image.' });
  }

  const ext = info.type === 'jpeg' ? '.jpg' : `.${info.type}`;
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);

  return sendJson(res, 201, {
    path: `assets/uploads/${name}`, width: info.width, height: info.height,
  });
}

function afterMutation(res, status, payload) {
  // Keep index.html current so plain static hosting still serves the real menu.
  let staticWarning = null;
  try {
    render.writeStatic();
  } catch (err) {
    staticWarning = `Menu saved, but index.html could not be rewritten: ${err.message}`;
  }
  return sendJson(res, status, staticWarning ? { ...payload, warning: staticWarning } : payload);
}

/* ---------------------------- server ---------------------------- */

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  /* ---- public menu ---- */
  if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
    return sendHtml(res, 200, render.buildHtml(), { 'Cache-Control': 'no-cache' });
  }

  /* ---- health check (for the hosting platform) ---- */
  if (pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
    return sendJson(res, 200, { ok: true, items: menu.list().length });
  }

  /* ---- auth API ---- */
  if (pathname === '/api/login' && method === 'POST') return handleLogin(req, res);
  if (pathname === '/api/logout' && method === 'POST') return handleLogout(req, res);

  if (pathname === '/api/session' && method === 'GET') {
    const session = currentSession(req);
    if (!session) return sendJson(res, 401, { error: 'Not signed in.' });
    return sendJson(res, 200, { email: session.email, csrf: session.csrf });
  }

  /* ---- admin pages ---- */
  if (pathname === '/admin/login' && method === 'GET') {
    if (currentSession(req)) return redirect(res, '/admin');
    let html = fs.readFileSync(path.join(ROOT, 'admin', 'login.html'), 'utf8');
    const banner = auth.countUsers() === 0
      ? '<p class="notice" role="status">No admin account exists yet. Run <code>npm run create-admin</code> in the project folder to make one.</p>'
      : '';
    return sendHtml(res, 200, html.replace('<!--SETUP-->', banner));
  }

  if (pathname === '/admin' && method === 'GET') {
    if (!currentSession(req)) return redirect(res, '/admin/login');
    return serveFile(req, res, path.join(ROOT, 'admin', 'index.html'), { cache: 'no-store' })
      || send(res, 404, 'Not found');
  }

  /* ---- menu API (all authenticated) ---- */
  if (pathname === '/api/items' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, { items: menu.list() });
  }

  if (pathname === '/api/items' && method === 'POST') {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const item = menu.create(await readJson(req));
    return afterMutation(res, 201, { item });
  }

  if (pathname === '/api/items/reorder' && method === 'POST') {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const body = await readJson(req);
    if (!Array.isArray(body.ids)) return sendJson(res, 400, { error: 'Expected an "ids" array.' });
    return afterMutation(res, 200, { items: menu.reorder(body.ids) });
  }

  const itemMatch = pathname.match(/^\/api\/items\/(\d+)$/);
  if (itemMatch) {
    const id = Number(itemMatch[1]);
    if (method === 'PUT' || method === 'PATCH') {
      if (!requireApiAuth(req, res, { csrf: true })) return;
      const item = menu.update(id, await readJson(req));
      if (!item) return sendJson(res, 404, { error: 'That item no longer exists.' });
      return afterMutation(res, 200, { item });
    }
    if (method === 'DELETE') {
      if (!requireApiAuth(req, res, { csrf: true })) return;
      if (!menu.remove(id)) return sendJson(res, 404, { error: 'That item no longer exists.' });
      return afterMutation(res, 200, { ok: true });
    }
  }

  /* ---- images ---- */
  if (pathname === '/api/images' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, { images: menu.availableImages() });
  }
  if (pathname === '/api/images' && method === 'POST') {
    const session = requireApiAuth(req, res, { csrf: true });
    if (!session) return;
    return handleUpload(req, res, session);
  }

  /* ---- static files ---- */
  if (method === 'GET' || method === 'HEAD') {
    // Uploads keep the /assets/uploads/ URL but may live on a mounted volume.
    if (pathname.startsWith(`/${UPLOAD_URL_PREFIX}/`)) {
      const mapped = menu.resolveImage(pathname.slice(1));
      if (mapped && serveFile(req, res, mapped.abs)) return;
      return sendHtml(res, 404, '<h1>404</h1><p>Image not found.</p>');
    }

    const abs = safeResolve(pathname, ['assets', 'admin']);
    if (abs) {
      // Never serve the admin HTML shells through the static path — they are
      // gated above.
      const name = path.basename(abs).toLowerCase();
      if (!(abs.includes(`${path.sep}admin${path.sep}`) && name.endsWith('.html'))) {
        if (serveFile(req, res, abs)) return;
      }
    }
  }

  return sendHtml(res, 404, '<h1>404</h1><p>Page not found. <a href="/">Back to the menu</a></p>');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (err instanceof menu.ValidationError) {
      return sendJson(res, 422, { error: 'Please fix the highlighted fields.', fields: err.errors });
    }
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    sendJson(res, status, { error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });
});

if (require.main === module) {
  const seeded = seedIfEmpty();
  if (seeded) console.log('Seeded the menu with the nine items from the posters.');
  if (auth.countUsers() === 0) {
    console.log('\n  No admin account yet. Create one with:  npm run create-admin\n');
  }
  try {
    render.writeStatic();
  } catch (err) {
    console.warn('Could not rewrite index.html:', err.message);
  }
  server.listen(PORT, HOST, () => {
    console.log(`Menu   http://${HOST}:${PORT}/`);
    console.log(`Admin  http://${HOST}:${PORT}/admin`);
  });

  // Hosting platforms send SIGTERM on deploy and shutdown.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`\n${signal} received, closing.`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

module.exports = { server, route };
