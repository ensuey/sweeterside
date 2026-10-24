'use strict';
/* POS: payments, the shift and cash drawer, paid orders (reprint, refund)
   and printing. Loaded after pos.js, whose functions it uses.

   Printing uses the browser's print dialog on a slip laid out for 58 mm or
   80 mm thermal paper (the owner picks the width on the Staff page). Only the
   slip prints; the POS screen is hidden from the printout. */

const PAY = {
  methods: [], shift: null, receipt: null, // receipt settings
  order: null, balance: null, method: 'cash', key: null, lastReceipt: null,
  refundOrder: null, report: null, cashKind: 'out',
};

const centsOf = (raw) => Math.round(Number(raw) * 100);

/** '2026-10-24 03:38:07' (UTC, as SQLite writes it) -> Manila date and time. */
function manilaTime(sql) {
  const d = new Date(`${String(sql).replace(' ', 'T')}Z`);
  return d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
}

/* ---------------------------- shift ---------------------------- */

async function loadShift() {
  const data = await staffGate.call('/api/pos/shift');
  PAY.methods = data.methods;
  PAY.shift = data.shift;
  const b = $('shift-btn');
  b.dataset.open = PAY.shift ? '1' : '0';
  b.textContent = PAY.shift ? `Shift · ${moneyC(PAY.shift.cash.expected_cents)} in drawer` : 'No shift open';
  b.hidden = !staffGate.can('manage_shift') && !staffGate.can('cash_movement');
  return PAY.shift;
}

function readingHtml(r, { forPrint = false } = {}) {
  const amount = (c) => (c < 0 ? `−${moneyC(-c)}` : moneyC(Math.abs(c)));
  const row = (label, cents, cls = '') => `<div class="${cls}"><dt>${esc(label)}</dt><dd>${cents === null ? '—' : amount(cents)}</dd></div>`;
  const d = r.sales.discounts;
  const methods = (o) => Object.entries(o).map(([m, v]) => row(`${(PAY.methods.find((x) => x.id === m) || { label: m }).label} (${v.count})`, v.amount_cents)).join('')
    || '<div><dt>None</dt><dd></dd></div>';
  return `
    ${forPrint ? `<p class="slip__title">${r.kind}-READING</p>` : `<p class="reading__kind">${r.kind === 'Z' ? 'Z reading (closed)' : 'X reading (so far)'}</p>`}
    <p class="slip__meta">Shift #${r.shift.id} · opened ${esc(manilaTime(r.shift.opened_at))} by ${esc(r.shift.opened_by)}
      ${r.shift.closed_at ? `<br>closed ${esc(manilaTime(r.shift.closed_at))} by ${esc(r.shift.closed_by)}` : ''}</p>
    <h4>Sales</h4>
    <dl class="rd">
      ${row(`Orders paid`, null).replace('—', String(r.sales.orders))}
      ${row('Gross sales', r.sales.gross_cents)}
      ${d.sale ? row('Sale prices', -d.sale) : ''}
      ${d.sc_pwd ? row('SC/PWD 20%', -d.sc_pwd) : ''}
      ${d.vat_exempt ? row('VAT exempt', -d.vat_exempt) : ''}
      ${d.voucher ? row('Vouchers', -d.voucher) : ''}
      ${d.manual ? row('Manual discounts', -d.manual) : ''}
      ${row('Net sales', r.sales.net_sales_cents, 'is-strong')}
      ${row('Service charge (staff)', r.sales.service_charge_cents)}
      ${row('Delivery fees', r.sales.delivery_fees_cents)}
      ${row('Total collected on sales', r.sales.total_cents, 'is-strong')}
      ${row(`Voids (${r.voids.count})`, r.voids.amount_cents)}
      ${row('Refunds', -r.refunds.total_cents)}
    </dl>
    <h4>Payments</h4>
    <dl class="rd">${methods(r.payments.by_method)}</dl>
    ${r.refunds.total_cents ? `<h4>Refunds</h4><dl class="rd">${methods(r.refunds.by_method)}</dl>` : ''}
    <h4>Cash drawer</h4>
    <dl class="rd">
      ${row('Starting cash', r.cash.opening_cents)}
      ${row('Cash sales', r.cash.sales_cents)}
      ${r.cash.refunds_cents ? row('Cash refunds', -r.cash.refunds_cents) : ''}
      ${row('Cash in', r.cash.in_cents)}
      ${row('Cash out', -r.cash.out_cents)}
      ${row('Expected in the drawer', r.cash.expected_cents, 'is-strong')}
      ${r.cash.counted_cents !== null ? row('Counted', r.cash.counted_cents) : ''}
      ${r.cash.difference_cents !== null ? row(r.cash.difference_cents < 0 ? 'Short' : r.cash.difference_cents > 0 ? 'Over' : 'Difference', r.cash.difference_cents, 'is-strong') : ''}
    </dl>
    ${r.movements.length ? `<ul class="rd-moves">${r.movements.map((m) => `<li>${m.kind === 'in' ? 'In' : 'Out'} ${moneyC(m.amount_cents)} · ${esc(m.reason)} · ${esc(m.staff)}</li>`).join('')}</ul>` : ''}
    ${r.note ? `<p class="slip__meta">Note: ${esc(r.note)}</p>` : ''}`;
}

