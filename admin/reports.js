'use strict';
/* Reports page (owner only): sales by day, item, category, order type,
   source and staff; payments by method; discounts; the SC/PWD report;
   vouchers and manual discounts; the audit log; and the year's gross sales
   against the Php 3M limit. Loaded after common.js and staff-gate.js. */

const R = { view: 'sales', from: '', to: '', audit: null };

const TYPE = { dinein: 'Dine-in', pickup: 'Pick-up / takeout', delivery: 'Delivery' };
const SOURCE = { pos: 'Counter (POS)', online: 'Online' };
const METHOD = { cash: 'Cash', gcash: 'GCash', maya: 'Maya', qrph: 'QR Ph', card: 'Card' };
const ACTION = {
  void: 'Void', refund: 'Refund', override: 'Owner override', price_change: 'Price change',
  manual_discount: 'Manual discount', service_charge_removed: 'Service charge removed',
  delivery_fee_changed: 'Delivery fee changed', cash_in: 'Cash in', cash_out: 'Cash out',
  shift_open: 'Shift opened', shift_close: 'Shift closed', staff_add: 'Staff added',
  staff_change: 'Staff changed', staff_pin_change: 'PIN changed', settings_change: 'Settings changed',
};

/* ---------------------------- dates (Manila) ---------------------------- */

function manilaToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function plusDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function preset(name) {
  const t = manilaToday();
  const first = `${t.slice(0, 8)}01`;
  if (name === 'yesterday') return [plusDays(t, -1), plusDays(t, -1)];
  if (name === 'week') return [plusDays(t, -6), t];
  if (name === 'month') return [first, t];
  if (name === 'last-month') {
    const lastEnd = plusDays(first, -1);
    return [`${lastEnd.slice(0, 8)}01`, lastEnd];
  }
  return [t, t];
}
function manilaTime(sql) {
  const d = new Date(`${String(sql).replace(' ', 'T')}Z`);
  return d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
}
const niceDay = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

/* ---------------------------- tables ---------------------------- */

const signed = (c) => (c < 0 ? `−${moneyC(-c)}` : moneyC(c));

/**
 * A small table. cols: [{ label, get(row), num? }]. Money columns are
 * centavos and formatted; num right-aligns.
 */
