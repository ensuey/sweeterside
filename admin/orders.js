'use strict';
/* Orders page: the incoming orders queue and the ordering settings. */

Object.assign(state, {
  orders: [],
  ordersShow: 'active', // 'active' | 'finished'
  newestOrderId: null,  // to spot orders that arrive while the page is open
});

const ORDER_STATUS = {
  new: 'New',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  delivering: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
// The 'delivering' step means "handed over" and reads differently per type.
const HANDOVER_LABEL = { delivery: 'Out for delivery', pickup: 'Ready for pick-up', dinein: 'Served' };
const ORDER_TYPES = ['delivery', 'pickup', 'dinein'];
const TYPE_LABEL = { delivery: 'Delivery', pickup: 'Pick-up', dinein: 'Dine-in' };

function statusLabel(status, type) {
  return status === 'delivering' ? HANDOVER_LABEL[type] || ORDER_STATUS.delivering : ORDER_STATUS[status];
}
const ORDER_POLL_MS = 20000;
// A New order waiting longer than this gets a "Waiting N min" badge.
const WAITING_FLAG_MIN = 10;
const CANCEL_REASON = {
  customer: 'Customer cancelled', no_show: 'No-show / unreachable', fake: 'Fake order', other: 'Other',
};

/* ---------------------------- orders ---------------------------- */

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

/** 'HH:MM' (Manila time) -> '3:30 PM' */
function clock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return hhmm;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The badge in an order's head: what kind of order, and when or where. */
function typeBadge(o) {
  if (o.order_type === 'pickup') {
    return o.pickup_at === 'asap' ? 'Pick-up · ASAP' : `Pick-up · ${clock(o.pickup_at)}`;
  }
  if (o.order_type === 'dinein') return `Dine-in · Table ${o.table_no}`;
  return 'Delivery';
}

/** Minutes since an order was placed. */
function minutesSince(sqlTime) {
  const d = new Date(`${String(sqlTime).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? 0 : Math.floor((Date.now() - d.getTime()) / 60000);
}

/** "First order", or "5 completed · 1 no-show", from the number's other orders. */
function historyText(h) {
  if (h.orders === 0) return 'First order';
  const parts = [`${h.completed} completed`];
  if (h.no_show) parts.push(plural(h.no_show, 'no-show'));
  if (h.fake) parts.push(`${h.fake} fake`);
  return parts.join(' · ');
}

/** Badges under the name: blocked, the number's history, and how long it has waited. */
function flagsHtml(o) {
  const flags = [];
  if (o.source === 'pos') flags.push(`<span class="flag">Counter${o.paid_at ? ' · paid' : ''}</span>`);
  if (o.blocked) flags.push('<span class="flag flag--bad">Blocked number</span>');
  if (o.history) {
    const kind = o.history.no_show || o.history.fake ? 'bad'
      : o.history.completed > 0 ? 'good' : 'new';
    flags.push(`<span class="flag flag--${kind}">${esc(historyText(o.history))}</span>`);
  }
  const waited = minutesSince(o.created_at);
  if (o.status === 'new' && o.needs_confirm && waited >= WAITING_FLAG_MIN) {
    flags.push(`<span class="flag flag--wait">Waiting ${waited} min</span>`);
  }
  if (o.status === 'cancelled' && o.cancel_reason) {
    flags.push(`<span class="flag">${esc(CANCEL_REASON[o.cancel_reason] || o.cancel_reason)}</span>`);
  }
  return flags.length ? `<div class="order__flags">${flags.join('')}</div>` : '';
}

/** Confirm (New orders) and Block this number (orders with a mobile number). */
function actionsHtml(o) {
  const actions = [];
  if (o.status === 'new') {
    actions.push(`<button class="btn btn--primary btn--sm" type="button" data-confirm>Confirm</button>`);
  }
  if (o.phone_norm && !o.blocked) {
    actions.push(`<button class="btn btn--danger-ghost btn--sm" type="button" data-block>Block this number</button>`);
  }
  return actions.length ? `<div class="order__actions">${actions.join('')}</div>` : '';
}

// Every field below was typed by a customer on the public menu: escape all of it.
function orderHtml(o) {
  const type = o.order_type || 'delivery';
  const options = Object.keys(ORDER_STATUS)
    .map((value) => `<option value="${value}"${value === o.status ? ' selected' : ''}>${statusLabel(value, type)}</option>`)
    .join('');
  const lines = o.items
    .map((l) => `<li><span>${l.qty} × ${esc(l.name)}${l.note ? ` <em class="order__note">${esc(l.note)}</em>` : ''}</span><span>${money(l.price * l.qty)}</span></li>`)
    .join('');

  // Delivery collects cash at the door; the other types pay at the counter.
  const payment = o.source === 'pos'
    ? `<dd class="order__change">${o.paid_at ? 'Paid at the counter' : 'Not paid yet'}</dd>`
    : type === 'delivery'
    ? `<dt>Customer pays with</dt><dd>${money(o.cash)}</dd>
        <dd class="order__change">${o.change_due === 0
          ? 'Exact amount, no change needed'
          : `Bring ${money(o.change_due)} change`}</dd>`
    : '<dd class="order__change">Pays at the counter</dd>';

  return `
    <li class="order" data-order-id="${o.id}" data-status="${esc(o.status)}" data-type="${esc(type)}">
      <div class="order__head">
        <span class="order__id">#${o.id}</span>
        <span class="order__type">${esc(typeBadge(o))}</span>
        <span class="order__time">${esc(orderTime(o.created_at))}</span>
        <label class="vh" for="status-${o.id}">Status of order ${o.id}</label>
        <select class="order__status" id="status-${o.id}" data-status-select>${options}</select>
      </div>
      <div class="order__who">
        <span class="order__name">${esc(o.customer_name)}</span>
        ${o.phone ? `<a class="order__phone" href="tel:${esc(o.phone_norm || o.phone)}">${esc(o.phone)}</a>` : ''}
        ${type === 'delivery' ? `<span class="order__addr">${esc(o.address)}</span>` : ''}
        ${type === 'delivery' && o.landmark ? `<span class="order__landmark"><strong>Landmark:</strong> ${esc(o.landmark)}</span>` : ''}
        ${flagsHtml(o)}
      </div>
      <ul class="order__items">${lines}</ul>
      <dl class="order__sum">
        <dt>Subtotal</dt><dd>${money(o.subtotal)}</dd>
        ${o.sc_pwd_discount > 0 ? `<dt>SC/PWD 20%</dt><dd class="order__discount">−${money(o.sc_pwd_discount)}</dd>` : ''}
        ${o.vat_exempt > 0 ? `<dt>VAT exempt</dt><dd class="order__discount">−${money(o.vat_exempt)}</dd>` : ''}
        ${o.discount > 0 ? `<dt>Voucher ${esc(o.voucher_code)}</dt><dd class="order__discount">−${money(o.discount)}</dd>` : ''}
        ${o.manual_discount > 0 ? `<dt>Discount</dt><dd class="order__discount">−${money(o.manual_discount)}</dd>` : ''}
        ${o.service_charge > 0 ? `<dt>Service charge</dt><dd>${money(o.service_charge)}</dd>` : ''}
        ${o.delivery_fee > 0 ? `<dt>Delivery fee</dt><dd>${money(o.delivery_fee)}</dd>` : ''}
        <dt class="is-total">Total</dt><dd class="is-total">${money(o.total)}</dd>
        ${payment}
      </dl>
      ${actionsHtml(o)}
    </li>`;
}

function renderOrders(counts) {
  const list = $('orders');
  list.innerHTML = state.orders.map(orderHtml).join('');

  const active = counts.new + counts.confirmed + counts.preparing + counts.delivering;
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

/** Save a status. @returns true if it saved. */
async function saveStatus(id, status, reason) {
  const order = state.orders.find((o) => o.id === id);
  try {
    await api(`/api/orders/${id}`, { method: 'PATCH', body: reason ? { status, reason } : { status } });
    toast(`Order #${id}: ${statusLabel(status, order ? order.order_type : 'delivery')}`
      + (reason ? ` (${CANCEL_REASON[reason]}).` : '.'));
    await loadOrders();
    return true;
  } catch (err) {
    toast(err.fields ? Object.values(err.fields).join(' ') : err.message, 'error');
    return false;
  }
}

