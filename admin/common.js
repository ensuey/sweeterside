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

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
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

function money(n) {
  return `Php ${Number(n).toLocaleString('en-US')}`;
}

/** New cake bookings, shown next to "Cakes" in the nav on every page. */
function showCakeCount(n) {
  const badge = $('nav-cakes-n');
  if (!badge) return;
  badge.textContent = n;
  badge.hidden = !n;
  badge.setAttribute('aria-label', `${plural(n, 'new booking')}`);
}

/** "Shop open" / "Shop closed" in the top bar, linking to the switch. */
function showShopPill(open) {
  const pill = $('shop-pill');
  if (!pill) return;
  pill.textContent = open ? 'Shop open' : 'Shop closed';
  pill.dataset.open = open ? '1' : '0';
  pill.hidden = false;
}

/** Sign in check, then the page's own loading. */
async function adminBoot(load) {
  try {
    const session = await api('/api/session');
    state.csrf = session.csrf;
    $('who').textContent = session.email;
    api('/api/cakes/counts').then((c) => showCakeCount(c.new)).catch(() => {});
    api('/api/settings').then((s) => showShopPill(s.shop_open)).catch(() => {});
    await load();
  } catch (err) {
    pageError(err.message);
  }
}

$('signout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* sign out anyway */ }
  window.location.assign('/admin/login');
});