function table(title, cols, rows, { empty = 'Nothing in these dates.', foot = null } = {}) {
  return `<section class="rtable">
    <h3 class="rtable__title">${esc(title)}</h3>
    ${rows.length ? `<div class="rtable__scroll"><table>
      <thead><tr>${cols.map((c) => `<th scope="col"${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.get(r)}</td>`).join('')}</tr>`).join('')}</tbody>
      ${foot ? `<tfoot><tr>${foot.map((f, i) => `<td${cols[i] && cols[i].num ? ' class="num"' : ''}>${f}</td>`).join('')}</tr></tfoot>` : ''}
    </table></div>` : `<p class="hint">${esc(empty)}</p>`}
  </section>`;
}

const salesCols = (label, get) => [
  { label, get },
  { label: 'Orders', get: (r) => r.orders, num: true },
  { label: 'Gross', get: (r) => moneyC(r.gross), num: true },
  { label: 'Discounts', get: (r) => signed(-(r.sale + r.sc_pwd + r.vat_exempt + r.voucher + r.manual)), num: true },
  { label: 'Net sales', get: (r) => moneyC(r.net_sales), num: true },
  { label: 'Service charge', get: (r) => moneyC(r.service_charge), num: true },
  { label: 'Total', get: (r) => moneyC(r.total), num: true },
];

/* ---------------------------- loading ---------------------------- */

async function loadLimit() {
  const t = await staffGate.call('/api/reports/threshold');
  const pct = Math.min(100, t.percent);
  $('limit').dataset.level = t.level;
  $('limit-title').textContent = `Gross sales ${t.year}, so far`;
  $('limit-pct').textContent = `${t.percent}%`;
  $('limit-fill').style.width = `${pct}%`;
  $('limit-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('limit-text').textContent = `${moneyC(t.total_cents)} of ${moneyC(t.threshold_cents)}`
    + ` (items at regular price ${moneyC(t.gross_cents)} + delivery fees ${moneyC(t.delivery_fees_cents)}`
    + ` − refunds ${moneyC(t.refunds_cents)}; service charge not included).`
    + (t.level === 'danger' ? ' Over 95%: call your accountant now.' : t.level === 'warn' ? ' Over 80%: plan with your accountant.' : '');
}

async function loadSales() {
  const s = await staffGate.call(`/api/reports/summary?from=${R.from}&to=${R.to}`);
  const t = s.totals;
  const card = (label, value, cls = '') => `<div class="card-stat ${cls}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
  $('cards').innerHTML = [
    card('Orders', String(t.orders)),
    card('Gross sales', moneyC(t.gross)),
    card('Discounts', signed(-(t.sale + t.sc_pwd + t.vat_exempt + t.voucher + t.manual))),
    card('Net sales', moneyC(t.net_sales), 'is-main'),
    card('Service charge (staff)', moneyC(t.service_charge)),
    card('Delivery fees', moneyC(t.delivery_fees)),
    card('Refunds', signed(-s.refunds.amount)),
  ].join('');

  const discountRows = [
    ['Sale prices', t.sale], ['SC/PWD 20%', t.sc_pwd], ['VAT exempt (SC/PWD)', t.vat_exempt],
    ['Vouchers', t.voucher], ['Manual discounts', t.manual],
  ].filter(([, v]) => v);
  $('sales-tables').innerHTML = [
    table('By day', salesCols('Day', (r) => esc(niceDay(r.day))).concat([{ label: 'Refunds', get: (r) => signed(-r.refunds), num: true }]), s.by_day),
    table('By item', [
      { label: 'Item', get: (r) => esc(r.name) },
      { label: 'Sold', get: (r) => r.qty, num: true },
      { label: 'Gross', get: (r) => moneyC(r.gross), num: true },
      { label: 'Net', get: (r) => moneyC(r.net), num: true },
    ], s.by_item),
    table('By category', [
      { label: 'Category', get: (r) => esc(r.category) },
      { label: 'Sold', get: (r) => r.qty, num: true },
      { label: 'Gross', get: (r) => moneyC(r.gross), num: true },
      { label: 'Net', get: (r) => moneyC(r.net), num: true },
    ], s.by_category),
    table('By order type', salesCols('Type', (r) => esc(TYPE[r.order_type] || r.order_type)), s.by_type),
    table('Online vs counter', salesCols('Source', (r) => esc(SOURCE[r.source] || r.source)), s.by_source),
    table('By staff', salesCols('Taken by', (r) => esc(r.staff)), s.by_staff),
    table('Payments by method (counter)', [
      { label: 'Method', get: (r) => esc(METHOD[r.method] || r.method) },
      { label: 'Payments', get: (r) => r.count, num: true },
      { label: 'Amount', get: (r) => moneyC(r.amount), num: true },
    ], s.payments, { empty: 'No counter payments in these dates.' })
      + (s.online_unrecorded ? `<p class="hint">Online orders (${moneyC(s.online_unrecorded)}) are paid on delivery or at the counter, outside the POS.</p>` : ''),
    table('Discounts', [
      { label: 'Kind', get: (r) => esc(r[0]) },
      { label: 'Amount', get: (r) => moneyC(r[1]), num: true },
    ], discountRows, { empty: 'No discounts in these dates.' }),
  ].join('');
}

