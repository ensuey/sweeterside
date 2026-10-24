'use strict';
/* Blocked numbers page: numbers that may not order or book a cake online.
   Numbers are normalised by the server, so 0917…, +63 917… and 63917… are one entry. */

Object.assign(state, {
  blocked: [],
  pendingUnblock: null, // the entry waiting on the confirm dialog
});

const list = $('blocked');
const confirmDialog = $('confirm');

/** SQLite stores datetime('now') in UTC without a zone marker. */
function blockedDate(sqlTime) {
  const d = new Date(`${String(sqlTime).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function rowHtml(b) {
  const meta = [`Blocked ${blockedDate(b.created_at)}`];
  if (b.created_by) meta.push(`by ${b.created_by}`);
  return `
    <li class="row-item" data-id="${b.id}">
      <div class="row-item__main">
        <span class="row-item__name">${esc(b.display)}</span>
        ${b.reason ? `<span class="row-item__meta">${esc(b.reason)}</span>` : ''}
        <span class="row-item__today">${esc(meta.join(' '))}</span>
      </div>
      <div class="row-item__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-action="unblock">Unblock</button>
      </div>
    </li>`;
}

function render() {
  list.innerHTML = state.blocked.map(rowHtml).join('');
  const n = state.blocked.length;
  $('summary').textContent = n
    ? `${plural(n, 'number')} cannot order or book a cake online. They are asked to call or message instead.`
    : 'Nobody is blocked.';
  $('empty').hidden = n > 0;
}

async function loadBlocked() {
  state.blocked = (await api('/api/blocked')).blocked;
  render();
}

async function addBlocked(event) {
  event.preventDefault();
  const err = $('add-err');
  err.hidden = true;
  $('add-save').disabled = true;
  try {
    const { blocked } = await api('/api/blocked', {
      method: 'POST', body: { phone: $('b-phone').value, reason: $('b-reason').value },
    });
    $('add-form').reset();
    toast(`${blocked.display} is blocked.`);
    await loadBlocked();
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('add-save').disabled = false;
  }
}

list.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-action="unblock"]');
  if (!btn) return;
  const entry = state.blocked.find((b) => b.id === Number(btn.closest('.row-item').dataset.id));
  if (!entry) return;
  state.pendingUnblock = entry;
  $('confirm-text').textContent = `${entry.display} will be able to order and book cakes online again.`;
  confirmDialog.showModal();
});

$('confirm-cancel').addEventListener('click', () => confirmDialog.close());
$('confirm-ok').addEventListener('click', async () => {
  const entry = state.pendingUnblock;
  if (!entry) return;
  $('confirm-ok').disabled = true;
  try {
    await api(`/api/blocked/${entry.id}`, { method: 'DELETE' });
    confirmDialog.close();
    toast(`${entry.display} is unblocked.`);
    await loadBlocked();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    $('confirm-ok').disabled = false;
    state.pendingUnblock = null;
  }
});

$('add-form').addEventListener('submit', addBlocked);

adminBoot(loadBlocked);
