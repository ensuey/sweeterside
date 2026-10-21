'use strict';
/* Menu admin dashboard. Talks to the JSON API; every write carries the
   session's CSRF token. */

const state = {
  csrf: null,
  items: [],
  categories: [],
  images: [],
  editingId: null,      // null = creating
  editingCategoryId: null,
  pendingDelete: null,  // { kind: 'item' | 'category', id }
  orders: [],
  ordersShow: 'active', // 'active' | 'finished'
  newestOrderId: null,  // to spot orders that arrive while the page is open
};

const ORDER_STATUS = {
  new: 'New',
  preparing: 'Preparing',
  delivering: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const ORDER_POLL_MS = 20000;

const $ = (id) => document.getElementById(id);
const groups = $('groups');
const cats = $('cats');
const editor = $('editor');
const catEditor = $('cat-editor');
const confirmDialog = $('confirm');

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

/* ---------------------------- rendering ---------------------------- */

function shotStyle(item) {
  if (item.crop_w == null || item.crop_h == null) return { cls: 'shot shot--plain', style: '' };
  return {
    cls: 'shot',
    style: `--x:${item.crop_x}; --y:${item.crop_y}; --w:${item.crop_w}; --h:${item.crop_h}`,
  };
}

function rowHtml(item) {
  const { cls, style } = shotStyle(item);
  return `
    <li class="row-item" data-id="${item.id}">
      <div class="${cls} row-item__shot" style="${style}">
        <img src="/${encPath(item.image)}" alt="">
      </div>
      <div class="row-item__main">
        <span class="row-item__name"></span>
        <span class="row-item__meta">Php ${item.price}</span>
      </div>
      <div class="row-item__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-action="edit">Edit</button>
        <button class="btn btn--danger-ghost btn--sm" type="button" data-action="delete">Delete</button>
      </div>
    </li>`;
}

function render() {
  groups.innerHTML = state.categories.map((cat) => {
    const items = state.items.filter((i) => i.category_id === cat.id);
    if (!items.length) return '';
    return `
      <section class="group">
        <h3 class="group__title">${esc(cat.name)} <span class="group__n">${items.length}</span></h3>
        <ul class="rows">${items.map(rowHtml).join('')}</ul>
      </section>`;
  }).join('');

  // Names are set as text, never interpolated into the HTML above.
  state.items.forEach((item) => {
    const row = groups.querySelector(`.row-item[data-id="${item.id}"] .row-item__name`);
    if (row) row.textContent = item.name;
  });

  const total = state.items.length;
  $('summary').textContent = total === 0
    ? 'No items on the menu.'
    : `${total} item${total === 1 ? '' : 's'} on the live menu.`;
  $('empty').hidden = total > 0;
}

function categoryRowHtml(cat, index, count) {
  return `
    <li class="row-item" data-cat-id="${cat.id}">
      <div class="row-item__main">
        <span class="row-item__name">${esc(cat.name)}</span>
        <span class="row-item__meta">Button: ${esc(cat.label)} · ${plural(cat.item_count, 'item')}</span>
      </div>
      <div class="row-item__actions">
        <button class="btn btn--ghost btn--sm row-item__move" type="button" data-action="up"
          aria-label="Move ${esc(cat.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn--ghost btn--sm row-item__move" type="button" data-action="down"
          aria-label="Move ${esc(cat.name)} down" ${index === count - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn--ghost btn--sm" type="button" data-action="edit">Edit</button>
        <button class="btn btn--danger-ghost btn--sm" type="button" data-action="delete">Delete</button>
      </div>
    </li>`;
}

function renderCategories() {
  const list = state.categories;
  cats.innerHTML = list.map((cat, i) => categoryRowHtml(cat, i, list.length)).join('');
  $('cats-summary').textContent = list.length === 0
    ? 'No categories yet.'
    : `${plural(list.length, 'category')}. Empty ones are hidden from customers.`;
  $('cats-empty').hidden = list.length > 0;
}

function fillCategoryOptions(selected) {
  const sel = $('f-category');
  sel.innerHTML = state.categories
    .map((cat) => `<option value="${cat.id}">${esc(cat.name)}</option>`)
    .join('');
  if (selected != null) sel.value = String(selected);
}

/* ---------------------------- editor ---------------------------- */

function imageMeta(path) {
  return state.images.find((i) => i.path === path) || null;
}

function fillImageOptions(selected) {
  const sel = $('f-image');
  sel.innerHTML = state.images
    .map((img) => `<option value="${img.path}">${img.path} (${img.width}×${img.height})</option>`)
    .join('');
  if (selected) sel.value = selected;
}

function updatePreview() {
  const shot = $('preview-shot');
  const img = $('preview-img');
  const imagePath = $('f-image').value;
  const meta = imageMeta(imagePath);

  img.src = imagePath ? `/${encPath(imagePath)}` : '';
  $('preview-name').textContent = $('f-name').value || 'Item name';
  $('preview-price').textContent = `Php ${$('f-price').value || 0}`;

  $('crop-note').textContent = meta
    ? `Photo is ${meta.width}×${meta.height} pixels.`
    : '';

  const x = $('f-cx').value, y = $('f-cy').value;
  const w = $('f-cw').value, h = $('f-ch').value;

  if (w && h) {
    shot.className = 'shot';
    shot.style.setProperty('--x', x || 0);
    shot.style.setProperty('--y', y || 0);
    shot.style.setProperty('--w', w);
    shot.style.setProperty('--h', h);
  } else {
    shot.className = 'shot shot--plain';
    shot.removeAttribute('style');
  }
}

function clearFieldErrors(dialog = editor) {
  dialog.querySelectorAll('[data-err]').forEach((el) => { el.hidden = true; el.textContent = ''; });
  dialog.querySelector('.alert').hidden = true;
}

function showFieldErrors(dialog, fields) {
  Object.entries(fields || {}).forEach(([name, message]) => {
    const el = dialog.querySelector(`[data-err="${name}"]`);
    if (el) { el.textContent = message; el.hidden = false; }
  });
}

function openEditor(item) {
  state.editingId = item ? item.id : null;
  clearFieldErrors();
  $('upload-status').textContent = '';
  $('editor-title').textContent = item ? 'Edit item' : 'Add item';
  $('editor-save').textContent = item ? 'Save changes' : 'Add to menu';

  $('f-name').value = item ? item.name : '';
  $('f-price').value = item ? item.price : '';
  fillCategoryOptions(item ? item.category_id : state.categories[0].id);
  $('f-alt').value = item ? item.alt : '';
  fillImageOptions(item ? item.image : (state.images[0] && state.images[0].path));
  $('f-cx').value = item && item.crop_x != null ? item.crop_x : '';
  $('f-cy').value = item && item.crop_y != null ? item.crop_y : '';
  $('f-cw').value = item && item.crop_w != null ? item.crop_w : '';
  $('f-ch').value = item && item.crop_h != null ? item.crop_h : '';

  updatePreview();
  editor.showModal();
  $('f-name').focus();
}

async function saveItem(event) {
  event.preventDefault();
  clearFieldErrors();

  const payload = {
    name: $('f-name').value,
    price: $('f-price').value,
    category_id: $('f-category').value,
    image: $('f-image').value,
    alt: $('f-alt').value,
    crop_x: $('f-cx').value,
    crop_y: $('f-cy').value,
    crop_w: $('f-cw').value,
    crop_h: $('f-ch').value,
  };

  const save = $('editor-save');
  save.disabled = true;

  try {
    if (state.editingId === null) {
      await api('/api/items', { method: 'POST', body: payload });
      toast('Item added to the menu.');
    } else {
      await api(`/api/items/${state.editingId}`, { method: 'PUT', body: payload });
      toast('Changes saved.');
    }
    editor.close();
    await loadAll();
  } catch (err) {
    if (err.fields) showFieldErrors(editor, err.fields);
    const box = $('editor-error');
    box.textContent = err.message;
    box.hidden = false;
  } finally {
    save.disabled = false;
  }
}

async function uploadPhoto(file) {
  if (!file) return;
  const status = $('upload-status');
  status.textContent = 'Uploading…';

  try {
    const res = await fetch('/api/images', {
      method: 'POST',
      headers: { 'X-CSRF-Token': state.csrf },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');

    await loadImages();
    fillImageOptions(data.path);
    // A fresh upload is shown whole unless the user crops it.
    ['f-cx', 'f-cy', 'f-cw', 'f-ch'].forEach((id) => { $(id).value = ''; });
    updatePreview();
    status.textContent = `Uploaded (${data.width}×${data.height}).`;
  } catch (err) {
    status.textContent = err.message;
  }
}

/* ---------------------------- orders ---------------------------- */

function money(n) {
  return `Php ${Number(n).toLocaleString('en-US')}`;
}

/** SQLite stores datetime('now') in UTC without a zone marker. */
function orderTime(sqlTime) {
  const d = new Date(`${String(sqlTime).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay ? clock : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock}`;
  if (mins < 1) return `${when} · just now`;
  if (mins < 60) return `${when} · ${mins} min ago`;
  return when;
}

// Every field below was typed by a customer on the public menu: escape all of it.
function orderHtml(o) {
  const options = Object.entries(ORDER_STATUS)
    .map(([value, label]) => `<option value="${value}"${value === o.status ? ' selected' : ''}>${label}</option>`)
    .join('');
  const lines = o.items
    .map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><span>${money(l.price * l.qty)}</span></li>`)
    .join('');
  const change = o.change_due === 0
    ? 'Exact amount, no change needed'
    : `Bring ${money(o.change_due)} change`;

  return `
    <li class="order" data-order-id="${o.id}" data-status="${esc(o.status)}">
      <div class="order__head">
        <span class="order__id">#${o.id}</span>
        <span class="order__time">${esc(orderTime(o.created_at))}</span>
        <label class="vh" for="status-${o.id}">Status of order ${o.id}</label>
        <select class="order__status" id="status-${o.id}" data-status-select>${options}</select>
      </div>
      <div class="order__who">
        <span class="order__name">${esc(o.customer_name)}</span>
        <a class="order__phone" href="tel:${esc(o.phone)}">${esc(o.phone)}</a>
        <span class="order__addr">${esc(o.address)}</span>
      </div>
      <ul class="order__items">${lines}</ul>
      <dl class="order__sum">
        <dt>Subtotal</dt><dd>${money(o.subtotal)}</dd>
        <dt>Delivery fee</dt><dd>${money(o.delivery_fee)}</dd>
        <dt class="is-total">Total</dt><dd class="is-total">${money(o.total)}</dd>
        <dt>Customer pays with</dt><dd>${money(o.cash)}</dd>
        <dd class="order__change">${change}</dd>
      </dl>
    </li>`;
}

function renderOrders(counts) {
  const list = $('orders');
  list.innerHTML = state.orders.map(orderHtml).join('');

  const active = counts.new + counts.preparing + counts.delivering;
  $('n-active').textContent = active;
  $('n-finished').textContent = counts.completed + counts.cancelled;

  const empty = $('orders-empty');
  empty.hidden = state.orders.length > 0;
  empty.textContent = state.ordersShow === 'active'
    ? 'No orders waiting. New ones appear here on their own.'
    : 'No finished orders yet.';

  $('orders-summary').textContent = counts.new
    ? `${plural(counts.new, 'new order')} to confirm.`
    : active ? `${plural(active, 'order')} in progress.` : 'Nothing waiting right now.';
  document.title = counts.new ? `(${counts.new}) Menu admin — Sweeter Side` : 'Menu admin — Sweeter Side';
}

async function loadOrders({ announce = false } = {}) {
  const { orders, counts } = await api(`/api/orders?show=${state.ordersShow}`);

  // Orders can arrive in any tab; track the newest id across both.
  const newest = orders.reduce((max, o) => Math.max(max, o.id), 0);
  if (announce && state.newestOrderId !== null && newest > state.newestOrderId && state.ordersShow === 'active') {
    const fresh = orders.filter((o) => o.id > state.newestOrderId);
    toast(fresh.length === 1
      ? `New order #${fresh[0].id} from ${fresh[0].customer_name}.`
      : `${fresh.length} new orders.`);
  }
  if (state.ordersShow === 'active') {
    state.newestOrderId = Math.max(state.newestOrderId || 0, newest);
  }

  state.orders = orders;
  // Do not rebuild the list under someone choosing a status.
  if (!document.activeElement || !document.activeElement.matches('[data-status-select]')) {
    renderOrders(counts);
  }
}

async function changeStatus(select) {
  const id = Number(select.closest('.order').dataset.orderId);
  const previous = state.orders.find((o) => o.id === id);
  select.disabled = true;
  try {
    await api(`/api/orders/${id}`, { method: 'PATCH', body: { status: select.value } });
    toast(`Order #${id}: ${ORDER_STATUS[select.value]}.`);
    select.blur();
    await loadOrders();
  } catch (err) {
    if (previous) select.value = previous.status;
    toast(err.message, 'error');
  } finally {
    select.disabled = false;
  }
}

async function loadSettings() {
  const { delivery_fee } = await api('/api/settings');
  $('fee').value = delivery_fee;
}

async function saveFee(event) {
  event.preventDefault();
  const err = $('fee-err');
  err.hidden = true;
  $('fee-save').disabled = true;
  try {
    const { delivery_fee } = await api('/api/settings', {
      method: 'PUT', body: { delivery_fee: $('fee').value },
    });
    $('fee').value = delivery_fee;
    toast(delivery_fee === 0
      ? 'Delivery is now free on the menu.'
      : `Delivery fee is now ${money(delivery_fee)} on the menu.`);
  } catch (e) {
    err.textContent = (e.fields && e.fields.delivery_fee) || e.message;
    err.hidden = false;
  } finally {
    $('fee-save').disabled = false;
  }
}

function pollOrders() {
  setInterval(() => {
    if (document.visibilityState === 'visible') loadOrders({ announce: true }).catch(() => {});
  }, ORDER_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadOrders({ announce: true }).catch(() => {});
  });
}

/* ---------------------------- categories ---------------------------- */

function openCategoryEditor(cat) {
  state.editingCategoryId = cat ? cat.id : null;
  clearFieldErrors(catEditor);
  $('cat-editor-title').textContent = cat ? 'Edit category' : 'Add category';
  $('cat-save').textContent = cat ? 'Save changes' : 'Add category';
  $('c-name').value = cat ? cat.name : '';
  // Show a blank label when it just mirrors the name, so renaming carries it along.
  $('c-label').value = cat && cat.label !== cat.name ? cat.label : '';
  catEditor.showModal();
  $('c-name').focus();
}

async function saveCategory(event) {
  event.preventDefault();
  clearFieldErrors(catEditor);

  const payload = { name: $('c-name').value, label: $('c-label').value };
  const save = $('cat-save');
  save.disabled = true;

  try {
    if (state.editingCategoryId === null) {
      await api('/api/categories', { method: 'POST', body: payload });
      toast('Category added.');
    } else {
      await api(`/api/categories/${state.editingCategoryId}`, { method: 'PUT', body: payload });
      toast('Category saved.');
    }
    catEditor.close();
    await loadAll();
  } catch (err) {
    if (err.fields) showFieldErrors(catEditor, err.fields);
    const box = $('cat-error');
    box.textContent = err.message;
    box.hidden = false;
  } finally {
    save.disabled = false;
  }
}

async function moveCategory(cat, delta) {
  const ids = state.categories.map((c) => c.id);
  const from = ids.indexOf(cat.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];

  try {
    await api('/api/categories/reorder', { method: 'POST', body: { ids } });
    await loadAll();
    // Keep focus on the same arrow so repeated moves are easy from the keyboard.
    const btn = cats.querySelector(`[data-cat-id="${cat.id}"] [data-action="${delta < 0 ? 'up' : 'down'}"]`);
    if (btn && !btn.disabled) btn.focus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------------------- delete ---------------------------- */

function askDelete(item) {
  state.pendingDelete = { kind: 'item', id: item.id };
  $('confirm-title').textContent = 'Delete this item?';
  $('confirm-text').textContent =
    `“${item.name}” will be removed from the customer menu straight away. This cannot be undone.`;
  confirmDialog.showModal();
}

function askDeleteCategory(cat) {
  if (cat.item_count > 0) {
    toast(`“${cat.name}” still has ${plural(cat.item_count, 'item')}. Move or delete them first.`, 'warn');
    return;
  }
  state.pendingDelete = { kind: 'category', id: cat.id };
  $('confirm-title').textContent = 'Delete this category?';
  $('confirm-text').textContent = `“${cat.name}” has no items, so the menu will not change.`;
  confirmDialog.showModal();
}

async function doDelete() {
  const pending = state.pendingDelete;
  if (!pending) return;
  $('confirm-ok').disabled = true;
  try {
    const base = pending.kind === 'item' ? '/api/items' : '/api/categories';
    await api(`${base}/${pending.id}`, { method: 'DELETE' });
    confirmDialog.close();
    toast(pending.kind === 'item' ? 'Item deleted.' : 'Category deleted.');
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('confirm-ok').disabled = false;
    state.pendingDelete = null;
  }
}

/* ---------------------------- boot ---------------------------- */

/** Items and categories change together (item counts), so reload both. */
async function loadAll() {
  const [{ items }, { categories }] = await Promise.all([
    api('/api/items'), api('/api/categories'),
  ]);
  state.items = items;
  state.categories = categories;
  render();
  renderCategories();
}

async function loadImages() {
  const { images } = await api('/api/images');
  state.images = images;
}

async function boot() {
  try {
    const session = await api('/api/session');
    state.csrf = session.csrf;
    $('who').textContent = session.email;
    await Promise.all([loadImages(), loadAll(), loadOrders(), loadSettings()]);
    pollOrders();
  } catch (err) {
    pageError(err.message);
  }
}

/* ---------------------------- events ---------------------------- */

$('add').addEventListener('click', () => {
  if (!state.categories.length) {
    toast('Add a category first — every item needs one.', 'warn');
    $('add-category').focus();
    return;
  }
  if (!state.images.length) {
    toast('Upload a photo first — add one from inside the item form.', 'warn');
  }
  openEditor(null);
});

groups.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const id = Number(btn.closest('.row-item').dataset.id);
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  if (btn.dataset.action === 'edit') openEditor(item);
  if (btn.dataset.action === 'delete') askDelete(item);
});

cats.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const id = Number(btn.closest('.row-item').dataset.catId);
  const cat = state.categories.find((c) => c.id === id);
  if (!cat) return;
  if (btn.dataset.action === 'edit') openCategoryEditor(cat);
  if (btn.dataset.action === 'delete') askDeleteCategory(cat);
  if (btn.dataset.action === 'up') moveCategory(cat, -1);
  if (btn.dataset.action === 'down') moveCategory(cat, 1);
});

