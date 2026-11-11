'use strict';
/* Settings page: fake-order protection. Order alerts on this page are run
   by push.js. Both save through the same /api/settings as the Orders page. */

const TRUST_TYPES = ['delivery', 'pickup', 'dinein'];

function showTrust(s) {
  TRUST_TYPES.forEach((t) => { $(`confirm-${t}`).checked = s[`require_confirm_${t}`]; });
  $('max-open').value = s.max_open_orders;
  $('auto-confirm').checked = s.auto_confirm_trusted;
  $('trusted-completed').value = s.trusted_min_completed;
  $('trusted-flags').value = s.trusted_max_flags;
}

async function saveTrust(event) {
  event.preventDefault();
  const err = $('trust-err');
  err.hidden = true;
  $('trust-save').disabled = true;
  try {
    const body = {
      max_open_orders: $('max-open').value,
      auto_confirm_trusted: $('auto-confirm').checked,
      trusted_min_completed: $('trusted-completed').value,
      trusted_max_flags: $('trusted-flags').value,
    };
    TRUST_TYPES.forEach((t) => { body[`require_confirm_${t}`] = $(`confirm-${t}`).checked; });
    showTrust(await api('/api/settings', { method: 'PUT', body }));
    toast('Saved.');
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('trust-save').disabled = false;
  }
}

/* ---------------------------- opening hours ---------------------------- */

