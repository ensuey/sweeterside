'use strict';
/* The POS screen: the menu on the left, the ticket on the right (two panels
   on a phone). Loaded after common.js and staff-gate.js.

   The tablet never works out money itself: every change asks the server for
   a quote (the same pricing engine as the saved order), and the totals on
   screen are the server's. The ticket being built is kept in sessionStorage
   after every change, so a reload or a dropped connection does not lose it;
   while offline, saving and sending are paused. Each save carries a request
   key: tapping twice, or retrying after the connection drops, saves once. */

const P = {
  menu: [], cats: [], cat: 'all', q: '', settings: {},
  t: null, // the ticket
  quote: null, needs: [], voids: [], quoteSeq: 0, quoteTimer: null,
  online: navigator.onLine, saving: false,
};
const TICKET_KEY = 'ss_pos_ticket';
const TYPE_LABEL = { dinein: 'Dine-in', pickup: 'Takeout', delivery: 'Delivery' };
const STATUS_LABEL = { new: 'Held', confirmed: 'In the kitchen', preparing: 'Preparing', delivering: 'Ready' };
const NOTE_CHIPS = ['Less sugar', 'No ice', 'Less ice', 'Extra hot', 'No onions', 'Take home'];
const FEW_LEFT = 5;

/* ---------------------------- the ticket ---------------------------- */

function newKey() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function blankDiscounts() {
  return { voucher_code: '', manual: null, claimants: [], diners: null, service_removed_reason: null, delivery_fee: null, fee_reason: '' };
}

function blankTicket() {
  return {
    id: null, version: null, status: null, held: true, type: 'dinein', table_no: '', pax: '',
    customer_name: '', phone: '', address: '', landmark: '', lines: [],
    discounts: blankDiscounts(), discountsTouched: false, pendingKey: null,
  };
}

/** A saved POS order (from the server) as a ticket on screen. */
function fromOrder(o) {
  const i = o.input || {};
  const manual = i.manual ? {
    kind: i.manual.kind, value: i.manual.kind === 'percent' ? i.manual.bp / 100 : i.manual.cents / 100,
    line: i.manual.line || '', reason: i.manual.reason,
  } : null;
  return {
    id: o.id, version: o.version, status: o.status, held: o.held, type: o.order_type,
    table_no: o.table_no || '', pax: o.pax ?? '', customer_name: o.customer_name || '', phone: o.phone_norm || o.phone || '',
    address: o.address || '', landmark: o.landmark || '',
    lines: o.lines.filter((l) => l.qty > 0).map((l) => ({
      id: l.id, key: l.key, item_id: l.item_id, name: l.name, qty: l.qty, note: l.note,
      sent: l.sent_qty - l.voided_qty, unit_cents: l.unit_cents,
      price: l.override_cents === null ? null : l.override_cents / 100, price_reason: l.override_reason,
      sc_eligible: l.sc_eligible,
    })),
    discounts: {
      voucher_code: i.voucher_code || '', manual, claimants: i.claimants || [], diners: i.diners ?? null,
      service_removed_reason: i.service_removed_reason ?? null,
      delivery_fee: i.delivery_fee_cents === null || i.delivery_fee_cents === undefined ? null : i.delivery_fee_cents / 100,
      fee_reason: i.fee_reason || '',
    },
    discountsTouched: false, pendingKey: null,
  };
}

function persist() {
  try {
    if (P.t.id || P.t.lines.length) sessionStorage.setItem(TICKET_KEY, JSON.stringify(P.t));
    else sessionStorage.removeItem(TICKET_KEY);
  } catch { /* private mode: kept in memory only */ }
}

/** After any edit: the old request key is for a different ticket now. */
function changed({ discounts = false } = {}) {
  P.t.pendingKey = null;
  if (discounts) P.t.discountsTouched = true;
  persist();
  renderTicket();
  requestQuote();
}

const canDiscount = () => ['apply_voucher', 'manual_discount', 'claim_sc_pwd'].some((p) => staffGate.can(p));

/** The ticket as the server wants it. */
function payload() {
  const t = P.t;
  const body = {
    version: t.version, type: t.type, table_no: t.table_no, pax: t.pax === '' ? null : Number(t.pax),
    customer_name: t.customer_name, phone: t.phone, address: t.address, landmark: t.landmark,
    lines: t.lines.map((l) => ({
      id: l.id || undefined, key: l.key, item_id: l.item_id, qty: l.qty, note: l.note,
      price: l.price, price_reason: l.price_reason,
    })),
  };
  // Waiters never send discounts, so a cashier's discounts on a tab stay as they are.
  if (t.discountsTouched) body.discounts = { ...t.discounts };
  return body;
}

/* ---------------------------- menu ---------------------------- */

async function loadMenu() {
  const data = await staffGate.call('/api/pos/menu');
  P.menu = data.items;
  P.cats = data.categories;
  P.settings = data;
  renderCats();
  renderGrid();
}

function renderCats() {
  const used = new Set(P.menu.map((i) => i.category_id));
  const cats = [{ id: 'all', label: 'All' }, ...P.cats.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, label: c.label || c.name }))];
  $('cats').innerHTML = cats.map((c) => `
    <button type="button" class="cat" data-cat="${c.id}" aria-pressed="${String(String(P.cat) === String(c.id))}">${esc(c.label)}</button>`).join('');
}

