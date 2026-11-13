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
  unpaid: 'GCash not paid',
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
  if (o.scheduled_label) return o.order_type === 'pickup' ? 'Pick-up' : 'Delivery';
  if (o.order_type === 'pickup') {
    return o.pickup_at === 'asap' ? 'Pick-up · ASAP' : `Pick-up · ${clock(o.pickup_at)}`;
  }
  if (o.order_type === 'dinein') return `Dine-in · Table ${o.table_no}`;
  return 'Delivery';
}

// A scheduled order is not late before its time: its waiting clock starts
// this long before it.
const SCHEDULED_WAIT_FROM_MIN = 30;

/** When an order starts waiting: when it was placed, or for a scheduled
    order 30 minutes before its time, whichever is later. */
function waitingFrom(o) {
  if (!o.scheduled_for) return o.created_at;
  const due = new Date(`${String(o.scheduled_for).replace(' ', 'T')}Z`).getTime() - SCHEDULED_WAIT_FROM_MIN * 60000;
  const placed = new Date(`${String(o.created_at).replace(' ', 'T')}Z`).getTime();
  return new Date(Math.max(due, placed)).toISOString().slice(0, 19).replace('T', ' ');
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
  else if (o.paid_at) flags.push('<span class="flag flag--good">Paid</span>');
  else if (o.pay_status === 'paid') flags.push('<span class="flag flag--good">Paid with GCash</span>');
  if (o.blocked) flags.push('<span class="flag flag--bad">Blocked number</span>');
  if (o.history) {
    const kind = o.history.no_show || o.history.fake ? 'bad'
      : o.history.completed > 0 ? 'good' : 'new';
    flags.push(`<span class="flag flag--${kind}">${esc(historyText(o.history))}</span>`);
  }
  if (o.scheduled_label) flags.push(`<span class="flag flag--sched">Scheduled — ${esc(o.scheduled_label)}</span>`);
  const waited = minutesSince(waitingFrom(o));
  if (o.status === 'new' && o.needs_confirm && waited >= WAITING_FLAG_MIN && !(o.source === 'pos' && !o.kitchen_sent_at)) {
    flags.push(`<span class="flag flag--wait">Waiting ${waited} min</span>`);
  }
  if (o.status === 'cancelled' && o.cancel_reason) {
    flags.push(`<span class="flag">${esc(CANCEL_REASON[o.cancel_reason] || o.cancel_reason)}</span>`);
  }
  return flags.length ? `<div class="order__flags">${flags.join('')}</div>` : '';
}

/** Confirm (New orders), Take payment (unpaid orders, on the POS pay screen)
    and a quiet Block number link (orders with a mobile number). */
function actionsHtml(o) {
  const actions = [];
  // A counter order paid without going to the kitchen has nothing to confirm.
  const heldPos = o.source === 'pos' && !o.kitchen_sent_at;
  if (o.status === 'new' && !heldPos) {
    actions.push(`<button class="btn btn--primary btn--sm" type="button" data-confirm>Confirm</button>`);
  }
  if (!orderPaid(o) && o.status !== 'cancelled') {
    actions.push(`<a class="btn btn--ghost btn--sm" href="/admin/pos?pay=${o.id}">Take payment</a>`);
  }
  if (o.phone_norm && !o.blocked) {
    actions.push(`<button class="link-quiet" type="button" data-block>Block number</button>`);
  }
  actions.push('<button class="link-quiet order__delete" type="button" data-delete>Delete…</button>');
  return `<div class="order__actions">${actions.join('')}</div>`;
}

/* ---------------------------- deleting test orders ---------------------------- */

let deleting = null; // the order in the delete dialog

async function openDelete(id) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) return;
  deleting = o;
  $('delete-err').hidden = true;
  $('delete-pin').value = '';
  $('delete-text').textContent = `Order #${o.id}${o.customer_name ? ` for ${o.customer_name}` : ''} (${money(o.total)}) and everything on it is erased: it leaves the orders, reports and customer history.`;
  const paid = orderPaid(o) || o.source === 'online' && o.status === 'completed';
  $('delete-paid').hidden = !paid;
  $('delete-paid').textContent = paid
    ? 'It was paid or completed, so it comes off the sales reports and the shift total too.' : '';
  // The owner's name to go with the PIN.
  const select = $('delete-owner');
  try {
    const { staff } = await api('/api/pos/staff');
    const owners = staff.filter((s) => s.role === 'owner');
    select.replaceChildren(...owners.map((s) => {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = s.name;
      return opt;
    }));
    if (!owners.length) throw new Error('Add an owner with a PIN on the Staff page first.');
  } catch (err) {
    $('delete-err').textContent = err.message;
    $('delete-err').hidden = false;
  }
  $('delete-dialog').showModal();
  $('delete-pin').focus();
}