$('orders').addEventListener('change', (event) => {
  if (event.target.matches('[data-status-select]')) changeStatus(event.target);
});

document.querySelectorAll('.tab[data-show]').forEach((tab) => {
  tab.addEventListener('click', async () => {
    state.ordersShow = tab.dataset.show;
    document.querySelectorAll('.tab[data-show]').forEach((t) => {
      t.setAttribute('aria-pressed', String(t === tab));
    });
    try { await loadOrders(); } catch (err) { toast(err.message, 'error'); }
  });
});

$('fee-form').addEventListener('submit', saveFee);

$('add-category').addEventListener('click', () => openCategoryEditor(null));
$('cat-form').addEventListener('submit', saveCategory);
$('cat-close').addEventListener('click', () => catEditor.close());
$('cat-cancel').addEventListener('click', () => catEditor.close());

$('editor-form').addEventListener('submit', saveItem);
$('editor-close').addEventListener('click', () => editor.close());
$('editor-cancel').addEventListener('click', () => editor.close());
$('confirm-cancel').addEventListener('click', () => confirmDialog.close());
$('confirm-ok').addEventListener('click', doDelete);

['f-name', 'f-price', 'f-image', 'f-cx', 'f-cy', 'f-cw', 'f-ch']
  .forEach((id) => $(id).addEventListener('input', updatePreview));
$('f-image').addEventListener('change', updatePreview);

$('crop-clear').addEventListener('click', () => {
  ['f-cx', 'f-cy', 'f-cw', 'f-ch'].forEach((id) => { $(id).value = ''; });
  updatePreview();
});

$('f-upload').addEventListener('change', (event) => {
  uploadPhoto(event.target.files[0]);
  event.target.value = '';
});

$('signout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* sign out anyway */ }
  window.location.assign('/admin/login');
});

boot();