async function loadScPwd() {
  const r = await staffGate.call(`/api/reports/sc-pwd?from=${R.from}&to=${R.to}`);
  const sum = (k) => r.rows.reduce((s, x) => s + x[k], 0);
  const cols = [
    { label: 'Date', get: (x) => esc(manilaTime(x.date)) },
    { label: 'Order', get: (x) => `#${x.order_id}` },
    { label: 'Name', get: (x) => esc(x.name) },
    { label: 'ID number', get: (x) => esc(x.id_no) },
    { label: 'Type', get: (x) => esc(x.type) },
    { label: 'Gross eligible', get: (x) => moneyC(x.gross), num: true },
    ...(r.vat_registered ? [{ label: 'VAT exemption', get: (x) => moneyC(x.vat_exempt), num: true }] : []),
    { label: '20% discount', get: (x) => moneyC(x.discount), num: true },
    { label: 'Net', get: (x) => moneyC(x.net), num: true },
  ];
  const foot = ['Total', '', '', '', '', moneyC(sum('gross')), ...(r.vat_registered ? [moneyC(sum('vat_exempt'))] : []),
    moneyC(sum('discount')), moneyC(sum('net'))];
  $('scpwd-table').innerHTML = table(`${r.rows.length} SC/PWD discount${r.rows.length === 1 ? '' : 's'}`, cols, r.rows,
    { empty: 'No SC/PWD discounts in these dates.', foot: r.rows.length ? foot : null });
}

async function loadDiscounts() {
  const d = await staffGate.call(`/api/reports/discounts?from=${R.from}&to=${R.to}`);
  $('discount-tables').innerHTML = [
    table('Vouchers used', [
      { label: 'Code', get: (x) => esc(x.code) },
      { label: 'Orders', get: (x) => x.uses, num: true },
      { label: 'Taken off', get: (x) => moneyC(x.discount), num: true },
    ], d.vouchers, { empty: 'No vouchers used in these dates.' }),
    table('Manual discounts by staff', [
      { label: 'Staff', get: (x) => esc(x.staff) },
      { label: 'Given', get: (x) => x.count, num: true },
      { label: 'Amount', get: (x) => moneyC(x.amount), num: true },
    ], d.manual_by_staff, { empty: 'No manual discounts in these dates.' }),
    table('Manual discounts', [
      { label: 'When', get: (x) => esc(manilaTime(x.at)) },
      { label: 'Order', get: (x) => (x.order_id ? `#${x.order_id}` : '') },
      { label: 'Staff', get: (x) => esc(x.staff_name) },
      { label: 'Approved by', get: (x) => esc(x.approver_name || '—') },
      { label: 'Reason', get: (x) => esc(x.reason) },
      { label: 'Amount', get: (x) => moneyC(x.amount_cents || 0), num: true },
    ], d.manual, { empty: 'No manual discounts in these dates.' }),
  ].join('');
}

function auditQuery() {
  return `from=${R.from}&to=${R.to}&action=${encodeURIComponent($('audit-action').value)}&staff_id=${encodeURIComponent($('audit-staff').value)}`;
}

/** One line saying what an audit entry was about. */
function auditDetail(e) {
  const d = e.details || {};
  if (e.action === 'void') return d.whole_order ? 'Whole order' : `${d.units} × ${d.line}`;
  if (e.action === 'override') return (d.permissions || []).map((p) => staffGate.NEEDS[p] || p).join(', ');
  if (e.action === 'price_change') return `${d.line}: ${d.to_cents === null ? 'back to menu price' : moneyC(d.to_cents)}`;
  if (e.action === 'refund') return `${METHOD[d.method] || d.method}${d.lines ? `, ${d.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}` : ', full'}`;
  if (e.action.startsWith('staff_')) return d.name || (d.after ? `${d.after.name} (${d.after.role}${d.after.active ? '' : ', off'})` : '');
  if (e.action === 'shift_close') return `Expected ${moneyC(d.expected_cents)}, ${d.difference_cents ? `${signed(d.difference_cents)} off` : 'exact'}`;
  if (e.action === 'settings_change') return d.receipt ? 'Receipt settings' : 'POS settings';
  return '';
}