/** The item's photo: a window onto a menu poster, or the whole photo. */
function shotHtml(i) {
  const src = esc(`/${encPath(i.image)}`);
  if (i.crop_w != null) {
    return `<div class="shot" style="--x:${i.crop_x}; --y:${i.crop_y}; --w:${i.crop_w}; --h:${i.crop_h}"><img src="${src}" alt="" loading="lazy"></div>`;
  }
  return `<div class="shot shot--plain"><img src="${src}" alt="" loading="lazy"></div>`;
}

function renderGrid() {
  const q = P.q.trim().toLowerCase();
  const items = P.menu.filter((i) => (P.cat === 'all' || String(i.category_id) === String(P.cat))
    && (!q || i.name.toLowerCase().includes(q)));
  $('grid').innerHTML = items.map((i) => {
    const onSale = i.sale_price < i.price;
    const left = !i.sold_out && i.remaining !== null && i.remaining <= FEW_LEFT
      ? `<span class="item__left">${i.remaining} left</span>` : '';
    return `<li><button type="button" class="item" data-id="${i.id}" ${i.sold_out ? 'disabled aria-disabled="true"' : ''}>
      ${shotHtml(i)}
      <span class="item__name">${esc(i.name)}</span>
      <span class="item__price">${onSale ? `<s>${money(i.price)}</s> ` : ''}${money(i.sale_price)}</span>
      ${i.sold_out ? '<span class="item__out">Sold out</span>' : left}
    </button></li>`;
  }).join('') || '<li class="grid__empty">No items match.</li>';
}

/* ---------------------------- adding and changing lines ---------------------------- */

function addItem(id) {
  const item = P.menu.find((i) => i.id === Number(id));
  if (!item || item.sold_out) return;
  // Another of the same plain item goes on the same line.
  const same = P.t.lines.find((l) => l.item_id === item.id && !l.note && l.price === null);
  if (same) same.qty += 1;
  else {
    P.t.lines.push({
      id: null, key: `n${newKey().slice(0, 12)}`, item_id: item.id, name: item.name, qty: 1, note: '',
      sent: 0, unit_cents: item.sale_price * 100, price: null, price_reason: '', sc_eligible: item.sc_eligible,
    });
  }
  changed();
  const row = $('tlines').querySelector(`[data-key="${CSS.escape((same || P.t.lines[P.t.lines.length - 1]).key)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function step(key, by) {
  const l = P.t.lines.find((x) => x.key === key);
  if (!l) return;
  l.qty = Math.max(0, l.qty + by);
  // A line never sent leaves the ticket at 0; a sent one stays (as a void) until saved.
  if (l.qty === 0 && !l.sent) P.t.lines = P.t.lines.filter((x) => x !== l);
  changed();
}

/* ---------------------------- quoting ---------------------------- */

function requestQuote() {
  clearTimeout(P.quoteTimer);
  if (!P.t.lines.some((l) => l.qty > 0)) {
    P.quote = null;
    P.needs = [];
    P.voids = [];
    renderSummary();
    return;
  }
  P.quoteTimer = setTimeout(runQuote, 250);
}

// Errors about the customer's details are shown on Save; the running total
// only shows problems with items and discounts.
const QUOTE_FIELDS = ['lines', 'voucher', 'manual', 'claimants', 'diners', 'delivery_fee', 'service', 'items'];

async function runQuote() {
  if (!P.online) return;
  const seq = ++P.quoteSeq;
  try {
    const q = await staffGate.call('/api/pos/quote', { method: 'POST', body: { ...payload(), id: P.t.id } });
    if (seq !== P.quoteSeq) return;
    P.quote = q.pricing;
    P.needs = q.needs;
    P.voids = q.voids;
    ticketError('');
  } catch (e) {
    if (seq !== P.quoteSeq) return;
    if (e.offline) return setOnline(false);
    const fields = e.fields || {};
    const shown = QUOTE_FIELDS.map((f) => fields[f]).filter(Boolean);
    ticketError(e.status === 422 ? shown.join(' ') : e.message);
    if (e.status !== 422 || shown.length) {
      P.quote = null;
      P.needs = [];
    }
  }
  renderSummary();
}

/* ---------------------------- rendering ---------------------------- */

function ticketError(msg) {
  const el = $('ticket-error');
  el.textContent = msg;
  el.hidden = !msg;
}

function lineNet(key) {
  const l = P.quote && P.quote.lines.find((x) => x.key === key || x.key === `new-${key}`);
  return l ? l.net : null;
}

function renderTicket() {
  const t = P.t;
  $('ticket-title').textContent = t.id
    ? (t.type === 'dinein' ? `Table ${t.table_no || '?'} · #${t.id}` : `${TYPE_LABEL[t.type]} · #${t.id}`)
    : 'New ticket';
  const state = $('ticket-state');
  state.textContent = t.id ? (t.held ? 'Held' : STATUS_LABEL[t.status] || '') : '';
  state.dataset.held = t.held ? '1' : '0';

  for (const b of $('types').querySelectorAll('[data-type]')) b.setAttribute('aria-checked', String(b.dataset.type === t.type));
  for (const type of ['dinein', 'pickup', 'delivery']) $(`fields-${type}`).hidden = t.type !== type;
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v ?? ''; };
  set('t-table', t.table_no);
  set('t-pax', t.pax);
  set('t-name', t.customer_name);
  set('d-name', t.customer_name);
  set('d-phone', t.phone);
  set('d-address', t.address);
  set('d-landmark', t.landmark);

  const lines = t.lines;
  $('tempty').hidden = lines.length > 0;
  $('tlines').innerHTML = lines.map((l) => {
    const net = lineNet(l.key);
    const each = l.price !== null ? l.price * 100 : l.unit_cents;
    const off = l.qty < l.sent;
    return `<li class="tline${l.qty === 0 ? ' tline--off' : ''}" data-key="${esc(l.key)}">
      <button type="button" class="tline__main" data-edit>
        <span class="tline__name">${esc(l.name)}</span>
        <span class="tline__meta">${moneyC(each)} each${l.price !== null ? ' · price changed' : ''}${l.sent ? ` · ${l.sent} sent` : ''}</span>
        ${l.note ? `<span class="tline__note">${esc(l.note)}</span>` : ''}
        ${off ? `<span class="tline__void">${l.sent - l.qty} to void</span>` : ''}
      </button>
      <div class="stepper" role="group" aria-label="Quantity of ${esc(l.name)}">
        <button type="button" class="stepper__btn" data-step="-1" aria-label="One less">−</button>
        <span class="stepper__n">${l.qty}</span>
        <button type="button" class="stepper__btn" data-step="1" aria-label="One more">+</button>
      </div>
      <span class="tline__total">${net === null ? moneyC(each * l.qty) : moneyC(net)}</span>
    </li>`;
  }).join('');

  renderDiscounts();
  renderSummary();
  $('void-btn').hidden = !t.id;
  $('save-btn').textContent = t.type === 'dinein' ? 'Save tab' : 'Save';
}

