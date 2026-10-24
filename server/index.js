'use strict';
/* Sweeter Side — menu site plus admin backend.
   Zero dependencies: node:http, node:sqlite and node:crypto only. */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { seedIfEmpty, transaction } = require('./db');
const { ROOT, UPLOAD_DIR, UPLOAD_URL_PREFIX } = require('./paths');
const auth = require('./auth');
const menu = require('./menu');
const categories = require('./categories');
const orders = require('./orders');
const vouchers = require('./vouchers');
const cakes = require('./cakes');
const checkout = require('./checkout');
const blocklist = require('./blocklist');
const { PHONE_MESSAGE, displayPhPhone } = require('./phone');
const staff = require('./staff');
const pos = require('./pos');
const settings = require('./settings');
const payments = require('./payments');
const shifts = require('./shifts');
const reports = require('./reports');
const audit = require('./audit');
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

/** Allow `limit` events per IP address in a sliding window of `windowMs`. */
function rateLimiter(limit, windowMs) {
  const log = new Map(); // ip -> timestamps
  return {
    limited(ip) {
      const now = Date.now();
      const recent = (log.get(ip) || []).filter((t) => now - t < windowMs);
      if (recent.length) log.set(ip, recent);
      else log.delete(ip);
      return recent.length >= limit;
    },
    record(ip) {
      const list = log.get(ip) || [];
      list.push(Date.now());
      log.set(ip, list);
    },
  };
}

/* Placing an order is the one public write. Cap how many orders one address
   can place, so a script cannot flood the kitchen. Only placed orders count:
   a customer fixing a typo in the form is never locked out. */
const orderLimiter = rateLimiter(5, 10 * 60 * 1000);

/* Checking a voucher code is public too. Every check counts, so nobody can
   try codes one after another until one works. */
const voucherLimiter = rateLimiter(20, 10 * 60 * 1000);

/* Cake bookings and their reference photos are public writes as well. */
const cakeLimiter = rateLimiter(3, 10 * 60 * 1000);
const cakePhotoLimiter = rateLimiter(5, 10 * 60 * 1000);

/* Refused orders and bookings are logged with a reason code only: no names,
   numbers or addresses end up in the logs. */
function logRejected(code, what = 'order') {
  console.log(`[rejected] ${what} ${code}`);
}

/** Log a refusal that came from the checks in orders.js or cakes.js, then rethrow it. */
function logAndRethrow(err, what) {
  if (err.code === 'blocked' || err.code === 'too_many_open') logRejected(err.code, what);
  else if (err instanceof menu.ValidationError && err.errors.phone === PHONE_MESSAGE) logRejected('invalid_phone', what);
  throw err;
}

// What a filled-in honeypot gets. It does not say why.
const GENERIC_REFUSAL = 'Your order could not be placed. Please call or message us.';
// What a missing, expired or too-quick checkout token gets. The cart fetches
// a fresh token when it sees retry, so a real customer just taps again.
const RETRY_CHECKOUT = 'Please check your order and tap Place order again.';