async function submitDelete(event) {
  event.preventDefault();
  if (!deleting) return;
  const err = $('delete-err');
  err.hidden = true;
  $('delete-ok').disabled = true;
  try {
    await api(`/api/orders/${deleting.id}/delete`, {
      method: 'POST',
      body: { confirm: deleting.id, override: { staff_id: Number($('delete-owner').value), pin: $('delete-pin').value } },
    });
    $('delete-dialog').close();
    toast(`Order #${deleting.id} deleted.`);
    deleting = null;
    await loadOrders();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    $('delete-pin').value = '';
    $('delete-pin').focus();
  } finally {
    $('delete-ok').disabled = false;
  }
}

// Every field below was typed by a customer on the public menu: escape all of it.
function orderHtml(o) {
  const type = o.order_type || 'delivery';
  const options = Object.keys(ORDER_STATUS)
    .map((value) => `<option value="${value}"${value === o.status ? ' selected' : ''}>${statusLabel(value, type)}</option>`)
    .join('');
  const lines = o.items
    .map((l) => `<li><span>${l.qty} × ${esc(l.name)}${l.options_text ? `<span class="order__opts">${esc(l.options_text)}</span>` : ''}${l.note ? ` <em class="order__note">${esc(l.note)}</em>` : ''}</span><span>${money(l.price * l.qty)}</span></li>`)
    .join('');

  // Delivery collects cash at the door; the other types pay at the counter.
  // GCash orders were paid online; one cancelled after paying needs a refund in PayMongo.
  const gcashRefund = o.pay_method === 'gcash' && (o.pay_status === 'late' || (o.pay_status === 'paid' && o.status === 'cancelled'));
  const payment = gcashRefund
    ? '<dd class="order__change order__refund">Paid with GCash, then cancelled: refund it in the PayMongo dashboard.</dd>'
    : o.pay_status === 'paid'
    ? '<dd class="order__change">Paid with GCash</dd>'
    : o.source === 'online' && o.paid_at
    ? '<dd class="order__change">Paid</dd>'
    : o.source === 'pos'
    ? `<dd class="order__change">${o.paid_at ? 'Paid at the counter' : 'Not paid yet'}</dd>`
    : type === 'delivery'
    ? `<dt>Customer pays with</dt><dd>${money(o.cash)}</dd>
        <dd class="order__change">${o.change_due === 0
          ? 'Exact / no change needed'
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
        ${type === 'delivery' && o.delivery_area ? `<span class="order__area"><strong>Area:</strong> ${esc(o.delivery_area)}${o.fee_to_confirm ? ' <span class="flag flag--warn">Fee to confirm</span>' : ''}</span>` : ''}
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
        ${o.fee_to_confirm ? '<dt>Delivery fee</dt><dd>To confirm by call</dd>' : ''}
        <dt class="is-total">Total</dt><dd class="is-total">${money(o.total)}</dd>
        ${payment}
      </dl>
      ${actionsHtml(o)}
    </li>`;
}

/* ---------------------------- finished: today as cards, older as rows ---------------------------- */

const openRows = new Set(); // older orders opened into a card, kept open across refreshes