async function showShift() {
  const shift = await loadShift();
  $('shift-err').hidden = true;
  $('shift-open-form').hidden = !!shift;
  $('shift-open-view').hidden = !shift;
  $('shift-print').hidden = !shift;
  $('cash-form').hidden = !staffGate.can('cash_movement');
  $('close-form').hidden = !staffGate.can('manage_shift');
  if (shift) {
    PAY.report = shift;
    $('reading').innerHTML = readingHtml(shift);
  }
  if (!$('shift-dialog').open) $('shift-dialog').showModal();
}

function shiftError(e) {
  $('shift-err').textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
  $('shift-err').hidden = false;
}

/* ---------------------------- paying ---------------------------- */

/** Open the payment screen for a saved order. */
async function openPay(orderId) {
  const [{ order, balance }] = await Promise.all([staffGate.call(`/api/pos/orders/${orderId}`), loadShift()]);
  PAY.order = order;
  PAY.balance = balance;
  PAY.key = newKey();
  PAY.method = PAY.shift ? 'cash' : (PAY.methods.find((m) => !m.drawer) || {}).id;
  $('pay-entry').hidden = false;
  $('pay-done').hidden = true;
  $('pay-submit').hidden = false;
  $('pay-next').hidden = true;
  $('pay-print').hidden = true;
  $('pay-send-box').hidden = !order.held && !order.lines.some((l) => l.qty > l.sent_qty - l.voided_qty);
  renderPay();
  $('pay-dialog').showModal();
  $('pay-tendered').focus();
}

function renderPay() {
  const b = PAY.balance;
  const o = PAY.order;
  $('pay-title').textContent = o.order_type === 'dinein' ? `Pay · Table ${o.table_no} (#${o.id})` : `Pay · #${o.id}`;
  $('paysum').innerHTML = `
    <div><dt>Total</dt><dd>${moneyC(b.total_cents)}</dd></div>
    ${b.paid_cents ? `<div><dt>Paid so far</dt><dd>${moneyC(b.paid_cents)}</dd></div>` : ''}
    <div class="is-total"><dt>Due</dt><dd>${moneyC(b.due_cents)}</dd></div>`;
  $('methods').innerHTML = PAY.methods.map((m) => `
    <button type="button" role="radio" class="method" data-method="${m.id}" aria-checked="${String(m.id === PAY.method)}"
      ${m.drawer && !PAY.shift ? 'disabled title="Open a shift to take cash"' : ''}>${esc(m.label)}</button>`).join('');
  const m = PAY.methods.find((x) => x.id === PAY.method) || {};
  $('tender-box').hidden = !m.drawer;
  $('quick').hidden = !m.drawer;
  $('ref-box').hidden = !m.reference;
  $('pay-amount').value = (b.due_cents / 100).toFixed(2);
  $('pay-tendered').value = '';
  $('pay-ref').value = '';
  $('pay-err').hidden = true;
  showChange();
}