/** '20:00' -> '8:00 PM' */
function clock12(hhmm) {
  if (hhmm === '24:00') return 'midnight';
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function showHours(s) {
  $('open-at').value = s.open_at;
  // A time field cannot hold 24:00 (open until midnight); it is left as set.
  if (s.close_at !== '24:00') $('close-at').value = s.close_at;
  $('preorder-days').value = s.preorder_days;
  $('hours-now').textContent = !s.shop_open
    ? 'Right now the shop is set to Closed on the Orders page, so online ordering is closed whatever the hours.'
    : s.closing_soon ? `Right now: closing soon. Online orders until ${clock12(s.close_at)}.`
    : s.open_now ? `Right now: open. Online orders until ${clock12(s.close_at)}.`
    : `Right now: outside opening hours. Online ordering opens at ${clock12(s.open_at)}.`;
  showShopPill(s);
}

async function saveHours(event) {
  event.preventDefault();
  const err = $('hours-err');
  err.hidden = true;
  $('hours-save').disabled = true;
  try {
    const s = await api('/api/settings', { method: 'PUT', body: { open_at: $('open-at').value, close_at: $('close-at').value, preorder_days: $('preorder-days').value } });
    showHours(s);
    toast(`Saved. Online ordering is open ${clock12(s.open_at)} to ${clock12(s.close_at)} every day.`);
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('hours-save').disabled = false;
  }
}

/* ---------------------------- order confirmation ---------------------------- */

function showConfirm(s) {
  $('call-minutes').value = s.confirm_call_minutes;
  $('facebook-url').value = s.facebook_url;
}

async function saveConfirm(event) {
  event.preventDefault();
  const err = $('confirm-err');
  err.hidden = true;
  $('confirm-save').disabled = true;
  try {
    showConfirm(await api('/api/settings', {
      method: 'PUT', body: { confirm_call_minutes: $('call-minutes').value, facebook_url: $('facebook-url').value },
    }));
    toast('Saved.');
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('confirm-save').disabled = false;
  }
}

/* ---------------------------- GCash (PayMongo) ---------------------------- */

function showGcash(s) {
  const parts = [];
  if (!s.gcash_ready) parts.push('Not set up: the PayMongo keys are not on the server yet.');
  else {
    parts.push(s.gcash_live ? 'PayMongo keys: live (real payments).' : 'PayMongo keys: test mode (no real money).');
    parts.push(s.gcash_webhook ? 'Payment confirmations: on.' : 'Payment confirmations: not set up yet (customers coming back still confirm it).');
  }
  $('gcash-status').textContent = parts.join(' ');
  $('gcash-on').checked = s.gcash_online;
  // Without keys there is nothing to switch on.
  $('gcash-on').disabled = !s.gcash_ready && !s.gcash_online;
}

async function saveGcash() {
  const err = $('gcash-err');
  err.hidden = true;
  $('gcash-on').disabled = true;
  try {
    const s = await api('/api/settings', { method: 'PUT', body: { gcash_online: $('gcash-on').checked } });
    showGcash(s);
    toast(s.gcash_online ? 'GCash is offered at checkout.' : 'GCash is off. Customers pay in person.');
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
    $('gcash-on').disabled = false;
  }
}

/* ---------------------------- tracking ---------------------------- */

// Setting -> input id.
const TRACKING_FIELDS = {
  ga4_id: 'ga4-id', gads_id: 'gads-id', gads_purchase_label: 'gads-purchase',
  gads_lead_label: 'gads-lead', clarity_id: 'clarity-id', meta_pixel_id: 'pixel-id',
};

function showTracking(s) {
  for (const [key, id] of Object.entries(TRACKING_FIELDS)) $(id).value = s[key] || '';
}

async function saveTracking(event) {
  event.preventDefault();
  const err = $('tracking-err');
  err.hidden = true;
  $('tracking-save').disabled = true;
  try {
    const body = Object.fromEntries(Object.entries(TRACKING_FIELDS).map(([key, id]) => [key, $(id).value]));
    const s = await api('/api/settings', { method: 'PUT', body });
    showTracking(s);
    const on = s.ga4_id || s.gads_id || s.clarity_id || s.meta_pixel_id;
    toast(on ? 'Saved. Tracking is on.' : 'Saved. Tracking is off.');
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('tracking-save').disabled = false;
  }
}

/* ---------------------------- share image ---------------------------- */

const LOGO_SRC = '/assets/Sweeter%20Side%20-%20PNG.png';

function showShare(s) {
  $('share-preview').src = s.share_image ? `/${s.share_image.split('/').map(encodeURIComponent).join('/')}` : LOGO_SRC;
  $('share-remove').hidden = !s.share_image;
  $('share-status').textContent = s.share_image ? '' : 'Using the logo.';
}

/** Upload through the same pipeline as menu photos (type checked, metadata
    stripped), then make it the share image. */
async function uploadShare() {
  const file = $('share-file').files[0];
  if (!file) return;
  $('share-status').textContent = 'Uploading…';
  try {
    const res = await fetch('/api/images', { method: 'POST', headers: { 'X-CSRF-Token': state.csrf }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    const s = await api('/api/settings', { method: 'PUT', body: { share_image: data.path } });
    showShare(s);
    $('share-status').textContent = data.width / data.height < 1.6 || data.width < 1000
      ? `Saved (${data.width} × ${data.height}). A wide picture, about 1200 × 630, shows best.`
      : `Saved (${data.width} × ${data.height}).`;
  } catch (e) {
    $('share-status').textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
  } finally {
    $('share-file').value = '';
  }
}

async function removeShare() {
  try {
    showShare(await api('/api/settings', { method: 'PUT', body: { share_image: '' } }));
    toast('The logo is used when the site is shared.');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------------------------- delivery areas ---------------------------- */

function areaErr(message) {
  $('areas-err').textContent = message || '';
  $('areas-err').hidden = !message;
}

function errorText(e) {
  return e.fields ? Object.values(e.fields).join(' ') : e.message;
}

/** One small labelled input for an area row. */
function areaField(label, input) {
  const wrap = document.createElement('label');
  wrap.className = 'areas__field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(span, input);
  return wrap;
}

function numberInput(value, max, placeholder) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = String(max);
  input.step = '1';
  input.inputMode = 'numeric';
  input.placeholder = placeholder;
  input.value = value === null || value === undefined ? '' : String(value);
  return input;
}

function areaRow(a) {
  const li = document.createElement('li');
  li.className = 'areas__row';
  const form = document.createElement('form');
  form.className = 'areas__form';
  form.noValidate = true;

  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 40;
  name.required = true;
  name.value = a.name;
  const fee = numberInput(a.fee, 10000, 'Not set');
  const etaMin = numberInput(a.eta_min, 600, 'min');
  const etaMax = numberInput(a.eta_max, 600, 'max');
  const active = document.createElement('input');
  active.type = 'checkbox';
  active.checked = a.active;

  const save = document.createElement('button');
  save.className = 'btn btn--ghost';
  save.type = 'submit';
  save.textContent = 'Save';
  const remove = document.createElement('button');
  remove.className = 'link-quiet';
  remove.type = 'button';
  remove.textContent = 'Remove';

  const note = document.createElement('p');
  note.className = 'hint areas__note';
  note.textContent = !a.active ? 'Off: not offered.' : a.fee === null ? 'Set a fee to offer this area.' : 'Offered at checkout.';

  const onLabel = document.createElement('label');
  onLabel.className = 'areas__on';
  onLabel.append(active, document.createTextNode(' On'));

  form.append(
    areaField('Area', name), areaField('Fee (₱)', fee),
    areaField('Usual time (min)', etaMin), areaField('to (min)', etaMax),
    onLabel, save, remove,
  );
  li.append(form, note);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    areaErr('');
    save.disabled = true;
    try {
      const data = await api(`/api/delivery-areas/${a.id}`, {
        method: 'PATCH',
        body: { name: name.value, fee: fee.value, eta_min: etaMin.value, eta_max: etaMax.value, active: active.checked },
      });
      showAreas(data.areas);
      toast(`${data.area.name} saved.`);
    } catch (e) {
      areaErr(errorText(e));
    } finally {
      save.disabled = false;
    }
  });
  remove.addEventListener('click', async () => {
    areaErr('');
    try {
      showAreas((await api(`/api/delivery-areas/${a.id}`, { method: 'DELETE' })).areas);
      toast(`${a.name} removed. Past orders keep the name.`);
    } catch (e) {
      areaErr(errorText(e));
    }
  });
  return li;
}

function showAreas(areas) {
  const list = $('areas-list');
  list.replaceChildren(...areas.map(areaRow));
  if (!areas.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'No areas yet. Customers can still choose "Other area".';
    list.append(li);
  }
}

async function addArea(event) {
  event.preventDefault();
  areaErr('');
  try {
    const data = await api('/api/delivery-areas', { method: 'POST', body: { name: $('area-new').value } });
    showAreas(data.areas);
    $('area-new').value = '';
    toast(`${data.area.name} added. Set its fee to offer it.`);
  } catch (e) {
    areaErr(errorText(e));
  }
}

async function saveFree(event) {
  event.preventDefault();
  const err = $('free-err');
  err.hidden = true;
  $('free-save').disabled = true;
  try {
    const s = await api('/api/settings', { method: 'PUT', body: { free_delivery_min: $('free-min').value } });
    $('free-min').value = s.free_delivery_min ?? '';
    toast(s.free_delivery_min ? `Free delivery from ${money(s.free_delivery_min)}.` : 'Free delivery is off.');
  } catch (e) {
    err.textContent = errorText(e);
    err.hidden = false;
  } finally {
    $('free-save').disabled = false;
  }
}

/* ---------------------------- cart suggestions ---------------------------- */

const SUGGEST_MAX = 3;

/** One row: a label and three item pickers (blank for none). */
function suggestRow(key, label, chosen, items) {
  const row = document.createElement('fieldset');
  row.className = 'suggest-row';
  row.dataset.key = key;
  const legend = document.createElement('legend');
  legend.textContent = label;
  row.append(legend);
  for (let i = 0; i < SUGGEST_MAX; i++) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${label}: suggestion ${i + 1}`);
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '—';
    select.append(none);
    for (const item of items) {
      const o = document.createElement('option');
      o.value = String(item.id);
      o.textContent = item.availability === 'unavailable' ? `${item.name} (not on the menu)` : item.name;
      select.append(o);
    }
    select.value = chosen[i] !== undefined ? String(chosen[i]) : '';
    row.append(select);
  }
  return row;
}

async function loadSuggestions() {
  const [s, { items }, { categories }] = await Promise.all([
    api('/api/suggestions'), api('/api/items'), api('/api/categories'),
  ]);
  const rows = [suggestRow('any', 'Any order', s.any, items)];
  for (const c of categories) rows.push(suggestRow(String(c.id), `With ${c.name}`, s.categories[c.id] || [], items));
  $('suggest-rows').replaceChildren(...rows);
}

async function saveSuggestions(event) {
  event.preventDefault();
  const err = $('suggest-err');
  err.hidden = true;
  $('suggest-save').disabled = true;
  const body = { any: [], categories: {} };
  for (const row of $('suggest-rows').querySelectorAll('.suggest-row')) {
    const ids = [...row.querySelectorAll('select')].map((s) => s.value).filter(Boolean).map(Number);
    if (row.dataset.key === 'any') body.any = ids;
    else body.categories[row.dataset.key] = ids;
  }
  try {
    await api('/api/suggestions', { method: 'PUT', body });
    toast('Suggestions saved.');
  } catch (e) {
    err.textContent = errorText(e);
    err.hidden = false;
  } finally {
    $('suggest-save').disabled = false;
  }
}

/* ---------------------------- testimonials ---------------------------- */

const T_SOURCES = ['', 'Facebook', 'Google', 'In person', 'Other'];

function testimonialRow(t) {
  const li = document.createElement('li');
  li.className = 'areas__row';
  const form = document.createElement('form');
  form.className = 't-row';
  form.noValidate = true;
  const quote = document.createElement('textarea');
  quote.rows = 2;
  quote.maxLength = 300;
  quote.value = t.quote;
  quote.setAttribute('aria-label', 'What they said');
  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 40;
  name.value = t.name;
  name.setAttribute('aria-label', 'Name or initials');
  const source = document.createElement('select');
  source.setAttribute('aria-label', 'From');
  for (const s of T_SOURCES) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s || '—';
    source.append(o);
  }
  source.value = t.source;
  const on = document.createElement('label');
  on.className = 'areas__on';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = t.active;
  on.append(box, ' Show');
  const save = document.createElement('button');
  save.className = 'btn btn--ghost';
  save.type = 'submit';
  save.textContent = 'Save';
  const remove = document.createElement('button');
  remove.className = 'link-quiet';
  remove.type = 'button';
  remove.textContent = 'Delete';
  const row = document.createElement('div');
  row.className = 'hours__form';
  row.append(name, source, on, save, remove);
  form.append(quote, row);
  li.append(form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showErr('t-err', '');
    try {
      showTestimonials((await api(`/api/testimonials/${t.id}`, {
        method: 'PATCH', body: { quote: quote.value, name: name.value, source: source.value, active: box.checked },
      })).testimonials);
      toast('Testimonial saved.');
    } catch (e) {
      showErr('t-err', errorText(e));
    }
  });
  remove.addEventListener('click', async () => {
    showErr('t-err', '');
    try {
      showTestimonials((await api(`/api/testimonials/${t.id}`, { method: 'DELETE' })).testimonials);
      toast('Testimonial deleted.');
    } catch (e) {
      showErr('t-err', errorText(e));
    }
  });
  return li;
}

function showErr(id, message) {
  $(id).textContent = message || '';
  $(id).hidden = !message;
}

function showTestimonials(list) {
  $('t-list').replaceChildren(...list.map(testimonialRow));
}

async function addTestimonial(event) {
  event.preventDefault();
  showErr('t-err', '');
  try {
    showTestimonials((await api('/api/testimonials', {
      method: 'POST', body: { quote: $('t-quote').value, name: $('t-name').value, source: $('t-source').value },
    })).testimonials);
    $('t-form').reset();
    toast('Testimonial added. It shows on the menu and the cake page.');
  } catch (e) {
    showErr('t-err', errorText(e));
  }
}

async function saveRating(event) {
  event.preventDefault();
  showErr('rating-err', '');
  try {
    const r = await api('/api/testimonials/rating', { method: 'PUT', body: { rating_line: $('rating-line').value } });
    $('rating-line').value = r.rating_line;
    toast(r.rating_line ? 'Rating line saved.' : 'Rating line removed.');
  } catch (e) {
    showErr('rating-err', errorText(e));
  }
}

$('t-form').addEventListener('submit', addTestimonial);
$('rating-form').addEventListener('submit', saveRating);
$('suggest-form').addEventListener('submit', saveSuggestions);
$('area-add').addEventListener('submit', addArea);
$('free-form').addEventListener('submit', saveFree);
$('trust-form').addEventListener('submit', saveTrust);
$('hours-form').addEventListener('submit', saveHours);
$('confirm-form').addEventListener('submit', saveConfirm);
$('tracking-form').addEventListener('submit', saveTracking);
$('gcash-on').addEventListener('change', saveGcash);
$('share-file').addEventListener('change', uploadShare);
$('share-remove').addEventListener('click', removeShare);

adminBoot(async () => {
  const s = await api('/api/settings');
  showHours(s);
  showTrust(s);
  showConfirm(s);
  showShare(s);
  showTracking(s);
  showGcash(s);
  $('free-min').value = s.free_delivery_min ?? '';
  showAreas((await api('/api/delivery-areas')).areas);
  await loadSuggestions();
  const t = await api('/api/testimonials');
  showTestimonials(t.testimonials);
  $('rating-line').value = t.rating_line;
});
