'use strict';
/* Items page: menu items (with availability and daily limits) and categories. */

Object.assign(state, {
  items: [],
  categories: [],
  images: [],
  editingId: null,      // null = creating
  editingCategoryId: null,
  pendingDelete: null,  // { kind: 'item' | 'category', id }
});

const groups = $('groups');
const cats = $('cats');
const editor = $('editor');
const catEditor = $('cat-editor');
const confirmDialog = $('confirm');

/* ---------------------------- rendering ---------------------------- */

function shotStyle(item) {
  if (item.crop_w == null || item.crop_h == null) return { cls: 'shot shot--plain', style: '' };
  return {
    cls: 'shot',
    style: `--x:${item.crop_x}; --y:${item.crop_y}; --w:${item.crop_w}; --h:${item.crop_h}`,
  };
}

const AVAILABILITY_LABEL = { available: 'Available', unavailable: 'Not available', sold_out: 'Sold out' };

/** What sold today looks like next to the limit, e.g. "7 / 20 sold today". */
function todayText(item) {
  if (item.daily_limit === null) return `${item.sold_today} sold today`;
  if (item.remaining === 0) return `${item.sold_today} / ${item.daily_limit} sold · limit reached`;
  return `${item.sold_today} / ${item.daily_limit} sold today`;
}

/** "★ Best seller" and "On sale ~~129~~ 103" chips for a row. */
function promoChips(item) {
  const chips = [];
  if (item.best_seller) chips.push('<span class="chip-best">★ Best seller</span>');
  if (item.sale_price < item.price) {
    chips.push(`<span class="chip-sale">On sale <s>${item.price}</s> ${item.sale_price}</span>`);
  }
  return chips.join('');
}

/** What the editor's sale fields would make the price, or null for no sale. */
function editorSalePrice() {
  const price = Number($('f-price').value);
  const kind = $('f-sale-type').value;
  const value = Number($('f-sale-value').value);
  if (!kind || !Number.isInteger(price) || !Number.isInteger(value) || value < 1) return null;
  if (kind === 'percent') return value > 90 ? null : Math.round((price * (100 - value)) / 100);
  return value >= price ? null : price - value;
}

function rowHtml(item) {
  const { cls, style } = shotStyle(item);
  const options = Object.entries(AVAILABILITY_LABEL)
    .map(([value, label]) => `<option value="${value}"${value === item.availability ? ' selected' : ''}>${label}</option>`)
    .join('');
  const limitReached = item.daily_limit !== null && item.remaining === 0;
  return `
    <li class="row-item" data-id="${item.id}" data-availability="${esc(item.availability)}">
      <div class="${cls} row-item__shot" style="${style}">
        <img src="/${encPath(item.image)}" alt="">
      </div>
      <div class="row-item__main">
        <span class="row-item__name"></span>
        <span class="row-item__meta">Php ${item.price}</span>
        <span class="row-item__chips">${promoChips(item)}</span>
        <span class="row-item__today${limitReached ? ' is-full' : ''}">${todayText(item)}</span>
      </div>
      <div class="row-item__stock">
        <label class="stock__field">
          <span>Availability</span>
          <select data-stock="availability">${options}</select>
        </label>
        <label class="stock__field">
          <span>Max per day</span>
          <input data-stock="daily_limit" type="number" min="1" max="9999" step="1" inputmode="numeric"
            placeholder="No limit" value="${item.daily_limit ?? ''}">
        </label>
      </div>
      <div class="row-item__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-action="edit">Edit</button>
        <button class="btn btn--danger-ghost btn--sm" type="button" data-action="delete">Delete</button>
      </div>
    </li>`;
}

/* ---------------------------- stock ---------------------------- */