function renderDiscounts() {
  const t = P.t;
  const d = t.discounts;
  const svc = P.settings.service_charge || {};
  const svcApplies = svc.on && svc.types.includes(t.type);
  const show = canDiscount() || svcApplies || t.type === 'delivery' || d.claimants.length || d.manual || d.voucher_code;
  $('disc').hidden = !show;
  $('row-voucher').hidden = !staffGate.can('apply_voucher') && !d.voucher_code;
  $('row-manual').hidden = !staffGate.can('manual_discount') && !d.manual;
  $('row-sc').hidden = !staffGate.can('claim_sc_pwd') && !d.claimants.length;
  $('sc-add').hidden = !staffGate.can('claim_sc_pwd');
  $('m-open').hidden = !staffGate.can('manual_discount');
  $('v-apply').hidden = $('v-code').disabled = !staffGate.can('apply_voucher');
  if (document.activeElement !== $('v-code')) $('v-code').value = d.voucher_code;
  $('v-apply').textContent = d.voucher_code ? 'Remove' : 'Apply';
  $('m-val').textContent = d.manual
    ? `${d.manual.kind === 'percent' ? `${d.manual.value}%` : money(d.manual.value)} off${d.manual.line ? ' one item' : ''} · ${d.manual.reason}`
    : '';
  $('m-open').textContent = d.manual ? 'Change discount…' : 'Manual discount…';
  const canSee = staffGate.can('see_id_numbers');
  $('claimants').innerHTML = d.claimants.map((c, i) => `<li>
      <span>${c.type === 'sc' ? 'SC' : 'PWD'} · ${esc(c.name)} · ${esc(canSee ? c.id_no : String(c.id_no).replace(/^.*(.{4})$/, '****$1'))}
        · ${c.mode === 'shared' ? `shared by ${d.diners}` : 'own items'}</span>
      ${staffGate.can('claim_sc_pwd') ? `<button type="button" class="link" data-claimant="${i}">Edit</button>` : ''}
    </li>`).join('');
  $('row-service').hidden = !svcApplies;
  if (svcApplies) {
    $('svc-text').textContent = d.service_removed_reason
      ? `Service charge removed: ${d.service_removed_reason}`
      : `Service charge ${svc.rate_bp / 100}%`;
    $('svc-toggle').textContent = d.service_removed_reason ? 'Add back' : 'Remove…';
    $('svc-toggle').hidden = !staffGate.can('remove_service_charge');
  }
  $('row-fee').hidden = t.type !== 'delivery';
  if (document.activeElement !== $('fee')) $('fee').value = d.delivery_fee ?? '';
  $('fee').placeholder = String(P.settings.delivery_fee ?? '');
  if (document.activeElement !== $('fee-reason')) $('fee-reason').value = d.fee_reason;
  $('fee').disabled = $('fee-reason').disabled = !staffGate.can('change_delivery_fee');
  const n = [d.voucher_code, d.manual, ...d.claimants, d.service_removed_reason, d.delivery_fee !== null].filter(Boolean).length;
  $('disc-n').textContent = n ? `(${n})` : '';
}