function showChange() {
  const m = PAY.methods.find((x) => x.id === PAY.method) || {};
  const amount = centsOf($('pay-amount').value);
  const tendered = centsOf($('pay-tendered').value);
  $('change').textContent = m.drawer && tendered
    ? (tendered >= amount ? `Change: ${moneyC(tendered - amount)}` : `Short by ${moneyC(amount - tendered)}`)
    : '';
}

async function takePayment() {
  const m = PAY.methods.find((x) => x.id === PAY.method);
  if (!m) return;
  const part = { method: m.id, amount: $('pay-amount').value };
  if (m.drawer) part.tendered = $('pay-tendered').value || $('pay-amount').value;
  if (m.reference) part.reference = $('pay-ref').value;
  const body = { request_key: PAY.key, payments: [part], send: !$('pay-send-box').hidden && $('pay-send').checked };
  $('pay-submit').disabled = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await staffGate.call(`/api/pos/orders/${PAY.order.id}/pay`, { method: 'POST', body });
        return paid(res);
      } catch (e) {
        const data = e.data || {};
        if (e.status === 403 && data.override_required) {
          const ov = await staffGate.askOverride(data.needs);
          if (!ov) return;
          body.override = { staff_id: ov.staff_id, pin: ov.pin };
          continue;
        }
        if (e.status === 403 && data.wrong_pin) { toast(e.message, 'error'); delete body.override; continue; }
        if (data.code === 'no_shift') {
          $('pay-dialog').close();
          toast('Open a shift first to take cash.', 'error');
          return showShift();
        }
        $('pay-err').textContent = e.offline ? 'No connection. The payment was not recorded; try again.'
          : e.fields ? Object.values(e.fields).join(' ') : e.message;
        $('pay-err').hidden = false;
        // Only a dropped connection keeps the key: the payment may have gone through.
        if (!e.offline) PAY.key = newKey();
        return;
      }
    }
  } finally {
    $('pay-submit').disabled = false;
  }
}

function paid(res) {
  PAY.order = res.order;
  PAY.balance = res.balance;
  PAY.key = newKey();
  loadShift().catch(() => {});
  if (res.kitchen.length) toast(`Sent to the kitchen: ${res.kitchen.map((k) => `${k.qty} × ${k.name}`).join(', ')}`);
  if (!res.balance.paid) {
    toast(`Payment recorded. ${moneyC(res.balance.due_cents)} still due.`);
    PAY.method = PAY.methods.find((m) => m.id !== PAY.method && (!m.drawer || PAY.shift))?.id || PAY.method;
    return renderPay();
  }
  $('pay-entry').hidden = true;
  $('pay-done').hidden = false;
  $('pay-done-change').textContent = res.change_cents ? `Change: ${moneyC(res.change_cents)}` : 'No change.';
  $('paysum').innerHTML = `<div class="is-total"><dt>Paid</dt><dd>${moneyC(res.balance.total_cents)}</dd></div>`;
  $('paid-list').innerHTML = res.payments.map((p) => `<li>${esc(p.label)}${p.reference ? ` · ${esc(p.reference)}` : ''} <span>${moneyC(p.amount_cents)}</span></li>`).join('');
  $('pay-submit').hidden = true;
  $('pay-next').hidden = false;
  $('pay-print').hidden = false;
  $('pay-next').focus();
  PAY.lastReceipt = res.order.id;
  refreshTabs();
}

/* ---------------------------- paid orders, refunds ---------------------------- */