/** The Manila calendar day (YYYY-MM-DD) of a stored UTC time or a Date (default now). */
function manilaDay(when = new Date()) {
  const d = when instanceof Date ? when : new Date(`${String(when).replace(' ', 'T')}Z`);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

/** "Yesterday" or "Mon, 9 Nov". */
function dayLabel(day) {
  if (day === manilaDay(new Date(Date.now() - 86400000))) return 'Yesterday';
  return new Date(`${day}T12:00:00+08:00`)
    .toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Manila' });
}

/** An older finished order on one line; tap to open the full card. */
function orderRowHtml(o) {
  const type = o.order_type || 'delivery';
  const placed = new Date(`${String(o.created_at).replace(' ', 'T')}Z`)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
  const who = o.customer_name || (o.source === 'pos' ? 'Counter' : TYPE_LABEL[type]);
  const meta = `${placed} · ${typeBadge(o)}`;
  return `
    <li>
      <details class="orow" data-row-id="${o.id}"${openRows.has(o.id) ? ' open' : ''}>
        <summary class="orow__sum">
          <span class="orow__id">#${o.id}</span>
          <span class="orow__main">
            <span class="orow__name">${esc(who)}</span>
            <span class="orow__meta">${esc(meta)}</span>
          </span>
          <span class="orow__end">
            <span class="orow__total">${money(o.total)}</span>
            <span class="orow__status orow__status--${o.status === 'cancelled' ? 'cancelled' : 'completed'}">${o.status === 'cancelled' ? 'Cancelled' : 'Completed'}</span>
          </span>
        </summary>
        <ul class="orow__card">${orderHtml(o)}</ul>
      </details>
    </li>`;
}

/** Finished orders: today's as cards; each earlier day under its own heading, as rows. */
function finishedHtml(orders) {
  const today = manilaDay();
  const todays = orders.filter((o) => manilaDay(o.created_at) === today);
  const days = new Map(); // newest day first, as the list comes
  for (const o of orders) {
    const day = manilaDay(o.created_at);
    if (day !== today) days.set(day, [...(days.get(day) || []), o]);
  }
  const head = (label, n) => `<h3 class="orows__day">${esc(label)} <span class="orows__n">${plural(n, 'order')}</span></h3>`;
  let html = '';
  if (todays.length && days.size) html += `<li class="orows orows--head">${head('Today', todays.length)}</li>`;
  html += todays.map(orderHtml).join('');
  // Newest day first ('YYYY-MM-DD' sorts as dates do).
  for (const [day, list] of [...days].sort((a, b) => b[0].localeCompare(a[0]))) {
    html += `<li class="orows">${head(dayLabel(day), list.length)}<ul class="orows__list">${list.map(orderRowHtml).join('')}</ul></li>`;
  }
  return html;
}

function renderOrders(counts) {
  const list = $('orders');
  list.innerHTML = state.ordersShow === 'finished' ? finishedHtml(state.orders) : state.orders.map(orderHtml).join('');

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
  ORDER_TYPES.forEach((t) => { $(`on-${t}`).checked = s[`${t}_enabled`]; });
  showShop(s);
}

/* ---------------------------- open / closed ---------------------------- */

function showShop(s) {
  $('shop').dataset.open = s.shop_open ? '1' : '0';
  document.querySelectorAll('[data-shop]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String((btn.dataset.shop === 'open') === s.shop_open));
  });
  // Open follows the opening hours (Settings); Closed is the override.
  const hours = `${clock(s.open_at)}–${s.close_at === '24:00' ? 'midnight' : clock(s.close_at)}`;
  $('shop-state').textContent = !s.shop_open
    ? 'Closed by hand: customers can browse the menu but not order. Cake bookings still work. Tap Open to follow your opening hours again.'
    : s.closing_soon ? `Closing soon: customers can order until ${clock(s.close_at)}. The menu says so.`
    : s.open_now ? `Open: customers can order until ${clock(s.close_at)}. Opening hours ${hours}.`
    : s.preorder_days > 0
      ? `Outside opening hours (${hours}): customers can pre-order pick-up or delivery for a later time, up to ${plural(s.preorder_days, 'day')} ahead. Ordering for now opens at ${clock(s.open_at)}.`
      : `Outside opening hours (${hours}): customers can pre-order for later today only. Ordering for now opens at ${clock(s.open_at)}.`;
  // Do not overwrite a note being typed.
  if (document.activeElement !== $('closed-note')) $('closed-note').value = s.closed_note;
  showShopPill(s);
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

// Remember which older orders are open, so a refresh does not close them.
// (toggle does not bubble, so listen while it travels down.)
$('orders').addEventListener('toggle', (event) => {
  const row = event.target.closest && event.target.closest('.orow');
  if (!row) return;
  const id = Number(row.dataset.rowId);
  if (row.open) openRows.add(id);
  else openRows.delete(id);
}, true);

$('orders').addEventListener('change', (event) => {
  if (event.target.matches('[data-status-select]')) changeStatus(event.target);
});

$('orders').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-confirm], [data-block], [data-delete]');
  if (!btn) return;
  const id = Number(btn.closest('.order').dataset.orderId);
  if (btn.matches('[data-block]')) { openBlock(id); return; }
  if (btn.matches('[data-delete]')) { openDelete(id); return; }
  btn.disabled = true;
  if (!(await saveStatus(id, 'confirmed'))) btn.disabled = false;
});

$('cancel-form').addEventListener('submit', submitCancel);
$('cancel-back').addEventListener('click', () => $('cancel-dialog').close());
$('block-form').addEventListener('submit', submitBlock);
$('block-back').addEventListener('click', () => $('block-dialog').close());
$('delete-form').addEventListener('submit', submitDelete);
$('delete-back').addEventListener('click', () => $('delete-dialog').close());

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
