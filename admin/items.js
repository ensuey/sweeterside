'use strict';
/* Items page: menu items (with availability, daily limits and stock counts),
   categories, option groups and ingredients. */

Object.assign(state, {
  items: [],
  categories: [],
  optionGroups: [],
  ingredients: [],
  editingGroupId: null,
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

/** "★ Best seller", "♥ Must try", "↗ Trending" and "On sale ~~129~~ 103" chips for a row. */
function promoChips(item) {
  const chips = [];
  if (item.best_seller) chips.push('<span class="chip-best">★ Best seller</span>');
  if (item.must_try) chips.push('<span class="chip-must">♥ Must try</span>');
  if (item.trending) chips.push('<span class="chip-trend">↗ Trending</span>');
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

/** The Stock button: "12 left", "0 left" or "Not counted". */
function stockLabel(item) {
  return item.stock ? `${Math.max(0, item.stock.left)} left` : 'Not counted';
}

function rowHtml(item) {
  const { cls, style } = shotStyle(item);
  const options = Object.entries(AVAILABILITY_LABEL)
    .map(([value, label]) => `<option value="${value}"${value === item.availability ? ' selected' : ''}>${label}</option>`)
    .join('');
  const limitReached = item.daily_limit !== null && item.remaining === 0;
  const stockOut = item.stock && item.stock.left <= 0;
  const missing = item.missing_ingredients || [];
  return `
    <li class="row-item" data-id="${item.id}" data-availability="${esc(item.availability)}">
      <div class="${cls} row-item__shot" style="${style}">
        <img src="/${encPath(item.image)}" alt="">
      </div>
      <div class="row-item__main">
        <span class="row-item__name"></span>
        <span class="row-item__meta">₱${item.price}</span>
        <span class="row-item__chips">${promoChips(item)}</span>
        <span class="row-item__today${limitReached ? ' is-full' : ''}">${todayText(item)}</span>
        ${missing.length ? `<span class="row-item__out">Sold out: ${esc(missing.join(', '))} ${missing.length === 1 ? 'is' : 'are'} out</span>` : ''}
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
        <div class="stock__field">
          <span>In stock</span>
          <button class="stock__btn${stockOut ? ' is-out' : ''}${item.stock ? '' : ' is-off'}" type="button" data-action="stock">${stockLabel(item)}</button>
        </div>
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

/** Refresh today's counts, unless someone is typing in a row or changing stock. */
async function refreshItems() {
  if (document.activeElement && document.activeElement.matches('[data-stock], .ing__rename input')) return;
  if ($('stock-dialog').open) return;
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
  renderHealth();
}

/* ---------------------------- menu health ---------------------------- */

// Checks for items that would sell better with a little more.
const HEALTH_CHECKS = [
  {
    id: 'photo', title: 'No photo of its own',
    hint: 'These show the logo. A real photo helps people choose.',
    test: (item, logo) => item.image === logo,
  },
  {
    id: 'description', title: 'No description',
    hint: 'One short line on the card says what it is, e.g. what is in it.',
    test: (item) => !item.description,
  },
  {
    id: 'size', title: 'No size',
    hint: 'A size such as 16 oz or 10 pcs tells people what they get. Skip it where it does not help.',
    test: (item) => !item.size_label,
  },
];

function renderHealth() {
  const logo = (state.images.find((i) => i.default) || {}).path;
  const shown = state.items.filter((i) => i.availability !== 'unavailable');
  const results = HEALTH_CHECKS.map((c) => ({ ...c, items: shown.filter((i) => c.test(i, logo)) }));
  $('health').hidden = shown.length === 0;
  $('health-checks').innerHTML = results.map((r) => `
    <div class="health__check" data-check="${r.id}">
      <p class="health__label"><strong>${esc(r.title)}:</strong> ${r.items.length ? plural(r.items.length, 'item') : 'none'} ${r.items.length ? `<span class="hint">${esc(r.hint)}</span>` : '<span class="flag flag--good">All good</span>'}</p>
      ${r.items.length ? `<ul class="health__items">${r.items.map((i) => `<li><button class="link-quiet health__edit" type="button" data-health-edit="${i.id}">${esc(i.name)}</button></li>`).join('')}</ul>` : ''}
    </div>`).join('');
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
    : `${plural(list.length, 'category', 'categories')}. Empty ones are hidden from customers.`;
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
    .map((img) => `<option value="${esc(img.path)}">${esc(img.path)} (${img.width}×${img.height})${img.default ? ' (logo, no photo)' : ''}</option>`)
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
  $('sale-unit').textContent = kind === 'percent' ? '(%)' : kind === 'amount' ? '(₱)' : '';
  $('sale-note').textContent = sale === null ? '' : `Sale price: ₱${sale} (was ₱${$('f-price').value})`;
  $('preview-price').textContent = sale === null
    ? `₱${$('f-price').value || 0}`
    : `₱${sale}  (was ₱${$('f-price').value})`;

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
  $('f-desc').value = item ? item.description || '' : '';
  $('f-size').value = item ? item.size_label || '' : '';
  descCount();
  fillGroupChoices(item ? item.option_groups || [] : []);
  fillIngredientChoices(item ? item.ingredients || [] : []);
  // A new item starts on the logo until a photo is uploaded or chosen.
  const logo = state.images.find((i) => i.default);
  fillImageOptions(item ? item.image : (logo || state.images[0] || {}).path);
  $('f-cx').value = item && item.crop_x != null ? item.crop_x : '';
  $('f-cy').value = item && item.crop_y != null ? item.crop_y : '';
  $('f-cw').value = item && item.crop_w != null ? item.crop_w : '';
  $('f-ch').value = item && item.crop_h != null ? item.crop_h : '';
  $('f-best').checked = !!(item && item.best_seller);
  $('f-must').checked = !!(item && item.must_try);
  $('f-trend').checked = !!(item && item.trending);
  $('f-sc').checked = item ? item.sc_eligible !== false : true;
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
    must_try: $('f-must').checked,
    trending: $('f-trend').checked,
    sc_eligible: $('f-sc').checked,
    sale_type: $('f-sale-type').value,
    sale_value: $('f-sale-type').value ? $('f-sale-value').value : '',
    description: $('f-desc').value,
    size_label: $('f-size').value,
    option_groups: [...$('f-groups').querySelectorAll('input:checked')].map((i) => Number(i.value)),
    ingredients: [...$('f-ingredients').querySelectorAll('input:checked')].map((i) => Number(i.value)),
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
    const base = {
      item: '/api/items', category: '/api/categories', group: '/api/option-groups', ingredient: '/api/ingredients',
    }[pending.kind];
    await api(`${base}/${pending.id}`, { method: 'DELETE' });
    confirmDialog.close();
    toast({
      item: 'Item deleted.', category: 'Category deleted.', group: 'Option group deleted.', ingredient: 'Ingredient deleted.',
    }[pending.kind]);
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('confirm-ok').disabled = false;
    state.pendingDelete = null;
  }
}

/* ---------------------------- option groups ---------------------------- */

const ogEditor = $('og-editor');

/** "Pick one, must choose" or "Pick 1 to 3". */
function groupRule(g) {
  if (g.kind === 'single') return g.required ? 'Pick one, must choose' : 'Pick one, optional';
  if (!g.required) return `Pick up to ${g.max}, optional`;
  return g.min === g.max ? `Pick ${g.min}` : `Pick ${g.min} to ${g.max}`;
}

function renderGroups() {
  const list = state.optionGroups;
  $('ogroups').innerHTML = list.map((g) => `
    <li class="row-item" data-group-id="${g.id}">
      <div class="row-item__main">
        <span class="row-item__name">${esc(g.name)}</span>
        <span class="row-item__meta">${esc(groupRule(g))} · ${esc(g.options.map((o) => (o.price ? `${o.name} +${money(o.price)}` : o.name) + (o.available ? '' : ' (off)')).join(', '))}</span>
        <span class="row-item__meta">On ${plural(g.item_ids.length, 'item')}</span>
      </div>
      <div class="row-item__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-action="edit">Edit</button>
        <button class="btn btn--danger-ghost btn--sm" type="button" data-action="delete">Delete</button>
      </div>
    </li>`).join('');
  $('ogroups-empty').hidden = list.length > 0;
}

/** Group tick boxes in the item editor. */
function fillGroupChoices(selected) {
  const box = $('f-groups');
  box.replaceChildren();
  if (!state.optionGroups.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No option groups yet. Add them under Option groups below.';
    box.append(p);
    return;
  }
  for (const g of state.optionGroups) {
    const label = document.createElement('label');
    label.className = 'promo__check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(g.id);
    input.checked = selected.includes(g.id);
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = `(${groupRule(g).toLowerCase()})`;
    label.append(input, ` ${g.name} `, hint);
    box.append(label);
  }
}

function descCount() {
  const n = $('f-desc').value.length;
  $('desc-count').textContent = n ? `${n} of 120` : '';
}

/** One editable option row: name, price, on/off, remove. */
function optionRow(o = { name: '', price: 0, available: true }) {
  const li = document.createElement('li');
  li.className = 'og__opt';
  if (o.id) li.dataset.id = String(o.id);
  const n = document.createElement('input');
  n.type = 'text';
  n.maxLength = 40;
  n.placeholder = 'e.g. Large';
  n.value = o.name;
  n.setAttribute('aria-label', 'Option name');
  n.dataset.f = 'name';
  const p = document.createElement('input');
  p.type = 'number';
  p.min = '0';
  p.max = '10000';
  p.step = '1';
  p.inputMode = 'numeric';
  p.value = String(o.price ?? 0);
  p.setAttribute('aria-label', 'Extra price in pesos');
  p.dataset.f = 'price';
  const on = document.createElement('label');
  on.className = 'og__on';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = o.available !== false;
  box.dataset.f = 'available';
  on.append(box, ' On');
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'btn btn--ghost btn--sm';
  x.textContent = 'Remove';
  x.addEventListener('click', () => li.remove());
  const plus = document.createElement('span');
  plus.className = 'og__plus';
  plus.textContent = '+₱';
  li.append(n, plus, p, on, x);
  return li;
}

function showLimits() {
  const several = $('og-kind').value === 'multiple';
  $('og-limits').hidden = !several;
  $('og-min').disabled = !$('og-required').checked;
}

function openGroupEditor(g) {
  state.editingGroupId = g ? g.id : null;
  clearFieldErrors(ogEditor);
  $('og-editor-title').textContent = g ? 'Edit option group' : 'Add option group';
  $('og-name').value = g ? g.name : '';
  $('og-kind').value = g ? g.kind : 'single';
  $('og-required').checked = g ? g.required : false;
  $('og-min').value = g && g.kind === 'multiple' && g.required ? g.min : '';
  $('og-max').value = g && g.kind === 'multiple' ? g.max : '';
  $('og-opts').replaceChildren(...(g ? g.options : [undefined, undefined]).map((o) => optionRow(o)));
  showLimits();
  ogEditor.showModal();
  $('og-name').focus();
}

async function saveGroup(event) {
  event.preventDefault();
  clearFieldErrors(ogEditor);
  const body = {
    name: $('og-name').value,
    kind: $('og-kind').value,
    required: $('og-required').checked,
    min: $('og-min').value,
    max: $('og-max').value,
    // Blank rows are left out.
    options: [...$('og-opts').children].map((li) => ({
      id: li.dataset.id ? Number(li.dataset.id) : undefined,
      name: li.querySelector('[data-f="name"]').value,
      price: li.querySelector('[data-f="price"]').value,
      available: li.querySelector('[data-f="available"]').checked,
    })).filter((o) => o.name.trim() || o.id),
  };
  $('og-save').disabled = true;
  try {
    const path = state.editingGroupId === null ? '/api/option-groups' : `/api/option-groups/${state.editingGroupId}`;
    const data = await api(path, { method: state.editingGroupId === null ? 'POST' : 'PATCH', body });
    state.optionGroups = data.groups;
    renderGroups();
    ogEditor.close();
    toast(`${data.group.name} saved.`);
  } catch (err) {
    if (err.fields) showFieldErrors(ogEditor, err.fields);
    $('og-error').textContent = err.message;
    $('og-error').hidden = false;
  } finally {
    $('og-save').disabled = false;
  }
}

function askDeleteGroup(g) {
  state.pendingDelete = { kind: 'group', id: g.id };
  $('confirm-title').textContent = 'Delete this option group?';
  $('confirm-text').textContent = g.item_ids.length
    ? `“${g.name}” comes off ${plural(g.item_ids.length, 'item')} straight away. Past orders keep the options they had.`
    : `“${g.name}” is not on any item.`;
  confirmDialog.showModal();
}

/* ---------------------------- counted stock ---------------------------- */

const stockDialog = $('stock-dialog');
let stockItemId = null;

/** A fresh key per change, so a retried request adds its batch once. */
function requestKey() {
  return crypto.randomUUID().replace(/-/g, '');
}

function openStock(item) {
  stockItemId = item.id;
  $('stock-error').hidden = true;
  $('stock-title').textContent = item.name;
  const counted = !!item.stock;
  $('stock-add-form').hidden = !counted;
  $('stock-off').hidden = !counted;
  $('stock-add').value = '';
  $('stock-count').value = '';
  if (counted) {
    const left = Math.max(0, item.stock.left);
    const held = item.stock.held ? ` · ${item.stock.held} set aside on open orders` : '';
    $('stock-now').textContent = `${left} free to sell${held}.`;
    $('stock-count-label').textContent = 'Stock take';
    $('stock-count-hint').textContent = 'Count everything in the shop, including orders set aside for pick-up.';
    $('stock-count-btn').textContent = 'Save count';
  } else {
    $('stock-now').textContent = 'Not counted. Count it, and the website stops taking orders for it when it runs out.';
    $('stock-count-label').textContent = 'How many are in the shop now?';
    $('stock-count-hint').textContent = 'Include any set aside for orders.';
    $('stock-count-btn').textContent = 'Start counting';
  }
  if (!stockDialog.open) stockDialog.showModal();
  (counted ? $('stock-add') : $('stock-count')).focus();
}

async function changeStock(body, done) {
  $('stock-error').hidden = true;
  stockDialog.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
  try {
    const data = await api(`/api/items/${stockItemId}/count`, { method: 'POST', body: { ...body, request_key: requestKey() } });
    await loadAll();
    toast(done(data));
    const item = state.items.find((i) => i.id === stockItemId);
    if (body.action === 'off' || !item) stockDialog.close();
    else openStock(item);
  } catch (err) {
    $('stock-error').textContent = err.fields ? Object.values(err.fields).join(' ') : err.message;
    $('stock-error').hidden = false;
  } finally {
    stockDialog.querySelectorAll('button, input').forEach((el) => { el.disabled = false; });
  }
}

$('stock-add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const qty = $('stock-add').value.trim();
  changeStock({ action: 'add', qty }, (d) => `Added ${qty}. ${Math.max(0, d.level.left)} left.`);
});
$('stock-count-form').addEventListener('submit', (event) => {
  event.preventDefault();
  changeStock({ action: 'count', qty: $('stock-count').value.trim() },
    (d) => `Counted. ${Math.max(0, d.level.left)} free to sell.`);
});
$('stock-off').addEventListener('click', () => {
  changeStock({ action: 'off' }, () => 'No longer counted. Only availability and the daily limit apply.');
});
$('stock-close').addEventListener('click', () => stockDialog.close());

/* ---------------------------- ingredients ---------------------------- */

function renderIngredients() {
  const list = state.ingredients;
  const box = $('ingredients');
  box.replaceChildren(...list.map((g) => {
    const li = document.createElement('li');
    li.className = `row-item ing${g.in_stock ? '' : ' is-out'}`;
    li.dataset.ingId = String(g.id);
    const main = document.createElement('div');
    main.className = 'row-item__main';
    const name = document.createElement('span');
    name.className = 'row-item__name';
    name.textContent = g.name;
    const meta = document.createElement('span');
    meta.className = 'row-item__meta';
    const n = g.item_ids.length;
    meta.textContent = !n ? 'Not ticked on any item yet'
      : g.in_stock ? `Used in ${plural(n, 'item')}` : `${plural(n, 'item')} sold out`;
    main.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'row-item__actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `ing__toggle ${g.in_stock ? 'is-in' : 'is-out'}`;
    toggle.dataset.action = 'toggle';
    toggle.setAttribute('aria-label', `${g.name}: ${g.in_stock ? 'in stock. Tap to mark out.' : 'out. Tap to mark in stock.'}`);
    toggle.textContent = g.in_stock ? 'In stock' : 'Out';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'btn btn--ghost btn--sm';
    rename.dataset.action = 'rename';
    rename.textContent = 'Rename';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn--danger-ghost btn--sm';
    del.dataset.action = 'delete';
    del.textContent = 'Delete';
    actions.append(toggle, rename, del);
    li.append(main, actions);
    return li;
  }));
  $('ingredients-empty').hidden = list.length > 0;
}

function ingError(message) {
  $('ing-err').textContent = message || '';
  $('ing-err').hidden = !message;
}

async function ingredientCall(path, method, body, message) {
  ingError('');
  try {
    const data = await api(path, { method, body });
    state.ingredients = data.ingredients;
    renderIngredients();
    // In or out changes which items are sold out.
    await loadAll();
    if (message) toast(message(data));
    return true;
  } catch (err) {
    ingError(err.fields ? Object.values(err.fields).join(' ') : err.message);
    return false;
  }
}

$('ing-add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('ing-name').value;
  $('ing-add-btn').disabled = true;
  if (await ingredientCall('/api/ingredients', 'POST', { name }, (d) => `${d.ingredient.name} added. Tick it on the items that need it.`)) {
    $('ing-name').value = '';
  }
  $('ing-add-btn').disabled = false;
});

/** Rename in place: the name becomes a field with Save and Cancel. */
function startRename(li, g) {
  const main = li.querySelector('.row-item__main');
  const form = document.createElement('form');
  form.className = 'ing__rename';
  form.noValidate = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 40;
  input.value = g.name;
  input.setAttribute('aria-label', `New name for ${g.name}`);
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary btn--sm';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--ghost btn--sm';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', renderIngredients);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    ingredientCall(`/api/ingredients/${g.id}`, 'PATCH', { name: input.value }, (d) => `Renamed to ${d.ingredient.name}.`);
  });
  form.append(input, save, cancel);
  main.replaceChildren(form);
  input.focus();
}

$('ingredients').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const li = btn.closest('[data-ing-id]');
  const g = state.ingredients.find((x) => x.id === Number(li.dataset.ingId));
  if (!g) return;
  if (btn.dataset.action === 'toggle') {
    btn.disabled = true;
    ingredientCall(`/api/ingredients/${g.id}`, 'PATCH', { in_stock: !g.in_stock },
      (d) => (d.ingredient.in_stock ? `${g.name} is back in stock.` : `${g.name} is out. Items that need it show Sold out.`));
  }
  if (btn.dataset.action === 'rename') startRename(li, g);
  if (btn.dataset.action === 'delete') {
    state.pendingDelete = { kind: 'ingredient', id: g.id };
    $('confirm-title').textContent = 'Delete this ingredient?';
    $('confirm-text').textContent = g.item_ids.length
      ? `“${g.name}” comes off ${plural(g.item_ids.length, 'item')}.${g.in_stock ? '' : ' They are no longer sold out because of it.'}`
      : `“${g.name}” is not on any item.`;
    confirmDialog.showModal();
  }
});

/** Ingredient tick boxes in the item editor. */
function fillIngredientChoices(selected) {
  const box = $('f-ingredients');
  box.replaceChildren();
  if (!state.ingredients.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No ingredients yet. Add them under Ingredients below the items.';
    box.append(p);
    return;
  }
  for (const g of state.ingredients) {
    const label = document.createElement('label');
    label.className = 'promo__check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(g.id);
    input.checked = selected.includes(g.id);
    label.append(input, ` ${g.name}`);
    if (!g.in_stock) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = ' (out now)';
      label.append(hint);
    }
    box.append(label);
  }
}

/* ---------------------------- loading ---------------------------- */

/** Items and categories change together (item counts), so reload both. */
async function loadAll() {
  const [{ items }, { categories }, { groups: optionGroups }, { ingredients }] = await Promise.all([
    api('/api/items'), api('/api/categories'), api('/api/option-groups'), api('/api/ingredients'),
  ]);
  state.items = items;
  state.categories = categories;
  state.optionGroups = optionGroups;
  state.ingredients = ingredients;
  render();
  renderCategories();
  renderGroups();
  renderIngredients();
}

async function loadImages() {
  const { images } = await api('/api/images');
  state.images = images;
  renderHealth(); // it needs the images to tell the logo apart
}

/* ---------------------------- events ---------------------------- */

$('health').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-health-edit]');
  if (!btn) return;
  const item = state.items.find((i) => i.id === Number(btn.dataset.healthEdit));
  if (item) openEditor(item);
});

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
  if (btn.dataset.action === 'stock') openStock(item);
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

$('add-group').addEventListener('click', () => openGroupEditor(null));
$('og-form').addEventListener('submit', saveGroup);
$('og-close').addEventListener('click', () => ogEditor.close());
$('og-cancel').addEventListener('click', () => ogEditor.close());
$('og-kind').addEventListener('change', showLimits);
$('og-required').addEventListener('change', showLimits);
$('og-add-opt').addEventListener('click', () => {
  const row = optionRow();
  $('og-opts').append(row);
  row.querySelector('input').focus();
});
$('ogroups').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const g = state.optionGroups.find((x) => x.id === Number(btn.closest('[data-group-id]').dataset.groupId));
  if (!g) return;
  if (btn.dataset.action === 'edit') openGroupEditor(g);
  if (btn.dataset.action === 'delete') askDeleteGroup(g);
});
$('f-desc').addEventListener('input', descCount);

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