async function changeStatus(select) {
  const id = Number(select.closest('.order').dataset.orderId);
  const previous = state.orders.find((o) => o.id === id);
  const status = select.value;
  // Cancelling asks why first; the select shows the old status until it is done.
  if (status === 'cancelled') {
    if (previous) select.value = previous.status;
    select.blur();
    openCancel(id);
    return;
  }
  select.disabled = true;
  const saved = await saveStatus(id, status);
  if (!saved && previous) select.value = previous.status;
  select.disabled = false;
  select.blur();
}

/* ---------------------------- cancel and block ---------------------------- */

let cancelId = null;
let blockId = null;

function openCancel(id) {
  cancelId = id;
  $('cancel-title').textContent = `Cancel order #${id}`;
  $('cancel-form').reset();
  $('cancel-dialog').showModal();
}

async function submitCancel(event) {
  event.preventDefault();
  const reason = $('cancel-form').elements.reason.value;
  $('cancel-ok').disabled = true;
  if (await saveStatus(cancelId, 'cancelled', reason)) $('cancel-dialog').close();
  $('cancel-ok').disabled = false;
}

function openBlock(id) {
  const order = state.orders.find((o) => o.id === id);
  if (!order) return;
  blockId = id;
  $('block-text').textContent = `${order.phone} (${order.customer_name}) will not be able to order or book a cake online.`;
  $('block-reason').value = '';
  $('block-err').hidden = true;
  const open = !['completed', 'cancelled'].includes(order.status);
  $('block-cancel-wrap').hidden = !open;
  $('block-cancel').checked = open;
  $('block-cancel-label').textContent = `Also cancel order #${id} as a fake order`;
  $('block-dialog').showModal();
}