async function loadAudit() {
  const a = await staffGate.call(`/api/audit?${auditQuery()}`);
  if (!R.audit) {
    R.audit = a;
    $('audit-action').innerHTML = `<option value="">Everything</option>${a.actions.map((x) => `<option value="${x}">${esc(ACTION[x] || x)}</option>`).join('')}`;
    $('audit-staff').innerHTML = `<option value="">Anyone</option>${a.staff.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}`;
  }
  $('audit-table').innerHTML = table(`${a.entries.length} entr${a.entries.length === 1 ? 'y' : 'ies'}`, [
    { label: 'When', get: (e) => esc(manilaTime(e.at)) },
    { label: 'What', get: (e) => esc(ACTION[e.action] || e.action) },
    { label: 'Staff', get: (e) => esc(e.staff_name) },
    { label: 'Approved by', get: (e) => esc(e.approver_name || '—') },
    { label: 'Order', get: (e) => (e.order_id ? `#${e.order_id}` : '') },
    { label: 'Amount', get: (e) => (e.amount_cents === null ? '' : moneyC(e.amount_cents)), num: true },
    { label: 'Reason', get: (e) => esc(e.reason) },
    { label: 'Details', get: (e) => esc(auditDetail(e)) },
  ], a.entries, { empty: 'Nothing logged in these dates.' });
}

const LOADERS = { sales: loadSales, scpwd: loadScPwd, discounts: loadDiscounts, audit: loadAudit };

async function show(view = R.view) {
  R.view = view;
  for (const b of document.querySelectorAll('[data-view]')) {
    const on = b.dataset.view === view;
    b.setAttribute('aria-selected', String(on));
    $(`view-${b.dataset.view}`).hidden = !on;
  }
  try {
    pageError('');
    await LOADERS[view]();
  } catch (e) {
    pageError(e.fields ? Object.values(e.fields).join(' ') : e.message);
  }
}

/** Download a CSV through the staff session (a plain link would not carry the PIN). */
async function download(path) {
  const res = await fetch(path, { headers: { 'X-Staff-Token': JSON.parse(sessionStorage.getItem('ss_staff')).token } });
  if (!res.ok) return toast('Could not download. Unlock with the owner PIN and try again.', 'error');
  const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'export.csv';
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/* ---------------------------- start ---------------------------- */

async function ownerArea() {
  await staffGate.start();
  const me = staffGate.staff;
  const owner = me.role === 'owner';
  $('owner-area').hidden = !owner;
  $('not-owner').hidden = owner;
  if (!owner) {
    $('not-owner-who').textContent = `${me.name} is signed in as a ${staffGate.ROLE[me.role].toLowerCase()}.`;
    return;
  }
  $('me').textContent = `${me.name} · Owner`;
  await Promise.all([loadLimit().catch((e) => pageError(e.message)), show()]);
}

function bind() {
  [R.from, R.to] = preset('today');
  $('from').value = R.from;
  $('to').value = R.to;
  document.querySelector('.range__presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    [R.from, R.to] = preset(b.dataset.preset);
    $('from').value = R.from;
    $('to').value = R.to;
    show();
  });
  $('range-form').addEventListener('submit', (e) => {
    e.preventDefault();
    R.from = $('from').value;
    R.to = $('to').value || R.from;
    show();
  });
  document.querySelector('.tabsbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) show(b.dataset.view);
  });
  $('audit-form').addEventListener('submit', (e) => { e.preventDefault(); show('audit'); });
  $('audit-csv').addEventListener('click', () => download(`/api/audit.csv?${auditQuery()}`));
  $('scpwd-csv').addEventListener('click', () => download(`/api/reports/sc-pwd.csv?from=${R.from}&to=${R.to}`));
  $('lock-btn').addEventListener('click', () => staffGate.lock());
  $('switch-staff').addEventListener('click', () => staffGate.lock());
  let shownFor = null;
  staffGate.onChange((s) => {
    const id = s ? s.staff.id : null;
    if (id && shownFor !== null && id !== shownFor) ownerArea().catch((e) => pageError(e.message));
    if (id) shownFor = id;
  });
}

adminBoot(async () => {
  bind();
  await ownerArea();
});