async function showReceipts() {
  const { orders } = await staffGate.call('/api/pos/recent');
  $('receipts-empty').hidden = orders.length > 0;
  $('receipts').innerHTML = orders.map((o) => `
    <li class="tab" data-id="${o.id}">
      <div class="tab__main">
        <span class="tab__title">${esc(o.order_type === 'dinein' ? `Table ${o.table_no}` : `${TYPE_LABEL[o.order_type]}${o.customer_name ? ` · ${o.customer_name}` : ''}`)} <span class="tab__id">#${o.id}</span></span>
        <span class="tab__meta">${esc(manilaTime(o.paid_at))} · ${esc((o.methods || '').split(',').map((m) => (PAY.methods.find((x) => x.id === m) || { label: m }).label).join(' + '))}
          ${o.refunded_cents ? ` · refunded ${moneyC(o.refunded_cents)}` : ''}</span>
      </div>
      <span class="tab__total">${moneyC(o.total_cents)}</span>
      <div class="tab__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-receipt>Receipt</button>
        <button class="btn btn--ghost btn--sm" type="button" data-kitchen>Kitchen ticket</button>
        ${o.refunded_cents < o.total_cents ? '<button class="btn btn--danger-ghost btn--sm" type="button" data-refund>Refund…</button>' : ''}
      </div>
    </li>`).join('');
  if (!$('receipts-dialog').open) $('receipts-dialog').showModal();
}

async function openRefund(orderId) {
  const [{ order, balance }] = await Promise.all([staffGate.call(`/api/pos/orders/${orderId}`), loadShift()]);
  PAY.refundOrder = order;
  PAY.key = newKey();
  $('refund-title').textContent = `Refund #${order.id}`;
  $('refund-lead').textContent = `Paid ${moneyC(balance.paid_cents)}${balance.refunded_cents ? `, refunded ${moneyC(balance.refunded_cents)} already` : ''}.`;
  $('refund-lines').innerHTML = order.lines.filter((l) => l.qty > 0).map((l) => `
    <li class="sc-line"><span>${esc(l.name)} <small>(${moneyC(l.net_cents)} for ${l.qty})</small></span>
      <label class="vh" for="rf-${l.id}">How many ${esc(l.name)} to refund</label>
      <select id="rf-${l.id}" data-refund-line="${l.id}">
        ${Array.from({ length: l.qty + 1 }, (_, n) => `<option value="${n}">${n}</option>`).join('')}
      </select></li>`).join('');
  $('refund-method').innerHTML = PAY.methods.map((m) => `<option value="${m.id}"${m.drawer && !PAY.shift ? ' disabled' : ''}>${esc(m.label)}</option>`).join('');
  $('refund-method').value = PAY.shift ? 'cash' : (PAY.methods.find((m) => !m.drawer) || {}).id;
  $('refund-ref').value = '';
  $('refund-reason').value = '';
  $('refund-err').hidden = true;
  for (const r of document.getElementsByName('refund-kind')) r.checked = r.value === 'full';
  $('refund-lines').hidden = true;
  $('refund-dialog').showModal();
}

async function submitRefund() {
  const kind = [...document.getElementsByName('refund-kind')].find((r) => r.checked).value;
  const body = {
    request_key: PAY.key, method: $('refund-method').value, reference: $('refund-ref').value, reason: $('refund-reason').value.trim(),
  };
  if (kind === 'lines') {
    body.lines = [...$('refund-lines').querySelectorAll('[data-refund-line]')]
      .filter((s) => Number(s.value) > 0).map((s) => ({ line_id: Number(s.dataset.refundLine), qty: Number(s.value) }));
    if (!body.lines.length) return refundError('Choose what to refund.');
  }
  if (!body.reason) return refundError('Give a reason for the refund.');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await staffGate.call(`/api/pos/orders/${PAY.refundOrder.id}/refund`, { method: 'POST', body });
      $('refund-dialog').close();
      toast(`Refunded ${moneyC(res.refunds[res.refunds.length - 1].amount_cents)} on #${res.order.id}.`);
      loadShift().catch(() => {});
      return showReceipts();
    } catch (e) {
      const data = e.data || {};
      if (e.status === 403 && data.override_required) {
        const ov = await staffGate.askOverride(data.needs);
        if (!ov) return;
        body.override = { staff_id: ov.staff_id, pin: ov.pin };
        continue;
      }
      if (e.status === 403 && data.wrong_pin) { toast(e.message, 'error'); delete body.override; continue; }
      if (!e.offline) PAY.key = newKey();
      return refundError(e.fields ? Object.values(e.fields).join(' ') : e.message);
    }
  }
}