/** Save availability and the daily limit as soon as either changes. */
async function saveStock(row) {
  const id = Number(row.dataset.id);
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const select = row.querySelector('[data-stock="availability"]');
  const limit = row.querySelector('[data-stock="daily_limit"]');
  const body = { availability: select.value, daily_limit: limit.value.trim() };

  select.disabled = true;
  limit.disabled = true;
  try {
    const { item: saved } = await api(`/api/items/${id}/stock`, { method: 'PATCH', body });
    Object.assign(item, saved);
    const limitText = saved.daily_limit === null ? 'no daily limit' : `max ${saved.daily_limit} a day`;
    toast(`${saved.name}: ${AVAILABILITY_LABEL[saved.availability].toLowerCase()}, ${limitText}.`);
  } catch (err) {
    toast(err.fields ? Object.values(err.fields).join(' ') : err.message, 'error');
  } finally {
    select.disabled = false;
    limit.disabled = false;
    render();
  }
}

/** Refresh today's counts, unless someone is typing in a row. */
async function refreshItems() {
  if (document.activeElement && document.activeElement.matches('[data-stock]')) return;
  try { await loadAll(); } catch { /* the next refresh will try again */ }
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
  const hidden = state.items.filter((i) => i.availability === 'unavailable').length;
  const soldOut = state.items.filter((i) => i.availability !== 'unavailable' && i.sold_out).length;
  const notes = [];
  if (soldOut) notes.push(`${soldOut} sold out`);
  if (hidden) notes.push(`${hidden} hidden`);
  $('summary').textContent = total === 0
    ? 'No items on the menu.'
    : `${plural(total, 'item')}${notes.length ? ` · ${notes.join(' · ')}` : ''}. Counts are for today, Manila time.`;
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
  const sale = editorSalePrice();
  const kind = $('f-sale-type').value;
  $('f-sale-value').disabled = !kind;
  $('sale-unit').textContent = kind === 'percent' ? '(%)' : kind === 'amount' ? '(Php)' : '';
  $('sale-note').textContent = sale === null ? '' : `Sale price: Php ${sale} (was Php ${$('f-price').value})`;
  $('preview-price').textContent = sale === null
    ? `Php ${$('f-price').value || 0}`
    : `Php ${sale}  (was ${$('f-price').value})`;

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
  $('f-best').checked = !!(item && item.best_seller);
  $('f-sale-type').value = item ? item.sale_type : '';
  $('f-sale-value').value = item && item.sale_value != null ? item.sale_value : '';

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
    best_seller: $('f-best').checked,
    sale_type: $('f-sale-type').value,
    sale_value: $('f-sale-type').value ? $('f-sale-value').value : '',
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

/* ---------------------------- loading ---------------------------- */

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

// A select saves on change; the number field saves when it is changed and left.
groups.addEventListener('change', (event) => {
  if (event.target.matches('[data-stock]')) saveStock(event.target.closest('.row-item'));
});

// Today's counts move as orders come in.
setInterval(() => { if (document.visibilityState === 'visible') refreshItems(); }, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshItems();
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

$('add-category').addEventListener('click', () => openCategoryEditor(null));
$('cat-form').addEventListener('submit', saveCategory);
$('cat-close').addEventListener('click', () => catEditor.close());
$('cat-cancel').addEventListener('click', () => catEditor.close());

$('editor-form').addEventListener('submit', saveItem);
$('editor-close').addEventListener('click', () => editor.close());
$('editor-cancel').addEventListener('click', () => editor.close());
$('confirm-cancel').addEventListener('click', () => confirmDialog.close());
$('confirm-ok').addEventListener('click', doDelete);

['f-name', 'f-price', 'f-image', 'f-cx', 'f-cy', 'f-cw', 'f-ch', 'f-sale-value']
  .forEach((id) => $(id).addEventListener('input', updatePreview));
$('f-image').addEventListener('change', updatePreview);
$('f-sale-type').addEventListener('change', updatePreview);

$('crop-clear').addEventListener('click', () => {
  ['f-cx', 'f-cy', 'f-cw', 'f-ch'].forEach((id) => { $(id).value = ''; });
  updatePreview();
});

$('f-upload').addEventListener('change', (event) => {
  uploadPhoto(event.target.files[0]);
  event.target.value = '';
});

adminBoot(() => Promise.all([loadImages(), loadAll()]));
