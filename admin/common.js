'use strict';
/* Shared by both admin pages (orders, items). Loaded first; the page script
   adds its own fields to `state` and calls adminBoot(). Every write carries
   the session's CSRF token. */

const state = { csrf: null };

const $ = (id) => document.getElementById(id);

/* ---------------------------- utilities ---------------------------- */

function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast toast--${kind}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 4000);
}

function pageError(message) {
  const el = $('page-error');
  if (!message) { el.hidden = true; return; }
  el.textContent = message;
  el.hidden = false;
}

function encPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

/** For admin-entered text that has to go into an HTML string. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "1 item" / "3 items"; words like category pass their plural. */
function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;

  const res = await fetch(path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    window.location.assign('/admin/login');
    throw new Error('Signed out');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.fields = data.fields;
    throw err;
  }
  if (data.warning) toast(data.warning, 'warn');
  return data;
}

/** ₱1,234 or, with centavos, ₱1,234.50 */
function money(n) {
  const v = Number(n);
  const cents = Math.round(v * 100) % 100 !== 0;
  return `₱${v.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** The same, from centavos. */
function moneyC(cents) {
  return money(Number(cents) / 100);
}

/** New cake bookings, shown next to "Cakes" in the nav on every page. */
function showCakeCount(n) {
  const badge = $('nav-cakes-n');
  if (!badge) return;
  badge.textContent = n;
  badge.hidden = !n;
  badge.setAttribute('aria-label', `${plural(n, 'new booking')}`);
}

/** "Shop open" / "Closing soon" / "Shop closed" in the top bar, linking to the
    switch. It shows what customers see: the switch and the opening hours together. */
function showShopPill(s) {
  const pill = $('shop-pill');
  if (!pill) return;
  pill.textContent = !s.open_now ? 'Shop closed' : s.closing_soon ? 'Closing soon' : 'Shop open';
  pill.dataset.open = s.open_now ? '1' : '0';
  pill.hidden = false;
}

/** Sign in check, then the page's own loading. */
async function adminBoot(load) {
  try {
    const session = await api('/api/session');
    state.csrf = session.csrf;
    if ($('who')) $('who').textContent = session.email;
    api('/api/cakes/counts').then((c) => showCakeCount(c.new)).catch(() => {});
    api('/api/settings').then(showShopPill).catch(() => {});
    await load();
  } catch (err) {
    pageError(err.message);
  }
}

// On a phone the page links scroll sideways; bring this page's link into view.
// Again whenever any link changes size: the web font arrives later and makes
// the links wider, which moves this one along.
const currentLink = document.querySelector('.topbar__nav [aria-current="page"]');
function showCurrentLink() {
  const nav = currentLink.parentElement;
  const left = currentLink.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
  nav.scrollLeft = left - (nav.clientWidth - currentLink.offsetWidth) / 2;
}
if (currentLink) {
  showCurrentLink();
  if ('ResizeObserver' in window) {
    const watch = new ResizeObserver(showCurrentLink);
    for (const a of currentLink.parentElement.children) watch.observe(a);
  }
}

// The POS has no sign-out button: the counter tablet stays signed in.
if ($('signout')) {
  $('signout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* sign out anyway */ }
    window.location.assign('/admin/login');
  });
}