function refundError(msg) {
  $('refund-err').textContent = msg;
  $('refund-err').hidden = false;
}

/* ---------------------------- printing ---------------------------- */

async function receiptSettings() {
  if (!PAY.receipt) PAY.receipt = await staffGate.call('/api/pos/receipt-settings');
  return PAY.receipt;
}

function printSlip(html, width) {
  const area = $('print-area');
  area.innerHTML = html;
  area.className = `print-area slip slip--${width}`;
  let page = document.getElementById('page-size');
  if (!page) {
    page = document.createElement('style');
    page.id = 'page-size';
    document.head.appendChild(page);
  }
  page.textContent = `@page { size: ${width}mm auto; margin: 2mm; }`;
  window.print();
}

const TYPE_LINE = (o) => (o.order_type === 'dinein'
  ? `Dine-in · Table ${o.table_no}${o.pax ? ` · ${o.pax} pax` : ''}`
  : o.order_type === 'pickup' ? `Takeout${o.customer_name ? ` · ${o.customer_name}` : ''}` : `Delivery · ${o.customer_name}`);

/** The customer's receipt (an order slip until BIR mode is on). */
function receiptHtml(r) {
  const s = r.settings;
  const o = r.order;
  const p = o.pricing;
  const row = (label, cents, cls = '') => `<div class="${cls}"><span>${label}</span><span>${cents < 0 ? '-' : ''}${moneyC(Math.abs(cents))}</span></div>`;
  const head = s.bir_mode
    ? [s.bir_business_name || s.receipt_shop_name, s.bir_address || s.receipt_address,
      s.bir_tin ? `Non-VAT Reg. TIN: ${s.bir_tin}` : '', s.bir_ptu ? `PTU No.: ${s.bir_ptu}` : '', s.receipt_contact]
    : [s.receipt_address, s.receipt_contact];
  const lines = p.lines.map((l) => `
    <div class="slip__line"><span>${l.qty} × ${esc(l.name)}</span><span>${moneyC(l.gross)}</span></div>
    ${l.sale_discount ? `<div class="slip__sub"><span>sale price</span><span>-${moneyC(l.sale_discount)}</span></div>` : ''}
    ${l.price_override ? `<div class="slip__sub"><span>price changed: ${esc(l.price_override.reason)}</span><span></span></div>` : ''}`).join('');
  const claimants = p.claimants.map((c) => `
    <div class="slip__claim">
      <div>${c.type === 'sc' ? 'Senior Citizen' : 'PWD'}: ${esc(c.name)}</div>
      <div>${c.type === 'sc' ? 'OSCA' : 'PWD'} ID: ${esc(c.id_no)}${c.signature ? ' · signed' : ''}</div>
      ${c.applied === 'sc_pwd'
    ? `${c.vat_exempt ? row('VAT exemption', -c.vat_exempt) : ''}${row(`${c.type === 'sc' ? 'SC' : 'PWD'} discount 20%`, -c.discount)}`
    : '<div>Sale / voucher price applied (lower than SC/PWD)</div>'}
    </div>`).join('');
  const pays = r.payments.map((x) => `
    ${row(`${esc(x.label)}${x.reference ? ` ${esc(x.reference)}` : ''}`, x.amount_cents)}
    ${x.tendered_cents !== null && x.tendered_cents !== x.amount_cents ? row('Cash tendered', x.tendered_cents) : ''}
    ${x.change_cents ? row('Change', x.change_cents, 'is-strong') : ''}`).join('');
  return `
    <p class="slip__title">${esc(s.bir_mode ? (s.bir_business_name || s.receipt_shop_name) : s.receipt_shop_name)}</p>
    ${head.filter(Boolean).map((x) => `<p class="slip__center">${esc(x)}</p>`).join('')}
    ${!s.bir_mode ? `<p class="slip__notice">${esc(s.order_slip)}</p>` : ''}
    <p class="slip__meta">Order #${o.id} · ${esc(manilaTime(o.paid_at || o.created_at))}<br>
      ${esc(TYPE_LINE(o))}<br>Cashier: ${esc(r.cashier)}</p>
    <div class="slip__rule"></div>
    ${lines}
    <div class="slip__rule"></div>
    ${row('Subtotal', p.totals.gross)}
    ${p.totals.sale_discount ? row('Sale prices', -p.totals.sale_discount) : ''}
    ${claimants}
    ${p.voucher ? row(`Voucher ${esc(p.voucher.code)}`, -p.voucher.discount) : ''}
    ${p.manual ? row(`Discount (${esc(p.manual.reason)})`, -p.manual.discount) : ''}
    ${p.service.amount ? row(`Service charge ${p.service.rate_bp / 100}%`, p.service.amount) : ''}
    ${p.totals.delivery_fee ? row('Delivery fee', p.totals.delivery_fee) : ''}
    ${row('TOTAL', p.totals.total, 'is-total')}
    <div class="slip__rule"></div>
    ${pays}
    ${r.refunds.length ? r.refunds.map((x) => row(`Refunded (${esc(x.label)})`, -x.amount_cents)).join('') : ''}
    <div class="slip__rule"></div>
    ${s.receipt_footer ? `<p class="slip__center">${esc(s.receipt_footer)}</p>` : ''}
    ${s.bir_mode && s.bir_tin && s.bir_notice ? `<p class="slip__notice">${esc(s.bir_notice)}</p>` : ''}
    ${!s.bir_mode ? `<p class="slip__notice">${esc(s.order_slip)}</p>` : ''}`;
}