function isJson(req) {
  return String(req.headers['content-type'] || '').startsWith('application/json');
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

/* The POS: the admin session plus a staff member's PIN session, sent in a
   header. A locked POS answers 423 (not 401), so the page asks for a PIN
   instead of sending the tablet to the admin sign-in. */
const STAFF_HEADER = 'x-staff-token';

function requireStaff(req, res, { csrf = false, permission } = {}) {
  const session = requireApiAuth(req, res, { csrf });
  if (!session) return null;
  const member = staff.current(req.headers[STAFF_HEADER], session.id);
  if (!member) {
    sendJson(res, 423, { error: 'The POS is locked. Tap your name and enter your PIN.', locked: true });
    return null;
  }
  if (permission && !staff.can(member.role, permission)) {
    sendJson(res, 403, { error: 'Only the owner can do that.' });
    return null;
  }
  return { session, staff: member };
}

/** What the signed-in staff member may do, for the screen to show or hide. */
function permissionsOf(role) {
  return Object.keys(staff.PERMISSIONS).filter((p) => staff.can(role, p));
}

/* Wrong PINs are throttled per staff member; this also caps how many PINs one
   address can try across all staff. Only wrong PINs count. */
const pinLimiter = rateLimiter(30, 10 * 60 * 1000);

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

  if (pathname === '/cakes' && (method === 'GET' || method === 'HEAD')) {
    return sendHtml(res, 200, render.buildCakesHtml(), { 'Cache-Control': 'no-cache' });
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

  // The admin pages: orders (with the ordering settings), items, vouchers, cakes and blocked numbers.
  const adminPages = {
    '/admin': 'index.html', '/admin/items': 'items.html',
    '/admin/vouchers': 'vouchers.html', '/admin/cakes': 'cakes.html',
    '/admin/blocked': 'blocked.html', '/admin/pos': 'pos.html', '/admin/staff': 'staff.html',
    '/admin/reports': 'reports.html',
  };
  if (adminPages[pathname] && method === 'GET') {
    if (!currentSession(req)) return redirect(res, '/admin/login');
    return serveFile(req, res, path.join(ROOT, 'admin', adminPages[pathname]), { cache: 'no-store' })
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

  // Availability and the daily limit are saved on their own, straight from
  // the items list, without resubmitting the whole item.
  const stockMatch = pathname.match(/^\/api\/items\/(\d+)\/stock$/);
  if (stockMatch && (method === 'PATCH' || method === 'PUT')) {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const item = menu.setStock(Number(stockMatch[1]), await readJson(req));
    if (!item) return sendJson(res, 404, { error: 'That item no longer exists.' });
    return afterMutation(res, 200, { item });
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

  /* ---- categories API (all authenticated) ---- */
  if (pathname === '/api/categories' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, { categories: categories.list() });
  }

  if (pathname === '/api/categories' && method === 'POST') {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const category = categories.create(await readJson(req));
    return afterMutation(res, 201, { category });
  }

  if (pathname === '/api/categories/reorder' && method === 'POST') {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const body = await readJson(req);
    if (!Array.isArray(body.ids)) return sendJson(res, 400, { error: 'Expected an "ids" array.' });
    return afterMutation(res, 200, { categories: categories.reorder(body.ids) });
  }

  const categoryMatch = pathname.match(/^\/api\/categories\/(\d+)$/);
  if (categoryMatch) {
    const id = Number(categoryMatch[1]);
    if (method === 'PUT' || method === 'PATCH') {
      if (!requireApiAuth(req, res, { csrf: true })) return;
      const category = categories.update(id, await readJson(req));
      if (!category) return sendJson(res, 404, { error: 'That category no longer exists.' });
      return afterMutation(res, 200, { category });
    }
    if (method === 'DELETE') {
      if (!requireApiAuth(req, res, { csrf: true })) return;
      if (!categories.remove(id)) return sendJson(res, 404, { error: 'That category no longer exists.' });
      return afterMutation(res, 200, { ok: true });
    }
  }

  /* ---- orders: placing is public, everything else is admin-only ---- */
  // The cart asks for a signed token when it opens; the order must carry it.
  if (pathname === '/api/checkout-token' && method === 'GET') {
    return sendJson(res, 200, { token: checkout.issue(), min_ms: checkout.MIN_AGE_MS });
  }

  if (pathname === '/api/orders' && method === 'POST') {
    // Requiring JSON means a plain HTML form on another site cannot post here.
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return sendJson(res, 415, { error: 'Send the order as JSON.' });
    }
    const ip = clientIp(req);
    if (orderLimiter.limited(ip)) {
      return sendJson(res, 429, {
        error: 'You have placed several orders in the last few minutes. Please call us to add more.',
      });
    }
    const body = await readJson(req);
    // Closed says closed, whatever else is wrong with the order.
    if (!orders.isShopOpen()) throw orders.shopClosedError();
    // A hidden field people never see. Bots that fill every field fill it.
    if (String(body.website ?? '').trim()) {
      logRejected('honeypot');
      return sendJson(res, 400, { error: GENERIC_REFUSAL });
    }
    const tokenProblem = checkout.check(body.checkout_token);
    if (tokenProblem) {
      logRejected(tokenProblem);
      return sendJson(res, 409, { error: RETRY_CHECKOUT, retry: true });
    }
    let order;
    try {
      order = orders.create(body);
    } catch (err) {
      logAndRethrow(err, 'order');
    }
    orderLimiter.record(ip);
    console.log(`[order] #${order.id} ${order.order_type} Php ${order.total} — ${order.items.length} line(s)`
      + (order.voucher_code ? ` — voucher ${order.voucher_code} -${order.discount}` : ''));
    return sendJson(res, 201, {
      order: {
        id: order.id, order_type: order.order_type, items: order.items, subtotal: order.subtotal,
        voucher_code: order.voucher_code, discount: order.discount,
        delivery_fee: order.delivery_fee, total: order.total,
        cash: order.cash, change_due: order.change_due,
        table_no: order.table_no, pickup_at: order.pickup_at,
      },
    });
  }

  /* ---- vouchers: checking a code is public, managing them is admin-only ---- */
  if (pathname === '/api/vouchers/check' && method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return sendJson(res, 415, { error: 'Send the code as JSON.' });
    }
    // A cart left open while the shop closed should not keep checking codes.
    if (!orders.isShopOpen()) throw orders.shopClosedError();
    const ip = clientIp(req);
    if (voucherLimiter.limited(ip)) {
      return sendJson(res, 429, { error: 'Too many codes tried. Please wait a few minutes and try again.' });
    }
    voucherLimiter.record(ip);
    const body = await readJson(req);
    // Priced exactly as the order will be, so the total shown is the total charged.
    const q = orders.quote(body.items, body.type === undefined ? 'delivery' : String(body.type),
      new Date(), body.code);
    if (q.voucherError) throw new menu.ValidationError({ voucher: q.voucherError });
    if (!q.voucher) throw new menu.ValidationError({ voucher: 'Enter a voucher code.' });
    return sendJson(res, 200, {
      voucher: q.voucher, subtotal: q.subtotal, discount: q.discount,
      delivery_fee: q.delivery_fee, total: q.total,
    });
  }

  if (pathname === '/api/vouchers' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, { vouchers: vouchers.list() });
  }

  if (pathname === '/api/vouchers' && method === 'POST') {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    return sendJson(res, 201, { voucher: vouchers.create(await readJson(req)) });
  }

  const voucherActiveMatch = pathname.match(/^\/api\/vouchers\/(\d+)\/active$/);
  if (voucherActiveMatch && (method === 'PATCH' || method === 'PUT')) {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const body = await readJson(req);
    const voucher = vouchers.setActive(Number(voucherActiveMatch[1]), body.active === true);
    if (!voucher) return sendJson(res, 404, { error: 'That voucher no longer exists.' });
    return sendJson(res, 200, { voucher });
  }

  const voucherMatch = pathname.match(/^\/api\/vouchers\/(\d+)$/);
  if (voucherMatch) {
    const id = Number(voucherMatch[1]);
    if (method === 'PUT' || method === 'PATCH') {
      if (!requireApiAuth(req, res, { csrf: true })) return;
      const voucher = vouchers.update(id, await readJson(req));
      if (!voucher) return sendJson(res, 404, { error: 'That voucher no longer exists.' });
      return sendJson(res, 200, { voucher });
    }
    if (method === 'DELETE') {
      if (!requireApiAuth(req, res, { csrf: true })) return;
      if (!vouchers.remove(id)) return sendJson(res, 404, { error: 'That voucher no longer exists.' });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/orders' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, {
      orders: orders.list(url.searchParams.get('show') || 'active'),
      counts: orders.counts(),
    });
  }

  const orderMatch = pathname.match(/^\/api\/orders\/(\d+)$/);
  if (orderMatch && (method === 'PATCH' || method === 'PUT')) {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const body = await readJson(req);
    const order = orders.setStatus(Number(orderMatch[1]), String(body.status ?? ''),
      { reason: body.reason === undefined ? undefined : String(body.reason) });
    if (!order) return sendJson(res, 404, { error: 'That order no longer exists.' });
    return sendJson(res, 200, { order });
  }

  /* ---- blocked numbers (all authenticated) ---- */
  if (pathname === '/api/blocked' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, {
      blocked: blocklist.list().map((b) => ({ ...b, display: displayPhPhone(b.phone_norm) })),
    });
  }

  // { phone, reason } blocks a number typed by the admin. { order_id, reason,
  // cancel } blocks the number on an order, and with cancel: true also
  // cancels that order as a fake, both or neither.
  if (pathname === '/api/blocked' && method === 'POST') {
    const session = requireApiAuth(req, res, { csrf: true });
    if (!session) return;
    const body = await readJson(req);
    let phone = body.phone;
    let order = null;
    if (body.order_id !== undefined) {
      order = orders.get(Number(body.order_id));
      if (!order) return sendJson(res, 404, { error: 'That order no longer exists.' });
      if (!order.phone_norm) return sendJson(res, 422, { error: 'This order has no mobile number to block.' });
      phone = order.phone_norm;
    }
    const blocked = transaction(() => {
      const row = blocklist.add({ phone, reason: body.reason }, session.email);
      if (order && body.cancel === true) orders.setStatus(order.id, 'cancelled', { reason: 'fake' });
      return row;
    });
    return sendJson(res, 201, { blocked: { ...blocked, display: displayPhPhone(blocked.phone_norm) } });
  }

  const blockedMatch = pathname.match(/^\/api\/blocked\/(\d+)$/);
  if (blockedMatch && method === 'DELETE') {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    if (!blocklist.remove(Number(blockedMatch[1]))) return sendJson(res, 404, { error: 'That number is not blocked.' });
    return sendJson(res, 200, { ok: true });
  }

  /* ---- POS: staff and PINs ---- */
  // The names on the PIN screen. Needs the admin session only.
  if (pathname === '/api/pos/staff' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, { staff: staff.list(), has_staff: staff.hasStaff() });
  }

  if (pathname === '/api/pos/unlock' && method === 'POST') {
    const session = requireApiAuth(req, res, { csrf: true });
    if (!session) return;
    const ip = clientIp(req);
    if (pinLimiter.limited(ip)) {
      return sendJson(res, 429, { error: 'Too many wrong PINs from this device. Wait a few minutes.' });
    }
    const body = await readJson(req);
    let opened;
    try {
      opened = staff.unlock(Number(body.staff_id), String(body.pin ?? ''), session.id);
    } catch (err) {
      if ((err.body && err.body.wrong_pin) || err.status === 429) pinLimiter.record(ip);
      throw err;
    }
    return sendJson(res, 200, { ...opened, permissions: permissionsOf(opened.staff.role) });
  }

  if (pathname === '/api/pos/lock' && method === 'POST') {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    staff.lock(req.headers[STAFF_HEADER]);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/pos/me' && method === 'GET') {
    const who = requireStaff(req, res);
    if (!who) return;
    return sendJson(res, 200, { staff: who.staff, permissions: permissionsOf(who.staff.role) });
  }

  /* ---- POS: menu, tickets and tabs ---- */
  if (pathname === '/api/pos/menu' && method === 'GET') {
    if (!requireStaff(req, res)) return;
    const s = settings.posSettings();
    return sendJson(res, 200, {
      categories: categories.list(), items: pos.posMenu(),
      delivery_fee: orders.getDeliveryFee(), service_charge: s.service_charge,
      vat_registered: s.vat_registered, cashier_discount_limit_bp: s.cashier_discount_limit_bp,
      lock_minutes: s.pos_lock_minutes,
    });
  }

  if (pathname === '/api/pos/open' && method === 'GET') {
    if (!requireStaff(req, res)) return;
    return sendJson(res, 200, { orders: pos.open() });
  }

  if (pathname === '/api/pos/quote' && method === 'POST') {
    const who = requireStaff(req, res, { csrf: true });
    if (!who) return;
    const body = await readJson(req);
    return sendJson(res, 200, pos.quote(body.id ? Number(body.id) : null, body, who.staff));
  }

  if (pathname === '/api/pos/orders' && method === 'POST') {
    const who = requireStaff(req, res, { csrf: true });
    if (!who) return;
    const saved = pos.save(null, await readJson(req), who.staff);
    if (!saved.replayed) console.log(`[pos] #${saved.order.id} ${saved.order.order_type} by staff ${who.staff.id}`);
    return sendJson(res, saved.replayed ? 200 : 201, saved);
  }

  const posOrderMatch = pathname.match(/^\/api\/pos\/orders\/(\d+)(?:\/(table|merge|void|pay|refund|receipt))?$/);
  if (posOrderMatch) {
    const id = Number(posOrderMatch[1]);
    const action = posOrderMatch[2];
    if (!action && method === 'GET') {
      const who = requireStaff(req, res);
      if (!who) return;
      const order = pos.view(id, who.staff);
      if (!order) return sendJson(res, 404, { error: 'That order is not a POS order or no longer exists.' });
      return sendJson(res, 200, { order, balance: payments.balance(id) });
    }
    if (action === 'receipt' && method === 'GET') {
      const who = requireStaff(req, res);
      if (!who) return;
      return sendJson(res, 200, payments.receipt(id, who.staff));
    }
    if ((action === 'pay' || action === 'refund') && method === 'POST') {
      const who = requireStaff(req, res, { csrf: true });
      if (!who) return;
      const body = await readJson(req);
      const done = action === 'pay' ? payments.pay(id, body, who.staff) : payments.refund(id, body, who.staff);
      if (!done.replayed) console.log(`[pos] #${id} ${action} by staff ${who.staff.id}`);
      return sendJson(res, 200, done);
    }
    if (!action && (method === 'PUT' || method === 'PATCH')) {
      const who = requireStaff(req, res, { csrf: true });
      if (!who) return;
      return sendJson(res, 200, pos.save(id, await readJson(req), who.staff));
    }
    if (action && method === 'POST') {
      const who = requireStaff(req, res, { csrf: true });
      if (!who) return;
      const body = await readJson(req);
      if (action === 'table') return sendJson(res, 200, { order: pos.moveTable(id, body.table_no, who.staff) });
      if (action === 'merge') return sendJson(res, 200, { order: pos.merge(id, Number(body.into), who.staff) });
      return sendJson(res, 200, pos.voidOrder(id, body, who.staff));
    }
  }

  if (pathname === '/api/pos/recent' && method === 'GET') {
    if (!requireStaff(req, res)) return;
    return sendJson(res, 200, { orders: payments.recent() });
  }

  /* ---- POS: shifts and the cash drawer ---- */
  if (pathname === '/api/pos/shift' && method === 'GET') {
    if (!requireStaff(req, res)) return;
    const open = shifts.current();
    return sendJson(res, 200, {
      shift: open ? shifts.reading(open) : null,
      methods: Object.entries(payments.METHODS).map(([id, m]) => ({ id, label: m.label, reference: m.reference, drawer: !!m.drawer })),
    });
  }

  const shiftAction = pathname.match(/^\/api\/pos\/shift\/(open|cash|close)$/);
  if (shiftAction && method === 'POST') {
    const action = shiftAction[1];
    const who = requireStaff(req, res, { csrf: true, permission: action === 'cash' ? 'cash_movement' : 'manage_shift' });
    if (!who) return;
    const body = await readJson(req);
    if (action === 'open') return sendJson(res, 201, { shift: shifts.open(body, who.staff) });
    if (action === 'cash') return sendJson(res, 200, { shift: shifts.cashMove(body, who.staff) });
    return sendJson(res, 200, { report: shifts.close(body, who.staff) });
  }

  if (pathname === '/api/pos/shifts' && method === 'GET') {
    if (!requireStaff(req, res, { permission: 'manage_shift' })) return;
    return sendJson(res, 200, { shifts: shifts.recent() });
  }

  const shiftMatch = pathname.match(/^\/api\/pos\/shifts\/(\d+)$/);
  if (shiftMatch && method === 'GET') {
    if (!requireStaff(req, res, { permission: 'manage_shift' })) return;
    const report = shifts.report(Number(shiftMatch[1]));
    if (!report) return sendJson(res, 404, { error: 'No such shift.' });
    return sendJson(res, 200, { report });
  }

  /* ---- Reports and the audit log: the owner only ---- */
  const q = Object.fromEntries(url.searchParams);
  const sendCsv = (name, body) => send(res, 200, `﻿${body}`, {
    'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${name}"`,
  });

  const reportMatch = pathname.match(/^\/api\/reports\/(summary|sc-pwd|sc-pwd\.csv|discounts|threshold)$/);
  if (reportMatch && method === 'GET') {
    if (!requireStaff(req, res, { permission: 'reports' })) return;
    const which = reportMatch[1];
    if (which === 'summary') return sendJson(res, 200, reports.summary(q));
    if (which === 'sc-pwd') return sendJson(res, 200, reports.scPwd(q));
    if (which === 'sc-pwd.csv') return sendCsv(`sc-pwd-${reports.range(q).from}-to-${reports.range(q).to}.csv`, reports.scPwdCsv(q));
    if (which === 'discounts') return sendJson(res, 200, reports.discounts(q));
    return sendJson(res, 200, reports.threshold());
  }

  if ((pathname === '/api/audit' || pathname === '/api/audit.csv') && method === 'GET') {
    if (!requireStaff(req, res, { permission: 'audit' })) return;
    const r = reports.range(q);
    const entries = audit.list({ from: r.from, to: r.to, action: q.action || undefined, staff_id: q.staff_id || undefined });
    if (pathname === '/api/audit.csv') return sendCsv(`audit-${r.from}-to-${r.to}.csv`, reports.auditCsv(entries));
    return sendJson(res, 200, { from: r.from, to: r.to, entries, actions: audit.ACTIONS, staff: staff.list({ all: true }) });
  }

  /* ---- Receipt settings: printed by everyone, changed by the owner ---- */
  if (pathname === '/api/pos/receipt-settings' && method === 'GET') {
    if (!requireStaff(req, res)) return;
    return sendJson(res, 200, settings.receiptSettings());
  }

  if (pathname === '/api/pos/receipt-settings' && (method === 'PUT' || method === 'PATCH')) {
    const who = requireStaff(req, res, { csrf: true, permission: 'tax_settings' });
    if (!who) return;
    const before = settings.receiptSettings();
    const after = settings.updateReceiptSettings(await readJson(req));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      audit.record({ action: 'settings_change', staff: who.staff, details: { receipt: { before, after } } });
    }
    return sendJson(res, 200, after);
  }

  /* ---- POS settings: everyone at the POS reads them, the owner changes them ---- */
  if (pathname === '/api/pos/settings' && method === 'GET') {
    if (!requireStaff(req, res)) return;
    return sendJson(res, 200, { ...settings.posSettings(), delivery_fee: orders.getDeliveryFee() });
  }

  if (pathname === '/api/pos/settings' && (method === 'PUT' || method === 'PATCH')) {
    const who = requireStaff(req, res, { csrf: true, permission: 'tax_settings' });
    if (!who) return;
    const before = settings.posSettings();
    const after = settings.updatePosSettings(await readJson(req));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      audit.record({ action: 'settings_change', staff: who.staff, details: { before, after } });
    }
    return sendJson(res, 200, after);
  }

  /* ---- Staff page: the owner manages staff ---- */
  if (pathname === '/api/staff' && method === 'GET') {
    if (!requireStaff(req, res, { permission: 'manage_staff' })) return;
    return sendJson(res, 200, { staff: staff.list({ all: true }) });
  }

  // The very first staff member (the owner), while there are none. The admin
  // types their password again, so a tablet left signed in cannot be used to
  // make someone else the owner.
  if (pathname === '/api/staff/first' && method === 'POST') {
    const session = requireApiAuth(req, res, { csrf: true });
    if (!session) return;
    const body = await readJson(req);
    const key = auth.throttleKey(session.email, clientIp(req));
    const locked = auth.lockRemaining(key);
    if (locked > 0) {
      return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(locked / 60000)} minute(s).` });
    }
    const user = auth.findUserByEmail(session.email);
    if (!user || !auth.verifyPassword(String(body.password ?? ''), user.password_hash)) {
      auth.recordFailure(key);
      throw new menu.ValidationError({ password: 'That is not the admin password.' });
    }
    auth.clearFailures(key);
    if (staff.hasStaff()) return sendJson(res, 409, { error: 'The owner is already set up. Unlock with their PIN.' });
    return sendJson(res, 201, { staff: staff.create({ ...body, role: 'owner' }, null) });
  }

  if (pathname === '/api/staff' && method === 'POST') {
    const who = requireStaff(req, res, { csrf: true, permission: 'manage_staff' });
    if (!who) return;
    return sendJson(res, 201, { staff: staff.create(await readJson(req), who.staff) });
  }

  const staffMatch = pathname.match(/^\/api\/staff\/(\d+)(\/pin)?$/);
  if (staffMatch && (method === 'PATCH' || method === 'PUT' || method === 'POST')) {
    const who = requireStaff(req, res, { csrf: true, permission: 'manage_staff' });
    if (!who) return;
    const body = await readJson(req);
    const id = Number(staffMatch[1]);
    const member = staffMatch[2]
      ? staff.resetPin(id, body.pin, who.staff)
      : staff.update(id, body, who.staff);
    if (!member) return sendJson(res, 404, { error: 'That staff member no longer exists.' });
    return sendJson(res, 200, { staff: member });
  }

  /* ---- settings ---- */
  if (pathname === '/api/settings' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, orders.settings());
  }

  if (pathname === '/api/settings' && (method === 'PUT' || method === 'PATCH')) {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const settings = orders.updateSettings(await readJson(req));
    // Both values are printed into the customer page, so rebuild it.
    return afterMutation(res, 200, settings);
  }

  /* ---- cake bookings: requesting is public, managing them is admin-only ---- */
  if (pathname === '/api/cakes/availability' && method === 'GET') {
    return sendJson(res, 200, cakes.availability());
  }

  if (pathname === '/api/cakes/photo' && method === 'POST') {
    const ip = clientIp(req);
    if (cakePhotoLimiter.limited(ip)) {
      return sendJson(res, 429, { error: 'Too many photos sent. Please wait a few minutes.' });
    }
    const buf = await readBody(req, MAX_UPLOAD);
    if (!buf.length) return sendJson(res, 400, { error: 'No photo received.' });
    // Trust the bytes, not the filename or the declared type.
    const token = cakes.savePhoto(buf);
    if (!token) return sendJson(res, 400, { error: 'That file is not a JPEG, PNG or WebP photo.' });
    cakePhotoLimiter.record(ip);
    return sendJson(res, 201, { photo: token });
  }

  if (pathname === '/api/cakes' && method === 'POST') {
    if (!isJson(req)) return sendJson(res, 415, { error: 'Send the booking as JSON.' });
    const ip = clientIp(req);
    if (cakeLimiter.limited(ip)) {
      return sendJson(res, 429, {
        error: 'You have sent several cake requests in the last few minutes. Please call us to add more.',
      });
    }
    let booking;
    try {
      booking = cakes.create(await readJson(req));
    } catch (err) {
      logAndRethrow(err, 'cake');
    }
    cakeLimiter.record(ip);
    console.log(`[cake] #${booking.id} for ${booking.needed_on} — ${booking.size}`);
    return sendJson(res, 201, { booking: { id: booking.id, needed_on: booking.needed_on, size: booking.size } });
  }

  if (pathname === '/api/cakes' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, {
      bookings: cakes.list(url.searchParams.get('show') || 'upcoming'),
      counts: cakes.counts(),
    });
  }

  if (pathname === '/api/cakes/counts' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, cakes.counts());
  }

  const cakePhotoMatch = pathname.match(/^\/api\/cakes\/(\d+)\/photo$/);
  if (cakePhotoMatch && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    const booking = cakes.get(Number(cakePhotoMatch[1]));
    const abs = booking && booking.photo ? cakes.photoPath(booking.photo) : null;
    if (!abs) return sendJson(res, 404, { error: 'No photo for that booking.' });
    const buf = fs.readFileSync(abs);
    const info = imagesize.fromBuffer(buf);
    return send(res, 200, buf, {
      'Content-Type': info ? `image/${info.type}` : 'application/octet-stream',
      'Cache-Control': 'private, no-store',
    });
  }

  const cakeMatch = pathname.match(/^\/api\/cakes\/(\d+)$/);
  if (cakeMatch && (method === 'PATCH' || method === 'PUT')) {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    const booking = cakes.update(Number(cakeMatch[1]), await readJson(req));
    if (!booking) return sendJson(res, 404, { error: 'That booking no longer exists.' });
    return sendJson(res, 200, { booking });
  }

  if (pathname === '/api/cake-settings' && method === 'GET') {
    if (!requireApiAuth(req, res)) return;
    return sendJson(res, 200, cakes.settings());
  }

  if (pathname === '/api/cake-settings' && (method === 'PUT' || method === 'PATCH')) {
    if (!requireApiAuth(req, res, { csrf: true })) return;
    return sendJson(res, 200, cakes.updateSettings(await readJson(req)));
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
    if (status < 500 && err.body) return sendJson(res, status, err.body);
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

  // Photos uploaded for a cake request that was never sent are cleared after a day.
  const sweepPhotos = () => {
    try { cakes.removeStrayPhotos(); } catch (err) { console.warn('Could not clear stray cake photos:', err.message); }
  };
  sweepPhotos();
  setInterval(sweepPhotos, 60 * 60 * 1000).unref();

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