function renderSummary() {
  const q = P.quote;
  const rows = [];
  if (q) {
    const t = q.totals;
    rows.push(['Items', t.gross]);
    if (t.sale_discount) rows.push(['Sale prices', -t.sale_discount]);
    for (const c of q.claimants) {
      if (c.applied === 'sc_pwd') {
        if (c.vat_exempt) rows.push([`VAT exempt (${c.type.toUpperCase()} ${c.name})`, -c.vat_exempt]);
        rows.push([`${c.type === 'sc' ? 'SC' : 'PWD'} 20% (${c.name})`, -c.discount]);
      } else {
        rows.push([`${c.type.toUpperCase()} ${c.name}: sale/voucher price was lower`, null]);
      }
    }
    if (q.voucher) rows.push([`Voucher ${q.voucher.code}`, -q.voucher.discount]);
    if (q.manual) rows.push([`Discount (${q.manual.reason})`, -q.manual.discount]);
    if (q.service.applies && !q.service.removed_reason) rows.push([`Service charge ${q.service.rate_bp / 100}%`, q.service.amount]);
    if (t.delivery_fee) rows.push(['Delivery fee', t.delivery_fee]);
    rows.push(['Total', t.total, true]);
  }
  $('tsum').innerHTML = rows.map(([label, cents, total]) => `
    <div class="${total ? 'is-total' : ''}"><dt>${esc(label)}</dt><dd>${cents === null ? '' : `${cents < 0 ? '−' : ''}${moneyC(Math.abs(cents))}`}</dd></div>`).join('');
  $('switch-total').textContent = q ? moneyC(q.totals.total) : '';

  const needs = [...P.needs];
  $('needs').hidden = !needs.length;
  $('needs').textContent = needs.length
    ? `Needs the owner: ${needs.map((n) => staffGate.NEEDS[n] || n).join(', ').toLowerCase()}.`
    : '';
  for (const l of P.t.lines) {
    const el = $('tlines').querySelector(`[data-key="${CSS.escape(l.key)}"] .tline__total`);
    const net = lineNet(l.key);
    if (el && net !== null) el.textContent = moneyC(net);
  }
  const blocked = !P.online || P.saving;
  $('save-btn').disabled = blocked || !P.t.lines.length;
  $('send-btn').disabled = blocked || !P.t.lines.some((l) => l.qty > 0);
}

/* ---------------------------- saving ---------------------------- */

function setOnline(on) {
  P.online = on;
  $('offline').hidden = on;
  $('net').hidden = on;
  renderSummary();
  if (on) requestQuote();
}

/** A one-line question in a dialog. @returns the text, '' for a confirm, or null if cancelled. */
function ask({ title, lead = '', label = 'Reason', input = true, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('reason-dialog');
    $('reason-title').textContent = title;
    $('reason-lead').textContent = lead;
    $('reason-lead').hidden = !lead;
    $('reason-label').textContent = label;
    $('reason-text').value = '';
    $('reason-text').closest('.field').hidden = !input;
    $('reason-err').hidden = true;
    $('reason-ok').textContent = ok;
    $('reason-ok').className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
    const finish = (v) => {
      $('reason-form').onsubmit = null;
      $('reason-cancel').onclick = null;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    $('reason-form').onsubmit = (e) => {
      e.preventDefault();
      const v = $('reason-text').value.trim();
      if (input && !v) {
        $('reason-err').textContent = `Enter the ${label.toLowerCase()}.`;
        $('reason-err').hidden = false;
        return;
      }
      finish(input ? v : '');
    };
    $('reason-cancel').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
    if (input) $('reason-text').focus();
  });
}

function showFieldErrors(fields) {
  const msgs = Object.values(fields || {});
  $('fields-err').textContent = msgs.join(' ');
  $('fields-err').hidden = !msgs.length;
}

/**
 * Save the ticket (and send it to the kitchen). Owner approval, a void
 * reason or a fresh copy are asked for as the server needs them.
 */
async function submit(send) {
  if (!P.online) return toast('No connection: the ticket is kept here until it is back.', 'error');
  if (P.saving) return;
  const t = P.t;
  if (!t.lines.length) return;
  P.saving = true;
  renderSummary();
  showFieldErrors(null);
  ticketError('');
  t.pendingKey = t.pendingKey || newKey();
  persist();

  const extra = {};
  try {
    if (P.voids.length) {
      const reason = await ask({
        title: 'Take off sent items',
        lead: `${P.voids.map((v) => `${v.units} × ${v.name}`).join(', ')} already went to the kitchen.`,
        label: 'Reason', ok: 'Void them', danger: true,
      });
      if (reason === null) return;
      extra.void_reason = reason;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const body = { ...payload(), request_key: t.pendingKey, send, ...extra };
        const res = t.id
          ? await staffGate.call(`/api/pos/orders/${t.id}`, { method: 'PUT', body })
          : await staffGate.call('/api/pos/orders', { method: 'POST', body });
        return saved(res, send);
      } catch (e) {
        if (e.offline) {
          setOnline(false);
          return toast('No connection: nothing was lost, the ticket is kept here. Try again when it is back.', 'error');
        }
        const data = e.data || {};
        if (e.status === 403 && data.wrong_pin) {
          toast(e.message, 'error');
          delete extra.override;
          continue;
        }
        if (e.status === 403 && data.override_required) {
          const ov = await staffGate.askOverride(data.needs);
          if (!ov) return;
          extra.override = { staff_id: ov.staff_id, pin: ov.pin };
          continue;
        }
        if (e.status === 422 && e.fields && e.fields.void_reason) {
          const reason = await ask({ title: 'Take off sent items', label: 'Reason', ok: 'Void them', danger: true });
          if (reason === null) return;
          extra.void_reason = reason;
          continue;
        }
        if (e.status === 409 && data.stale) {
          const ok = await ask({ title: 'Changed on another device', lead: 'Someone else changed this tab. Load their version? Your changes here will be dropped.', input: false, ok: 'Load it' });
          if (ok !== null) await openOrder(t.id, { force: true });
          return;
        }
        if (e.status === 422) {
          showFieldErrors(e.fields);
          return;
        }
        ticketError(e.message);
        return;
      }
    }
  } finally {
    P.saving = false;
    renderSummary();
  }
}