async function printReceipt(orderId) {
  const [r, s] = await Promise.all([staffGate.call(`/api/pos/orders/${orderId}/receipt`), receiptSettings()]);
  printSlip(receiptHtml(r), s.receipt_width);
}

/** The kitchen's ticket: items and notes, no prices. `items` are only the new ones when given. */
async function printKitchen(orderId, items = null) {
  const [{ order }, s] = await Promise.all([staffGate.call(`/api/pos/orders/${orderId}`), receiptSettings()]);
  const list = items || order.lines.filter((l) => l.qty > 0).map((l) => ({ name: l.name, qty: l.qty, note: l.note }));
  printSlip(`
    <p class="slip__title">KITCHEN</p>
    <p class="slip__big">${esc(order.order_type === 'dinein' ? `TABLE ${order.table_no}` : TYPE_LINE(order).toUpperCase())}</p>
    <p class="slip__meta">Order #${order.id} · ${esc(manilaTime(new Date().toISOString().slice(0, 19).replace('T', ' ')))}<br>
      ${items ? 'ADDED ITEMS · ' : ''}${esc(staffGate.staff.name)}</p>
    <div class="slip__rule"></div>
    ${list.map((k) => `<p class="slip__kline"><strong>${k.qty} ×</strong> ${esc(k.name)}${k.note ? `<br><em>${esc(k.note)}</em>` : ''}</p>`).join('')}`,
  s.receipt_width);
}

async function printReading() {
  const s = await receiptSettings();
  printSlip(`<p class="slip__center">${esc(s.receipt_shop_name)}</p>${readingHtml(PAY.report, { forPrint: true })}`, s.receipt_width);
}

/* ---------------------------- events ---------------------------- */