async function submitBlock(event) {
  event.preventDefault();
  const err = $('block-err');
  err.hidden = true;
  $('block-ok').disabled = true;
  const cancel = !$('block-cancel-wrap').hidden && $('block-cancel').checked;
  try {
    const { blocked } = await api('/api/blocked', {
      method: 'POST', body: { order_id: blockId, reason: $('block-reason').value, cancel },
    });
    $('block-dialog').close();
    toast(`${blocked.display} is blocked.${cancel ? ` Order #${blockId} cancelled as a fake order.` : ''}`);
    await loadOrders();
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('block-ok').disabled = false;
  }
}

function showSettings(s) {
  $('fee').value = s.delivery_fee;
  $('pickup-open').value = s.pickup_open;
  $('pickup-close').value = s.pickup_close;
  ORDER_TYPES.forEach((t) => { $(`on-${t}`).checked = s[`${t}_enabled`]; });
  showShop(s);
  showTrust(s);
}

/* ---------------------------- fake-order protection ---------------------------- */

function showTrust(s) {
  ORDER_TYPES.forEach((t) => { $(`confirm-${t}`).checked = s[`require_confirm_${t}`]; });
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
    ORDER_TYPES.forEach((t) => { body[`require_confirm_${t}`] = $(`confirm-${t}`).checked; });
    showTrust(await api('/api/settings', { method: 'PUT', body }));
    toast('Saved.');
    await loadOrders(); // the Waiting badges depend on which types need confirming
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('trust-save').disabled = false;
  }
}

/* ---------------------------- open / closed ---------------------------- */

