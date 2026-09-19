'use strict';
/* Menu admin dashboard. Talks to the JSON API; every write carries the
   session's CSRF token. */

const CATEGORY_LABEL = { drinks: 'Frappe Based Drinks', food: 'Food' };

const state = {
  csrf: null,
  items: [],
  images: [],
  editingId: null,      // null = creating
  pendingDeleteId: null,
};

const $ = (id) => document.getElementById(id);
const groups = $('groups');
const editor = $('editor');
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
  const cats = ['drinks', 'food'];
  groups.innerHTML = cats.map((cat) => {
    const items = state.items.filter((i) => i.category === cat);
    if (!items.length) return '';
    return `
      <section class="group">
        <h3 class="group__title">${CATEGORY_LABEL[cat]} <span class="group__n">${items.length}</span></h3>
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

function clearFieldErrors() {
  editor.querySelectorAll('[data-err]').forEach((el) => { el.hidden = true; el.textContent = ''; });
  $('editor-error').hidden = true;
}

function showFieldErrors(fields) {
  Object.entries(fields || {}).forEach(([name, message]) => {
    const el = editor.querySelector(`[data-err="${name}"]`);
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
  $('f-category').value = item ? item.category : 'drinks';
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
    category: $('f-category').value,
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
    await loadItems();
  } catch (err) {
    if (err.fields) showFieldErrors(err.fields);
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

/* ---------------------------- delete ---------------------------- */

function askDelete(item) {
  state.pendingDeleteId = item.id;
  $('confirm-text').textContent =
    `“${item.name}” will be removed from the customer menu straight away. This cannot be undone.`;
  confirmDialog.showModal();
}

async function doDelete() {
  const id = state.pendingDeleteId;
  if (id == null) return;
  $('confirm-ok').disabled = true;
  try {
    await api(`/api/items/${id}`, { method: 'DELETE' });
    confirmDialog.close();
    toast('Item deleted.');
    await loadItems();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('confirm-ok').disabled = false;
    state.pendingDeleteId = null;
  }
}

/* ---------------------------- boot ---------------------------- */

async function loadItems() {
  const { items } = await api('/api/items');
  state.items = items;
  render();
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
    await loadImages();
    await loadItems();
  } catch (err) {
    pageError(err.message);
  }
}

/* ---------------------------- events ---------------------------- */

$('add').addEventListener('click', () => {
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
