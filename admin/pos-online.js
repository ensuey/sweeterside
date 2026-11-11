'use strict';
/* POS: online orders. Loaded after pos-pay.js, whose openPay and
   printKitchen it uses.

   A light feed (ids, types and statuses only) is checked every 15 seconds,
   even while the POS is locked, and a bell rings for each new order. It
   rings again every 30 seconds while a New order has not been opened on
   this tablet. Opening an order needs a PIN; it shows the details and the
   next step (Confirm, Start preparing, Ready / Out for delivery / Served,
   Completed), Take payment and Cancel.

   The sound is made with Web Audio, so there is no sound file. Browsers only
   play sound after a tap on the page; the PIN pad counts. */

const ONLINE = {
  pending: [], // [{ id, order_type, status }] from the feed
  orders: [], // full orders, once someone has unlocked
  known: null, // ids seen so far, to spot new ones (null until the first check)
  opened: new Set(), // ids opened on this tablet
  current: null, // id shown in the detail
  ctx: null, // AudioContext
};
const OPENED_KEY = 'sweeterside-online-opened';
const MUTE_KEY = 'sweeterside-online-muted';
const ONLINE_POLL_MS = 15 * 1000;
const RING_EVERY_MS = 30 * 1000;
// A New order waiting longer than this gets a "Waiting N min" badge, as on the Orders page.
const ONLINE_WAITING_MIN = 10;
const ONLINE_STATUS = {
  new: 'New', confirmed: 'Confirmed', preparing: 'Preparing', delivering: 'Handed over',
  completed: 'Completed', cancelled: 'Cancelled',
};
const HANDOVER = { delivery: 'Out for delivery', pickup: 'Ready for pick-up', dinein: 'Served' };
const ONLINE_CANCEL = {
  customer: 'Customer cancelled', no_show: 'No-show / unreachable', fake: 'Fake order', other: 'Other',
};

/* ---------------------------- this tablet ---------------------------- */

try {
  ONLINE.opened = new Set(JSON.parse(localStorage.getItem(OPENED_KEY) || '[]'));
} catch {
  ONLINE.opened = new Set();
}

function saveOpened() {
  try { localStorage.setItem(OPENED_KEY, JSON.stringify([...ONLINE.opened])); } catch { /* private mode */ }
}

function isMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