function saved(res, send) {
  const o = res.order;
  const what = o.order_type === 'dinein' ? `Table ${o.table_no}` : `#${o.id}`;
  if (send) {
    const list = res.kitchen.map((k) => `${k.qty} × ${k.name}`).join(', ');
    toast(res.kitchen.length ? `${what} sent to the kitchen: ${list}` : `${what} saved. Nothing new for the kitchen.`);
  } else {
    toast(`${what} saved.`);
  }
  startNew();
  refreshTabs();
  loadMenu().catch(() => {});
}

function startNew() {
  P.t = blankTicket();
  P.quote = null;
  P.needs = [];
  P.voids = [];
  showFieldErrors(null);
  ticketError('');
  persist();
  renderTicket();
  showPanel('menu');
}

/** Load a saved order onto the screen. Asks first if the current ticket has unsaved items. */
async function openOrder(id, { force = false } = {}) {
  if (!force && !P.t.id && P.t.lines.length) {
    const ok = await ask({ title: 'Drop this ticket?', lead: 'The ticket you are building has not been saved.', input: false, ok: 'Drop it', danger: true });
    if (ok === null) return;
  }
  const { order } = await staffGate.call(`/api/pos/orders/${id}`);
  P.t = fromOrder(order);
  P.quote = order.pricing;
  P.needs = [];
  P.voids = [];
  persist();
  renderTicket();
  showPanel('ticket');
}

async function voidTicket() {
  const t = P.t;
  if (!t.id) return;
  const sent = t.lines.some((l) => l.sent > 0);
  const reason = sent
    ? await ask({ title: 'Void this order', lead: 'Part of it is already in the kitchen.', label: 'Reason', ok: 'Void order', danger: true })
    : await ask({ title: 'Discard this tab?', lead: 'Nothing was sent to the kitchen yet.', input: false, ok: 'Discard', danger: true });
  if (reason === null) return;
  const body = { reason };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await staffGate.call(`/api/pos/orders/${t.id}/void`, { method: 'POST', body });
      toast(sent ? `Order #${t.id} voided.` : `Tab #${t.id} discarded.`);
      startNew();
      refreshTabs();
      loadMenu().catch(() => {});
      return;
    } catch (e) {
      const data = e.data || {};
      if (e.status === 403 && data.override_required) {
        const ov = await staffGate.askOverride(data.needs);
        if (!ov) return;
        body.override = { staff_id: ov.staff_id, pin: ov.pin };
        continue;
      }
      if (e.status === 403 && data.wrong_pin) { toast(e.message, 'error'); delete body.override; continue; }
      return toast(e.message, 'error');
    }
  }
}

/* ---------------------------- open tabs ---------------------------- */

async function refreshTabs() {
  try {
    const { orders } = await staffGate.call('/api/pos/open');
    P.open = orders;
    $('tabs-n').textContent = orders.length;
    $('tabs-n').hidden = !orders.length;
    return orders;
  } catch (e) {
    if (e.offline) setOnline(false);
    return P.open || [];
  }
}

function tabTitle(o) {
  if (o.order_type === 'dinein') return `Table ${o.table_no}`;
  return `${TYPE_LABEL[o.order_type]}${o.customer_name ? ` · ${o.customer_name}` : ''}`;
}