function bindPay() {
  $('pay-btn').addEventListener('click', async () => {
    try {
      const id = await saveForPayment();
      if (id) await openPay(id);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  $('methods').addEventListener('click', (e) => {
    const b = e.target.closest('[data-method]');
    if (!b || b.disabled) return;
    PAY.method = b.dataset.method;
    const due = $('pay-amount').value;
    renderPay();
    $('pay-amount').value = due;
    showChange();
  });
  $('quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cash]');
    if (!b) return;
    $('pay-tendered').value = b.dataset.cash === 'exact' ? $('pay-amount').value : b.dataset.cash;
    showChange();
  });
  $('pay-amount').addEventListener('input', showChange);
  $('pay-tendered').addEventListener('input', showChange);
  $('pay-form').addEventListener('submit', (e) => { e.preventDefault(); takePayment(); });
  $('pay-close').addEventListener('click', () => $('pay-dialog').close());
  // A paid order is done: closing the dialog any way starts the next ticket.
  $('pay-dialog').addEventListener('close', () => {
    if (PAY.balance && PAY.balance.paid && P.t.id === PAY.order.id) startNew();
  });
  $('pay-print').addEventListener('click', () => printReceipt(PAY.lastReceipt).catch((e) => toast(e.message, 'error')));
  $('pay-next').addEventListener('click', () => { $('pay-dialog').close(); startNew(); });

  $('shift-btn').addEventListener('click', () => showShift().catch((e) => toast(e.message, 'error')));
  $('shift-close-x').addEventListener('click', () => $('shift-dialog').close());
  $('shift-print').addEventListener('click', () => printReading().catch((e) => toast(e.message, 'error')));
  $('shift-open-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await staffGate.call('/api/pos/shift/open', { method: 'POST', body: { opening_cash: $('shift-opening').value } });
      toast('Shift opened.');
      await showShift();
    } catch (err) { shiftError(err); }
  });
  $('cash-kind').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    PAY.cashKind = b.dataset.kind;
    for (const x of $('cash-kind').querySelectorAll('[data-kind]')) x.setAttribute('aria-checked', String(x === b));
  });
  $('cash-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await staffGate.call('/api/pos/shift/cash', {
        method: 'POST', body: { kind: PAY.cashKind, amount: $('cash-amount').value, reason: $('cash-reason').value },
      });
      $('cash-form').reset();
      toast(PAY.cashKind === 'out' ? 'Cash out recorded.' : 'Cash in recorded.');
      await showShift();
    } catch (err) { shiftError(err); }
  });
  $('close-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { report } = await staffGate.call('/api/pos/shift/close', {
        method: 'POST', body: { counted_cash: $('close-counted').value, note: $('close-note').value },
      });
      $('close-form').reset();
      PAY.report = report;
      await loadShift();
      $('shift-open-form').hidden = false;
      $('shift-open-view').hidden = false;
      $('cash-form').hidden = true;
      $('close-form').hidden = true;
      $('reading').innerHTML = readingHtml(report);
      $('shift-print').hidden = false;
      toast('Shift closed. Print the Z reading for the day.');
    } catch (err) { shiftError(err); }
  });

  $('receipts-btn').addEventListener('click', () => showReceipts().catch((e) => toast(e.message, 'error')));
  $('receipts-close').addEventListener('click', () => $('receipts-dialog').close());
  $('receipts').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const id = Number(row.dataset.id);
    const fail = (err) => toast(err.message, 'error');
    if (e.target.closest('[data-receipt]')) printReceipt(id).catch(fail);
    if (e.target.closest('[data-kitchen]')) printKitchen(id).catch(fail);
    if (e.target.closest('[data-refund]')) openRefund(id).catch(fail);
  });
  for (const r of document.getElementsByName('refund-kind')) {
    r.addEventListener('change', () => { $('refund-lines').hidden = r.value !== 'lines' || !r.checked; });
  }
  $('refund-form').addEventListener('submit', (e) => { e.preventDefault(); submitRefund(); });
  $('refund-cancel').addEventListener('click', () => $('refund-dialog').close());

  $('after-kitchen').addEventListener('click', () => {
    if (P.last) printKitchen(P.last.id, P.last.kitchen.length ? P.last.kitchen : null).catch((e) => toast(e.message, 'error'));
  });
}

bindPay();