function showShop(s) {
  $('shop').dataset.open = s.shop_open ? '1' : '0';
  document.querySelectorAll('[data-shop]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String((btn.dataset.shop === 'open') === s.shop_open));
  });
  $('shop-state').textContent = s.shop_open
    ? 'Customers can order from the menu.'
    : 'Customers can browse the menu but not order. Cake bookings still work.';
  // Do not overwrite a note being typed.
  if (document.activeElement !== $('closed-note')) $('closed-note').value = s.closed_note;
  showShopPill(s.shop_open);
}

async function setShopOpen(open) {
  document.querySelectorAll('[data-shop]').forEach((btn) => { btn.disabled = true; });
  try {
    const s = await api('/api/settings', { method: 'PUT', body: { shop_open: open } });
    showShop(s);
    toast(open
      ? 'Shop is open. Customers can order.'
      : 'Shop is closed. Customers can browse but not order.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    document.querySelectorAll('[data-shop]').forEach((btn) => { btn.disabled = false; });
  }
}

async function saveClosedNote() {
  const err = $('closed-note-err');
  err.hidden = true;
  try {
    const s = await api('/api/settings', { method: 'PUT', body: { closed_note: $('closed-note').value } });
    $('closed-note').value = s.closed_note;
    toast(s.closed_note ? 'Closed note saved.' : 'Closed note cleared. The menu shows the usual line.');
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  }
}

async function loadSettings() {
  showSettings(await api('/api/settings'));
}

async function saveSettings(event) {
  event.preventDefault();
  const err = $('fee-err');
  err.hidden = true;
  $('fee-save').disabled = true;
  try {
    const body = {
      delivery_fee: $('fee').value,
      pickup_open: $('pickup-open').value,
      pickup_close: $('pickup-close').value,
    };
    ORDER_TYPES.forEach((t) => { body[`${t}_enabled`] = $(`on-${t}`).checked; });
    const s = await api('/api/settings', { method: 'PUT', body });
    showSettings(s);

    const open = ORDER_TYPES.filter((t) => s[`${t}_enabled`]).map((t) => TYPE_LABEL[t]);
    toast(open.length
      ? `Saved. Taking orders for ${open.join(', ')}.`
      : 'Saved. Online ordering is closed.');
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
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

/* ---------------------------- events ---------------------------- */

$('orders').addEventListener('change', (event) => {
  if (event.target.matches('[data-status-select]')) changeStatus(event.target);
});

$('orders').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-confirm], [data-block]');
  if (!btn) return;
  const id = Number(btn.closest('.order').dataset.orderId);
  if (btn.matches('[data-block]')) { openBlock(id); return; }
  btn.disabled = true;
  if (!(await saveStatus(id, 'confirmed'))) btn.disabled = false;
});

$('cancel-form').addEventListener('submit', submitCancel);
$('cancel-back').addEventListener('click', () => $('cancel-dialog').close());
$('block-form').addEventListener('submit', submitBlock);
$('block-back').addEventListener('click', () => $('block-dialog').close());
$('trust-form').addEventListener('submit', saveTrust);

document.querySelectorAll('.tab[data-show]').forEach((tab) => {
  tab.addEventListener('click', async () => {
    state.ordersShow = tab.dataset.show;
    document.querySelectorAll('.tab[data-show]').forEach((t) => {
      t.setAttribute('aria-pressed', String(t === tab));
    });
    try { await loadOrders(); } catch (err) { toast(err.message, 'error'); }
  });
});

$('fee-form').addEventListener('submit', saveSettings);

document.querySelectorAll('[data-shop]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const open = btn.dataset.shop === 'open';
    if (btn.getAttribute('aria-pressed') !== 'true') setShopOpen(open);
  });
});
$('closed-note').addEventListener('change', saveClosedNote);

adminBoot(async () => {
  await Promise.all([loadOrders(), loadSettings()]);
  pollOrders();
});