function minutesAgo(sql) {
  const d = new Date(`${String(sql).replace(' ', 'T')}Z`);
  const m = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function showTabs() {
  const orders = await refreshTabs();
  const dineins = orders.filter((o) => o.order_type === 'dinein');
  $('tabs-empty').hidden = orders.length > 0;
  $('tabs').innerHTML = orders.map((o) => `
    <li class="tab" data-id="${o.id}">
      <div class="tab__main">
        <span class="tab__title">${esc(tabTitle(o))} <span class="tab__id">#${o.id}</span></span>
        <span class="tab__meta">${o.held ? 'Held' : 'In the kitchen'} · ${plural(o.units, 'item')} · ${minutesAgo(o.created_at)}${o.taken_by ? ` · ${esc(o.taken_by)}` : ''}${o.unsent_lines && !o.held ? ' · new items not sent' : ''}</span>
      </div>
      <span class="tab__total">${money(o.total)}</span>
      <div class="tab__actions">
        <button class="btn btn--primary btn--sm" type="button" data-open>Open</button>
        ${o.order_type === 'dinein' ? '<button class="btn btn--ghost btn--sm" type="button" data-move>Move</button>' : ''}
        ${o.order_type === 'dinein' && dineins.length > 1 ? `
          <label class="vh" for="merge-${o.id}">Merge table ${esc(o.table_no)} into</label>
          <select id="merge-${o.id}" data-merge-into>
            <option value="">Merge into…</option>
            ${dineins.filter((x) => x.id !== o.id).map((x) => `<option value="${x.id}">Table ${esc(x.table_no)} (#${x.id})</option>`).join('')}
          </select>` : ''}
      </div>
    </li>`).join('');
  if (!$('tabs-dialog').open) $('tabs-dialog').showModal();
}

/* ---------------------------- line, discount and SC/PWD dialogs ---------------------------- */

let editing = null;

function openLine(key) {
  const l = P.t.lines.find((x) => x.key === key);
  if (!l) return;
  editing = l;
  $('line-title').textContent = l.name;
  $('line-note').value = l.note;
  $('note-chips').innerHTML = NOTE_CHIPS.map((c) => `<button type="button" class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
  $('line-price').value = l.price ?? '';
  $('line-price').placeholder = (l.unit_cents / 100).toFixed(2);
  $('line-price-reason').value = l.price_reason || '';
  $('line-sent').hidden = !l.sent;
  $('line-sent').textContent = l.sent ? `${l.sent} already sent to the kitchen. Taking them off is a void.` : '';
  $('line-remove').textContent = l.sent ? 'Void this line' : 'Remove';
  $('line-dialog').showModal();
}

function saveLine() {
  const l = editing;
  l.note = $('line-note').value.trim();
  const raw = $('line-price').value.trim();
  const price = raw === '' ? null : Math.round(Number(raw) * 100) / 100;
  if (price !== null && (!Number.isFinite(price) || price < 0)) return toast('Enter the price in pesos.', 'error');
  l.price = price;
  l.price_reason = price === null ? '' : $('line-price-reason').value.trim();
  if (price !== null && !l.price_reason) return toast('Give a reason for the price change.', 'error');
  $('line-dialog').close();
  changed();
}

function openManual() {
  const d = P.t.discounts;
  if (d.voucher_code) return toast('Remove the voucher first: one or the other.', 'error');
  const m = d.manual || { kind: 'percent', value: '', line: '', reason: '' };
  P.manualKind = m.kind;
  for (const b of $('m-kind').querySelectorAll('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === m.kind));
  $('m-value').value = m.value;
  $('m-line').innerHTML = `<option value="">Whole order</option>${P.t.lines.filter((l) => l.qty > 0)
    .map((l) => `<option value="${esc(l.key)}">${esc(l.name)}${l.note ? ` (${esc(l.note)})` : ''}</option>`).join('')}`;
  $('m-line').value = m.line || '';
  const presets = [...$('m-reason').options].map((o) => o.value);
  $('m-reason').value = presets.includes(m.reason) ? m.reason : (m.reason ? 'other' : '');
  $('m-other').value = presets.includes(m.reason) ? '' : m.reason;
  $('m-other-box').hidden = $('m-reason').value !== 'other';
  const limit = (P.settings.cashier_discount_limit_bp || 0) / 100;
  $('m-limit').textContent = staffGate.staff.role === 'owner' ? '' : `Up to ${limit}% without the owner.`;
  $('m-err').hidden = true;
  $('m-remove').hidden = !d.manual;
  $('manual-dialog').showModal();
}

function saveManual() {
  const value = Number($('m-value').value);
  const reason = $('m-reason').value === 'other' ? $('m-other').value.trim() : $('m-reason').value;
  const err = !(value > 0) ? 'Enter how much to take off.'
    : P.manualKind === 'percent' && value > 100 ? 'Take at most 100% off.'
      : !reason ? 'Choose a reason.' : '';
  if (err) {
    $('m-err').textContent = err;
    $('m-err').hidden = false;
    return;
  }
  P.t.discounts.manual = { kind: P.manualKind, value, line: $('m-line').value, reason };
  $('manual-dialog').close();
  changed({ discounts: true });
}

let editingClaimant = null;

function openClaimant(index) {
  const d = P.t.discounts;
  editingClaimant = index;
  const c = index === null ? { type: 'sc', name: '', id_no: '', signature: false, mode: 'exclusive', lines: {} } : d.claimants[index];
  P.scType = c.type;
  for (const b of $('sc-type').querySelectorAll('[data-sc]')) b.setAttribute('aria-checked', String(b.dataset.sc === c.type));
  $('sc-id-label').textContent = c.type === 'sc' ? 'OSCA ID number' : 'PWD ID number';
  $('sc-name').value = c.name;
  $('sc-id').value = c.id_no;
  $('sc-sig').checked = c.signature;
  for (const r of document.getElementsByName('sc-mode')) r.checked = r.value === c.mode;
  $('sc-diners').value = d.diners ?? (P.t.pax || '');
  $('sc-lines').innerHTML = P.t.lines.filter((l) => l.qty > 0).map((l) => {
    const taken = c.lines[l.key] || 0;
    return `<li class="sc-line${l.sc_eligible ? '' : ' is-off'}">
      <span>${esc(l.name)}${l.sc_eligible ? '' : ' <small>(no SC/PWD discount)</small>'}</span>
      <label class="vh" for="sc-q-${esc(l.key)}">How many ${esc(l.name)} are theirs</label>
      <select id="sc-q-${esc(l.key)}" data-sc-line="${esc(l.key)}" ${l.sc_eligible ? '' : 'disabled'}>
        ${Array.from({ length: l.qty + 1 }, (_, n) => `<option value="${n}"${n === taken ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </li>`;
  }).join('');
  scModeShown();
  $('sc-err').hidden = true;
  $('sc-remove').hidden = index === null;
  $('sc-dialog').showModal();
}

function scModeShown() {
  const mode = [...document.getElementsByName('sc-mode')].find((r) => r.checked).value;
  $('sc-lines').hidden = mode !== 'exclusive';
  $('sc-diners-box').hidden = mode !== 'shared';
}

function saveClaimant() {
  const d = P.t.discounts;
  const mode = [...document.getElementsByName('sc-mode')].find((r) => r.checked).value;
  const lines = {};
  if (mode === 'exclusive') {
    for (const s of $('sc-lines').querySelectorAll('[data-sc-line]')) {
      if (Number(s.value) > 0) lines[s.dataset.scLine] = Number(s.value);
    }
  }
  const c = {
    type: P.scType, name: $('sc-name').value.trim(), id_no: $('sc-id').value.trim(),
    signature: $('sc-sig').checked, mode, lines,
  };
  const diners = Number($('sc-diners').value);
  const err = !c.name ? 'Enter the full name on the ID.'
    : !c.id_no ? 'Enter the ID number.'
      : mode === 'exclusive' && !Object.keys(lines).length ? 'Choose which items are theirs.'
        : mode === 'shared' && !(diners >= 1) ? 'Enter how many people are sharing.' : '';
  if (err) {
    $('sc-err').textContent = err;
    $('sc-err').hidden = false;
    return;
  }
  if (editingClaimant === null) d.claimants.push(c);
  else d.claimants[editingClaimant] = c;
  if (mode === 'shared') d.diners = diners;
  if (!d.claimants.some((x) => x.mode === 'shared')) d.diners = null;
  $('sc-dialog').close();
  changed({ discounts: true });
}

/* ---------------------------- panels (phones) ---------------------------- */

function showPanel(name) {
  document.body.dataset.panel = name;
  for (const b of document.querySelectorAll('.pos-switch [data-show]')) {
    b.setAttribute('aria-pressed', String(b.dataset.show === name));
  }
}

/* ---------------------------- events ---------------------------- */

function bind() {
  $('cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    P.cat = b.dataset.cat;
    renderCats();
    renderGrid();
  });
  $('search').addEventListener('input', (e) => { P.q = e.target.value; renderGrid(); });
  $('grid').addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (b && !b.disabled) addItem(b.dataset.id);
  });

  $('types').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b || b.dataset.type === P.t.type) return;
    P.t.type = b.dataset.type;
    changed();
  });
  const bindField = (id, key) => $(id).addEventListener('input', (e) => {
    P.t[key] = e.target.value;
    P.t.pendingKey = null;
    persist();
    showFieldErrors(null);
    if (key === 'customer_name') { $('t-name').value = e.target.value; $('d-name').value = e.target.value; }
  });
  bindField('t-table', 'table_no');
  bindField('t-pax', 'pax');
  bindField('t-name', 'customer_name');
  bindField('d-name', 'customer_name');
  bindField('d-phone', 'phone');
  bindField('d-address', 'address');
  bindField('d-landmark', 'landmark');

  $('tlines').addEventListener('click', (e) => {
    const row = e.target.closest('[data-key]');
    if (!row) return;
    const s = e.target.closest('[data-step]');
    if (s) return step(row.dataset.key, Number(s.dataset.step));
    if (e.target.closest('[data-edit]')) openLine(row.dataset.key);
  });

  // Line dialog
  $('note-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    const v = $('line-note').value.trim();
    $('line-note').value = v ? `${v}, ${c.dataset.chip.toLowerCase()}` : c.dataset.chip;
  });
  $('line-form').addEventListener('submit', (e) => { e.preventDefault(); saveLine(); });
  $('line-cancel').addEventListener('click', () => $('line-dialog').close());
  $('line-remove').addEventListener('click', () => {
    editing.qty = 0;
    if (!editing.sent) P.t.lines = P.t.lines.filter((x) => x !== editing);
    $('line-dialog').close();
    changed();
  });

  // Discounts
  $('v-apply').addEventListener('click', () => {
    const d = P.t.discounts;
    if (d.voucher_code) d.voucher_code = '';
    else {
      if (d.manual) return toast('Remove the manual discount first: one or the other.', 'error');
      d.voucher_code = $('v-code').value.trim().toUpperCase();
      if (!d.voucher_code) return;
    }
    changed({ discounts: true });
  });
  $('m-open').addEventListener('click', openManual);
  $('m-kind').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    P.manualKind = b.dataset.kind;
    for (const x of $('m-kind').querySelectorAll('[data-kind]')) x.setAttribute('aria-checked', String(x === b));
  });
  $('m-reason').addEventListener('change', () => { $('m-other-box').hidden = $('m-reason').value !== 'other'; });
  $('manual-form').addEventListener('submit', (e) => { e.preventDefault(); saveManual(); });
  $('m-cancel').addEventListener('click', () => $('manual-dialog').close());
  $('m-remove').addEventListener('click', () => {
    P.t.discounts.manual = null;
    $('manual-dialog').close();
    changed({ discounts: true });
  });

  $('sc-add').addEventListener('click', () => openClaimant(null));
  $('claimants').addEventListener('click', (e) => {
    const b = e.target.closest('[data-claimant]');
    if (b) openClaimant(Number(b.dataset.claimant));
  });
  $('sc-type').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sc]');
    if (!b) return;
    P.scType = b.dataset.sc;
    for (const x of $('sc-type').querySelectorAll('[data-sc]')) x.setAttribute('aria-checked', String(x === b));
    $('sc-id-label').textContent = P.scType === 'sc' ? 'OSCA ID number' : 'PWD ID number';
  });
  for (const r of document.getElementsByName('sc-mode')) r.addEventListener('change', scModeShown);
  $('sc-form').addEventListener('submit', (e) => { e.preventDefault(); saveClaimant(); });
  $('sc-cancel').addEventListener('click', () => $('sc-dialog').close());
  $('sc-remove').addEventListener('click', () => {
    P.t.discounts.claimants.splice(editingClaimant, 1);
    if (!P.t.discounts.claimants.some((x) => x.mode === 'shared')) P.t.discounts.diners = null;
    $('sc-dialog').close();
    changed({ discounts: true });
  });

  $('svc-toggle').addEventListener('click', async () => {
    const d = P.t.discounts;
    if (d.service_removed_reason) d.service_removed_reason = null;
    else {
      const reason = await ask({ title: 'Remove the service charge', label: 'Reason', ok: 'Remove' });
      if (reason === null) return;
      d.service_removed_reason = reason;
    }
    changed({ discounts: true });
  });
  const feeChanged = () => {
    const v = $('fee').value.trim();
    P.t.discounts.delivery_fee = v === '' ? null : Number(v);
    P.t.discounts.fee_reason = $('fee-reason').value.trim();
    changed({ discounts: true });
  };
  $('fee').addEventListener('change', feeChanged);
  $('fee-reason').addEventListener('change', feeChanged);

  // Actions
  $('save-btn').addEventListener('click', () => submit(false));
  $('send-btn').addEventListener('click', () => submit(true));
  $('void-btn').addEventListener('click', voidTicket);
  $('new-btn').addEventListener('click', async () => {
    if (!P.t.id && P.t.lines.length) {
      const ok = await ask({ title: 'Drop this ticket?', lead: 'It has not been saved.', input: false, ok: 'Drop it', danger: true });
      if (ok === null) return;
    }
    startNew();
  });
  $('lock-btn').addEventListener('click', () => staffGate.lock());

  // Open tabs
  $('tabs-btn').addEventListener('click', () => showTabs().catch((e) => toast(e.message, 'error')));
  $('tabs-close').addEventListener('click', () => $('tabs-dialog').close());
  $('tabs').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const id = Number(row.dataset.id);
    try {
      if (e.target.closest('[data-open]')) {
        $('tabs-dialog').close();
        await openOrder(id);
      } else if (e.target.closest('[data-move]')) {
        const table = await ask({ title: 'Move to another table', label: 'New table number', ok: 'Move' });
        if (table === null) return;
        await staffGate.call(`/api/pos/orders/${id}/table`, { method: 'POST', body: { table_no: table } });
        toast(`Moved to table ${table}.`);
        if (P.t.id === id) await openOrder(id, { force: true });
        await showTabs();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('tabs').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-merge-into]');
    if (!sel || !sel.value) return;
    const id = Number(sel.closest('[data-id]').dataset.id);
    try {
      const { order } = await staffGate.call(`/api/pos/orders/${id}/merge`, { method: 'POST', body: { into: Number(sel.value) } });
      toast(`Merged into table ${order.table_no}.`);
      if (P.t.id === id || P.t.id === order.id) await openOrder(order.id, { force: true });
      await showTabs();
    } catch (err) {
      toast(err.message, 'error');
      sel.value = '';
    }
  });

  document.querySelector('.pos-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]');
    if (b) showPanel(b.dataset.show);
  });

  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
  staffGate.onChange((s) => {
    $('who-staff').textContent = s ? `${s.staff.name} · ${staffGate.ROLE[s.staff.role]}` : '';
    if (s) renderTicket();
  });
}

/* ---------------------------- start ---------------------------- */

adminBoot(async () => {
  bind();
  try {
    P.t = JSON.parse(sessionStorage.getItem(TICKET_KEY) || 'null') || blankTicket();
  } catch {
    P.t = blankTicket();
  }
  if (P.t.lines.length && !P.t.id) toast('Your unsaved ticket is still here.');
  showPanel('menu');
  setOnline(navigator.onLine);
  await staffGate.start();
  await loadMenu();
  renderTicket();
  requestQuote();
  refreshTabs();
  // Keep the stock and the open tabs current.
  setInterval(() => {
    if (!P.online || document.hidden) return;
    loadMenu().catch(() => {});
    refreshTabs();
  }, 60 * 1000);
});
