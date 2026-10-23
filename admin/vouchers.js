'use strict';
/* Vouchers page: codes customers type at checkout, with an on/off switch and
   optional first and last days. */

Object.assign(state, {
  vouchers: [],
  editingId: null,     // null = creating
  pendingDelete: null, // the voucher waiting on the confirm dialog
});

const list = $('vouchers');
const editor = $('editor');
const confirmDialog = $('confirm');

const STATUS_LABEL = { active: 'Active', off: 'Off', scheduled: 'Scheduled', expired: 'Expired' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-01' -> '1 Nov 2026' */
function niceDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function datesText(v) {
  if (v.valid_from && v.valid_until) return `${niceDate(v.valid_from)} to ${niceDate(v.valid_until)}`;
  if (v.valid_from) return `From ${niceDate(v.valid_from)}`;
  if (v.valid_until) return `Until ${niceDate(v.valid_until)}`;
  return 'Any day';
}

/* ---------------------------- rendering ---------------------------- */

// Codes are restricted to A–Z, 0–9 and dashes by the server, but escape anyway.
function voucherHtml(v) {
  return `
    <li class="row-item voucher-row" data-id="${v.id}" data-status="${esc(v.status)}">
      <div class="row-item__main">
        <span class="row-item__name voucher-row__code">${esc(v.code)}</span>
        <span class="row-item__meta">${esc(v.label)} · ${esc(datesText(v))}</span>
        <span class="row-item__today">${plural(v.uses, 'order')} so far</span>
      </div>
      <span class="voucher-row__status">${STATUS_LABEL[v.status] || esc(v.status)}</span>
      <label class="voucher-row__switch">
        <input type="checkbox" data-action="active"${v.active ? ' checked' : ''}>
        <span>On</span>
      </label>
      <div class="row-item__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-action="edit">Edit</button>
        <button class="btn btn--danger-ghost btn--sm" type="button" data-action="delete">Delete</button>
      </div>
    </li>`;
}

function render() {
  list.innerHTML = state.vouchers.map(voucherHtml).join('');
  const total = state.vouchers.length;
  const working = state.vouchers.filter((v) => v.status === 'active').length;
  $('summary').textContent = total === 0
    ? 'No vouchers yet.'
    : `${plural(total, 'voucher')}, ${working} working today. Uses count orders that were not cancelled.`;
  $('empty').hidden = total > 0;
}

async function loadVouchers() {
  const { vouchers } = await api('/api/vouchers');
  state.vouchers = vouchers;
  render();
}

/* ---------------------------- editor ---------------------------- */

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

/** The cap only applies to a percentage. */
function updateKind() {
  const percent = $('v-kind').value === 'percent';
  $('v-unit').textContent = percent ? '(%)' : '(Php)';
  $('v-max-field').hidden = !percent;
}

function openEditor(v) {
  state.editingId = v ? v.id : null;
  clearFieldErrors();
  $('editor-title').textContent = v ? 'Edit voucher' : 'Add voucher';
  $('editor-save').textContent = v ? 'Save changes' : 'Add voucher';
  $('v-code').value = v ? v.code : '';
  $('v-kind').value = v ? v.kind : 'percent';
  $('v-value').value = v ? v.value : '';
  $('v-max').value = v && v.max_off != null ? v.max_off : '';
  $('v-from').value = v && v.valid_from ? v.valid_from : '';
  $('v-until').value = v && v.valid_until ? v.valid_until : '';
  updateKind();
  editor.showModal();
  $('v-code').focus();
}

async function saveVoucher(event) {
  event.preventDefault();
  clearFieldErrors();

  const payload = {
    code: $('v-code').value,
    kind: $('v-kind').value,
    value: $('v-value').value,
    max_off: $('v-kind').value === 'percent' ? $('v-max').value : '',
    valid_from: $('v-from').value,
    valid_until: $('v-until').value,
  };

  const save = $('editor-save');
  save.disabled = true;
  try {
    if (state.editingId === null) {
      const { voucher } = await api('/api/vouchers', { method: 'POST', body: payload });
      toast(`${voucher.code} added: ${voucher.label}.`);
    } else {
      const { voucher } = await api(`/api/vouchers/${state.editingId}`, { method: 'PUT', body: payload });
      toast(`${voucher.code} saved.`);
    }
    editor.close();
    await loadVouchers();
  } catch (err) {
    if (err.fields) showFieldErrors(err.fields);
    const box = $('editor-error');
    box.textContent = err.message;
    box.hidden = false;
  } finally {
    save.disabled = false;
  }
}

/* ---------------------------- actions ---------------------------- */

async function setActive(v, active, checkbox) {
  checkbox.disabled = true;
  try {
    await api(`/api/vouchers/${v.id}/active`, { method: 'PATCH', body: { active } });
    toast(active ? `${v.code} is on.` : `${v.code} is off. Customers can no longer use it.`);
    await loadVouchers();
  } catch (err) {
    checkbox.checked = !active;
    toast(err.message, 'error');
  } finally {
    checkbox.disabled = false;
  }
}

function askDelete(v) {
  state.pendingDelete = v;
  $('confirm-text').textContent = v.uses
    ? `“${v.code}” stops working straight away. The ${plural(v.uses, 'order')} that used it keep their discount.`
    : `“${v.code}” stops working straight away.`;
  confirmDialog.showModal();
}

async function doDelete() {
  const v = state.pendingDelete;
  if (!v) return;
  $('confirm-ok').disabled = true;
  try {
    await api(`/api/vouchers/${v.id}`, { method: 'DELETE' });
    confirmDialog.close();
    toast(`${v.code} deleted.`);
    await loadVouchers();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('confirm-ok').disabled = false;
    state.pendingDelete = null;
  }
}

/* ---------------------------- events ---------------------------- */

$('add').addEventListener('click', () => openEditor(null));

list.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const v = state.vouchers.find((x) => x.id === Number(btn.closest('.row-item').dataset.id));
  if (!v) return;
  if (btn.dataset.action === 'edit') openEditor(v);
  if (btn.dataset.action === 'delete') askDelete(v);
});

list.addEventListener('change', (event) => {
  if (!event.target.matches('[data-action="active"]')) return;
  const v = state.vouchers.find((x) => x.id === Number(event.target.closest('.row-item').dataset.id));
  if (v) setActive(v, event.target.checked, event.target);
});

$('v-kind').addEventListener('change', updateKind);
$('editor-form').addEventListener('submit', saveVoucher);
$('editor-close').addEventListener('click', () => editor.close());
$('editor-cancel').addEventListener('click', () => editor.close());
$('confirm-cancel').addEventListener('click', () => confirmDialog.close());
$('confirm-ok').addEventListener('click', doDelete);

adminBoot(loadVouchers);