function setMuted(on) {
  try { localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  showBell();
}

/* ---------------------------- the bell ---------------------------- */

function audio() {
  if (!ONLINE.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ONLINE.ctx = new Ctx();
  }
  return ONLINE.ctx;
}

/** One bell strike: a tone and a quieter overtone that fade out. */
function strike(ctx, freq, at) {
  for (const [mult, peak] of [[1, 0.45], [2.76, 0.12]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 1.25);
  }
}

function ring() {
  if (isMuted()) return;
  const ctx = audio();
  if (!ctx || ctx.state !== 'running') { showBell(); return; }
  const t = ctx.currentTime;
  strike(ctx, 1320, t);
  strike(ctx, 990, t + 0.28);
}

/** The bell button: muted or not, and a hint when the browser is holding the sound back. */
function showBell() {
  const muted = isMuted();
  const b = $('bell-btn');
  b.textContent = muted ? '🔕' : '🔔';
  b.setAttribute('aria-pressed', String(muted));
  b.title = muted ? 'New order bell is off' : 'New order bell is on';
  const ctx = ONLINE.ctx;
  $('sound-hint').hidden = muted || !!(ctx && ctx.state === 'running');
}

/* ---------------------------- the feed ---------------------------- */

/** Waiters take dine-in only. While locked nobody is signed in, so every order counts. */
function seesOrder(o) {
  if (!staffGate.can('take_orders') || staffGate.can('takeout_and_delivery')) return true;
  return o.order_type === 'dinein';
}

function unopened() {
  return ONLINE.pending.filter((o) => o.status === 'new' && !ONLINE.opened.has(o.id) && seesOrder(o));
}

function showBadge() {
  const mine = ONLINE.pending.filter(seesOrder);
  const n = $('online-n');
  n.textContent = mine.length;
  n.hidden = !mine.length;
  n.classList.toggle('nav__n--alert', unopened().length > 0);
}

async function checkOnline() {
  let list;
  try {
    ({ orders: list } = await api('/api/pos/online/pending'));
  } catch {
    return; // offline: pos.js shows the banner; try again next time
  }
  ONLINE.pending = list;
  const active = new Set(list.map((o) => o.id));
  // Forget opened ids once those orders are done.
  let pruned = false;
  for (const id of ONLINE.opened) if (!active.has(id)) { ONLINE.opened.delete(id); pruned = true; }
  if (pruned) saveOpened();

  const fresh = ONLINE.known === null ? [] : list.filter((o) => !ONLINE.known.has(o.id) && o.status === 'new' && seesOrder(o));
  ONLINE.known = new Set([...(ONLINE.known || []), ...active]);
  showBadge();
  if (fresh.length) {
    ring();
    toast(fresh.length === 1
      ? `New online order #${fresh[0].id} · ${TYPE_NAME[fresh[0].order_type] || ''}`
      : `${fresh.length} new online orders.`);
  }
  if ($('online-dialog').open) loadOnlineList().catch(() => {});
}

// Online orders name their types as the customer saw them.
const TYPE_NAME = { delivery: 'Delivery', pickup: 'Pick-up', dinein: 'Dine-in' };

/** 'HH:MM' (Manila time) -> '3:30 PM' */
function clock12(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return hhmm;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function onlineType(o) {
  if (o.scheduled_label) return `${o.order_type === 'pickup' ? 'Pick-up' : 'Delivery'} · Scheduled ${o.scheduled_label}`;
  if (o.order_type === 'pickup') return o.pickup_at === 'asap' || !o.pickup_at ? 'Pick-up · ASAP' : `Pick-up · ${clock12(o.pickup_at)}`;
  if (o.order_type === 'dinein') return `Dine-in · Table ${o.table_no}`;
  return 'Delivery';
}

/* ---------------------------- the list ---------------------------- */

async function loadOnlineList() {
  const { orders } = await staffGate.call('/api/pos/online');
  ONLINE.orders = orders;
  return orders;
}

async function showOnline() {
  const orders = await loadOnlineList();
  // Soonest first: a scheduled order by its time, the rest by when they came in.
  const due = (o) => String(o.scheduled_for || o.created_at);
  const rows = [...orders].sort((a, b) => due(a).localeCompare(due(b)) || a.id - b.id);
  $('online-empty').hidden = rows.length > 0;
  $('online-list').innerHTML = rows.map((o) => {
    const isNew = o.status === 'new' && !ONLINE.opened.has(o.id);
    const units = o.items.reduce((s, l) => s + l.qty, 0);
    // A scheduled order starts waiting 30 minutes before its time.
    const from = o.scheduled_for
      ? Math.max(new Date(`${String(o.scheduled_for).replace(' ', 'T')}Z`).getTime() - 30 * 60000,
        new Date(`${String(o.created_at).replace(' ', 'T')}Z`).getTime())
      : new Date(`${String(o.created_at).replace(' ', 'T')}Z`).getTime();
    const waited = Math.max(0, Math.floor((Date.now() - from) / 60000));
    const waiting = o.status === 'new' && o.needs_confirm && waited >= ONLINE_WAITING_MIN
      ? ` <span class="flag flag--wait">Waiting ${waited} min</span>` : '';
    return `
    <li class="tab${isNew ? ' tab--unopened' : ''}" data-online-id="${o.id}">
      <div class="tab__main">
        <span class="tab__title">${esc(onlineType(o))} · ${esc(o.customer_name)} <span class="tab__id">#${o.id}</span>${waiting}</span>
        <span class="tab__meta">${esc(ONLINE_STATUS[o.status] || o.status)} · ${plural(units, 'item')} · ${minutesAgo(o.created_at)} ago · ${o.pay_status === 'paid' ? 'Paid with GCash' : o.paid_at ? 'Paid' : 'Not paid'}</span>
      </div>
      <span class="tab__total">${money(o.total)}</span>
      <div class="tab__actions"><button class="btn btn--primary btn--sm" type="button" data-online-open>Open</button></div>
    </li>`;
  }).join('');
  if (!$('online-dialog').open) $('online-dialog').showModal();
}

/* ---------------------------- one order ---------------------------- */

async function openOnline(id) {
  ONLINE.opened.add(id);
  saveOpened();
  showBadge();
  if (!ONLINE.orders.some((o) => o.id === id)) await loadOnlineList();
  ONLINE.current = id;
  renderOnline();
  if ($('online-dialog').open) $('online-dialog').close();
  if (!$('online-detail').open) $('online-detail').showModal();
}

/** The next step for an order: [status to set, button label], or null. */
function nextStep(o) {
  if (o.status === 'new') return ['confirmed', 'Confirm'];
  if (o.status === 'confirmed') return ['preparing', 'Start preparing'];
  if (o.status === 'preparing') return ['delivering', HANDOVER[o.order_type] || 'Handed over'];
  if (o.status === 'delivering') return ['completed', 'Completed'];
  return null;
}

// Every field below was typed by a customer on the public menu: escape all of it.
function renderOnline() {
  const o = ONLINE.orders.find((x) => x.id === ONLINE.current);
  if (!o) {
    $('od-title').textContent = 'Online order';
    $('od-body').innerHTML = '<p class="hint">This order is no longer active.</p>';
    $('od-foot').innerHTML = '';
    return;
  }
  const status = o.status === 'delivering' ? HANDOVER[o.order_type] || 'Handed over' : ONLINE_STATUS[o.status];
  $('od-title').textContent = `Online order #${o.id} · ${onlineType(o)}`;
  const lines = o.items.map((l) => `
    <div><dt>${l.qty} × ${esc(l.name)}${l.options_text ? `<span class="order__opts">${esc(l.options_text)}</span>` : ''}${l.note ? ` <em class="order__note">${esc(l.note)}</em>` : ''}</dt><dd>${money(l.price * l.qty)}</dd></div>`).join('');
  const sum = [
    ['Subtotal', o.subtotal],
    o.sc_pwd_discount > 0 && ['SC/PWD 20%', -o.sc_pwd_discount],
    o.vat_exempt > 0 && ['VAT exempt', -o.vat_exempt],
    o.discount > 0 && [`Voucher ${o.voucher_code}`, -o.discount],
    o.delivery_fee > 0 && ['Delivery fee', o.delivery_fee],
  ].filter(Boolean).map(([label, v]) => `<div><dt>${esc(label)}</dt><dd>${v < 0 ? `−${money(-v)}` : money(v)}</dd></div>`).join('');
  const cash = o.order_type === 'delivery' && !orderPaid(o) && o.cash > 0
    ? `<p class="od__cash">Customer pays with ${money(o.cash)}${o.change_due > 0 ? ` · bring ${money(o.change_due)} change` : ' · exact amount'}</p>` : '';
  const flags = [
    o.blocked && '<span class="flag flag--bad">Blocked number</span>',
    o.history && `<span class="flag">${o.history.orders === 0 ? 'First order' : `${o.history.completed} completed${o.history.no_show ? ` · ${o.history.no_show} no-show` : ''}${o.history.fake ? ` · ${o.history.fake} fake` : ''}`}</span>`,
  ].filter(Boolean).join('');

  $('od-body').innerHTML = `
    <p class="od__state"><strong>${esc(status)}</strong> · ${o.pay_status === 'paid' ? '<span class="flag flag--good">Paid with GCash</span>' : o.paid_at ? '<span class="flag flag--good">Paid</span>' : 'Not paid'} · ${minutesAgo(o.created_at)} ago</p>
    <div class="od__who">
      <span class="od__name">${esc(o.customer_name)}</span>
      ${o.phone ? `<a href="tel:${esc(o.phone_norm || o.phone)}">${esc(o.phone)}</a>` : ''}
      ${o.order_type === 'delivery' && o.delivery_area ? `<span class="order__area"><strong>Area:</strong> ${esc(o.delivery_area)}${o.fee_to_confirm ? ' <span class="flag flag--warn">Fee to confirm</span>' : ''}</span>` : ''}
      ${o.order_type === 'delivery' ? `<span>${esc(o.address)}</span>` : ''}
      ${o.order_type === 'delivery' && o.landmark ? `<span><strong>Landmark:</strong> ${esc(o.landmark)}</span>` : ''}
      ${flags ? `<span class="order__flags">${flags}</span>` : ''}
    </div>
    <dl class="paysum od__lines">${lines}</dl>
    <dl class="paysum">${sum}<div class="is-total"><dt>Total</dt><dd>${money(o.total)}</dd></div></dl>
    ${cash}
    <details class="od__cancel">
      <summary>Cancel this order…</summary>
      <div class="field">
        <label for="od-reason">Why?</label>
        <select id="od-reason">
          <option value="">Choose a reason</option>
          ${Object.entries(ONLINE_CANCEL).map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn--danger-ghost btn--sm" type="button" data-od-cancel>Cancel order</button>
    </details>
    <p class="field__err" id="od-err" hidden></p>`;

  const step = nextStep(o);
  const canPay = !orderPaid(o) && staffGate.can('take_payment');
  const foot = [];
  foot.push('<button class="btn btn--ghost" type="button" data-od-kitchen>Kitchen ticket</button>');
  foot.push('<span class="modal__spacer"></span>');
  if (step && step[0] === 'completed' && !orderPaid(o)) {
    // Handed over but not paid: take the money first. Completing anyway stays possible.
    foot.push(`<button class="link-quiet" type="button" data-od-step="completed">Complete without payment</button>`);
    if (canPay) foot.push('<button class="btn btn--primary" type="button" data-od-pay>Take payment</button>');
  } else {
    if (canPay) foot.push('<button class="btn btn--ghost" type="button" data-od-pay>Take payment</button>');
    if (step) foot.push(`<button class="btn btn--primary" type="button" data-od-step="${step[0]}">${esc(step[1])}</button>`);
  }
  $('od-foot').innerHTML = foot.join('');
}

function onlineError(e) {
  const el = $('od-err');
  if (!el) return toast(e.message, 'error');
  el.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
  el.hidden = false;
}

async function moveOnline(status, reason) {
  const id = ONLINE.current;
  try {
    const { order } = await staffGate.call(`/api/pos/online/${id}`, { method: 'PATCH', body: reason ? { status, reason } : { status } });
    toast(`Order #${id}: ${status === 'delivering' ? HANDOVER[order.order_type] : ONLINE_STATUS[status]}.`);
    if (status === 'preparing') printKitchen(id).catch((e) => toast(e.message, 'error'));
    await loadOnlineList();
    checkOnline();
    if (['completed', 'cancelled'].includes(status)) { $('online-detail').close(); return; }
    renderOnline();
  } catch (e) {
    onlineError(e);
  }
}

/* ---------------------------- start ---------------------------- */

function bindOnline() {
  $('online-btn').addEventListener('click', () => showOnline().catch((e) => toast(e.message, 'error')));
  $('online-close').addEventListener('click', () => $('online-dialog').close());
  $('od-close').addEventListener('click', () => $('online-detail').close());
  $('online-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-online-id]');
    if (row) openOnline(Number(row.dataset.onlineId)).catch((err) => toast(err.message, 'error'));
  });
  $('online-detail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-od-step], [data-od-pay], [data-od-kitchen], [data-od-cancel]');
    if (!b) return;
    if (b.matches('[data-od-step]')) return moveOnline(b.dataset.odStep);
    if (b.matches('[data-od-kitchen]')) return printKitchen(ONLINE.current).catch((err) => toast(err.message, 'error'));
    if (b.matches('[data-od-pay]')) {
      $('online-detail').close();
      return openPay(ONLINE.current, { from: 'pos-online' }).catch((err) => toast(err.message, 'error'));
    }
    const reason = $('od-reason').value;
    if (!reason) return onlineError(new Error('Choose why the order is cancelled.'));
    return moveOnline('cancelled', reason);
  });
  $('bell-btn').addEventListener('click', () => {
    setMuted(!isMuted());
    if (!isMuted()) ring(); // let them hear it is on
  });
  $('sound-hint').addEventListener('click', () => { /* the tap itself turns sound on */ });
  // The first tap on the page lets the browser play sound.
  document.addEventListener('pointerdown', () => {
    const ctx = audio();
    if (!ctx) return;
    // Made during a tap, it may already be running; otherwise ask to resume.
    if (ctx.state === 'running') showBell();
    else ctx.resume().then(showBell).catch(() => {});
  });
  staffGate.onChange(showBadge);
  showBell();
}

/** Called once the POS has started. */
function startOnline() {
  checkOnline();
  setInterval(checkOnline, ONLINE_POLL_MS);
  setInterval(() => { if (unopened().length) ring(); }, RING_EVERY_MS);
}

bindOnline();
