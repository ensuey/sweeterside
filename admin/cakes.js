'use strict';
/* Cakes page: custom cake booking requests, and what customers can choose. */

Object.assign(state, {
  bookings: [],
  show: 'upcoming', // 'upcoming' | 'past'
  dirty: new Set(), // booking ids with unsaved changes; not redrawn under the user
});

const CAKE_STATUS = {
  new: 'New request',
  quoted: 'Price quoted',
  confirmed: 'Confirmed',
  completed: 'Completed',
  declined: 'Declined',
};
const POLL_MS = 60000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const list = $('bookings');

/* ---------------------------- dates ---------------------------- */

/** Today in Manila, 'YYYY-MM-DD'. */
function manilaToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** '2026-11-08' -> 'Sun 8 Nov · in 3 days' */
function whenText(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const label = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const days = Math.round((d - new Date(`${manilaToday()}T00:00:00Z`)) / 86400000);
  if (days === 0) return `${label} · today`;
  if (days === 1) return `${label} · tomorrow`;
  if (days > 1) return `${label} · in ${days} days`;
  if (days === -1) return `${label} · yesterday`;
  return `${label} · ${-days} days ago`;
}

/* ---------------------------- rendering ---------------------------- */

// Everything here except the numbers was typed by a customer: escape it all.
function detail(label, value) {
  return value ? `<dt>${label}</dt><dd>${esc(value)}</dd>` : '';
}

function bookingHtml(b) {
  const options = Object.entries(CAKE_STATUS)
    .map(([value, label]) => `<option value="${value}"${value === b.status ? ' selected' : ''}>${label}</option>`)
    .join('');
  const photo = b.photo
    ? `<button class="cake__photo" type="button" data-action="photo" aria-label="View the reference photo full size">
         <img src="/api/cakes/${b.id}/photo" alt="Reference photo for request ${b.id}" loading="lazy">
       </button>`
    : '';

  return `
    <li class="order cake" data-id="${b.id}" data-status="${esc(b.status)}">
      <div class="order__head">
        <span class="order__id">#${b.id}</span>
        <span class="order__type">${esc(whenText(b.needed_on))}</span>
        <span class="order__time">${b.handover === 'delivery' ? 'Delivery' : 'Pick-up'}</span>
      </div>
      <div class="order__who">
        <span class="order__name">${esc(b.customer_name)}</span>
        <a class="order__phone" href="tel:${esc(b.phone)}">${esc(b.phone)}</a>
        ${b.handover === 'delivery' ? `<span class="order__addr">${esc(b.address)}</span>` : ''}
      </div>
      <div class="cake__body">
        <dl class="cake__details">
          <dt>Size</dt><dd>${esc(b.size)} <span class="hint">(from ${money(b.size_from_price)})</span></dd>
          ${detail('Flavour', b.flavour)}
          ${detail('Occasion', b.occasion)}
          ${detail('On the cake', b.cake_message)}
          ${detail('Design', b.design_notes)}
        </dl>
        ${photo}
      </div>
      <form class="cake__admin" data-booking-form novalidate>
        <div class="cake__fields">
          <label class="stock__field">
            <span>Status</span>
            <select name="status">${options}</select>
          </label>
          <label class="stock__field">
            <span>Price quoted (Php)</span>
            <input name="quoted_price" type="number" min="0" step="1" inputmode="numeric" value="${b.quoted_price ?? ''}">
          </label>
          <label class="stock__field cake__deposit">
            <span>Deposit</span>
            <span class="cake__deposit-row">
              <input name="deposit_paid" type="checkbox"${b.deposit_paid ? ' checked' : ''} aria-label="Deposit received">
              <input name="deposit_amount" type="number" min="1" step="1" inputmode="numeric" placeholder="Amount" value="${b.deposit_amount ?? ''}" aria-label="Deposit amount in pesos">
            </span>
          </label>
        </div>
        <label class="stock__field">
          <span>Note <span class="hint">(only you see this)</span></span>
          <textarea name="admin_note" rows="2" maxlength="1000">${esc(b.admin_note)}</textarea>
        </label>
        <p class="field__err" data-err hidden></p>
        <div class="cake__save">
          <button class="btn btn--primary btn--sm" type="submit">Save</button>
        </div>
      </form>
    </li>`;
}

function render(counts) {
  list.innerHTML = state.bookings.map(bookingHtml).join('');
  state.dirty.clear();
  $('n-upcoming').textContent = counts.upcoming;
  showCakeCount(counts.new);

  const empty = $('bookings-empty');
  empty.hidden = state.bookings.length > 0;
  empty.textContent = state.show === 'upcoming'
    ? 'No cake bookings coming up. New requests appear here on their own.'
    : 'Nothing here yet.';

  $('summary').textContent = counts.new
    ? `${plural(counts.new, 'new request')} to review.`
    : counts.upcoming ? `${plural(counts.upcoming, 'cake')} coming up.` : 'No requests waiting.';
  document.title = counts.new ? `(${counts.new}) Cakes — Sweeter Side admin` : 'Cakes — Sweeter Side admin';
}

async function loadBookings({ force = false } = {}) {
  const { bookings, counts } = await api(`/api/cakes?show=${state.show}`);
  state.bookings = bookings;
  // Never redraw a card someone is part-way through editing.
  if (!force && (state.dirty.size || (document.activeElement && list.contains(document.activeElement)))) {
    $('n-upcoming').textContent = counts.upcoming;
    showCakeCount(counts.new);
    return;
  }
  render(counts);
}

/* ---------------------------- saving ---------------------------- */

async function saveBooking(form) {
  const card = form.closest('.cake');
  const id = Number(card.dataset.id);
  const err = form.querySelector('[data-err]');
  const button = form.querySelector('button[type="submit"]');
  err.hidden = true;
  button.disabled = true;
  try {
    const { booking } = await api(`/api/cakes/${id}`, {
      method: 'PATCH',
      body: {
        status: form.elements.status.value,
        quoted_price: form.elements.quoted_price.value,
        deposit_paid: form.elements.deposit_paid.checked,
        deposit_amount: form.elements.deposit_amount.value,
        admin_note: form.elements.admin_note.value,
      },
    });
    toast(`Request #${id}: ${CAKE_STATUS[booking.status].toLowerCase()}.`);
    state.dirty.delete(id);
    await loadBookings({ force: true });
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    button.disabled = false;
  }
}

/* ---------------------------- settings ---------------------------- */

function showSettings(s) {
  $('s-lead').value = s.lead_days;
  $('s-max').value = s.max_per_day ?? '';
  $('s-sizes').value = s.sizes.map((x) => `${x.name} | ${x.from_price}`).join('\n');
  $('s-flavours').value = s.flavours.join('\n');
}

async function saveSettings(event) {
  event.preventDefault();
  const form = $('settings-form');
  form.querySelectorAll('[data-err]').forEach((el) => { el.hidden = true; el.textContent = ''; });
  $('settings-save').disabled = true;
  try {
    const s = await api('/api/cake-settings', {
      method: 'PUT',
      body: {
        lead_days: $('s-lead').value,
        max_per_day: $('s-max').value,
        sizes: $('s-sizes').value,
        flavours: $('s-flavours').value,
      },
    });
    showSettings(s);
    toast('Booking settings saved. The booking page shows them straight away.');
  } catch (e) {
    Object.entries(e.fields || {}).forEach(([name, message]) => {
      const el = form.querySelector(`[data-err="${name}"]`);
      if (el) { el.textContent = message; el.hidden = false; }
    });
    if (!e.fields) toast(e.message, 'error');
  } finally {
    $('settings-save').disabled = false;
  }
}

/* ---------------------------- events ---------------------------- */

list.addEventListener('submit', (event) => {
  if (!event.target.matches('[data-booking-form]')) return;
  event.preventDefault();
  saveBooking(event.target);
});

list.addEventListener('input', (event) => {
  const card = event.target.closest('.cake');
  if (card) state.dirty.add(Number(card.dataset.id));
});
list.addEventListener('change', (event) => {
  const card = event.target.closest('.cake');
  if (card) state.dirty.add(Number(card.dataset.id));
});

list.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-action="photo"]');
  if (!btn) return;
  const id = btn.closest('.cake').dataset.id;
  $('photo-full').src = `/api/cakes/${id}/photo`;
  $('photo-full').alt = `Reference photo for request ${id}`;
  $('photo-title').textContent = `Reference photo, request #${id}`;
  $('photo-view').showModal();
});
$('photo-close').addEventListener('click', () => $('photo-view').close());

document.querySelectorAll('.tab[data-show]').forEach((tab) => {
  tab.addEventListener('click', async () => {
    state.show = tab.dataset.show;
    document.querySelectorAll('.tab[data-show]').forEach((t) => {
      t.setAttribute('aria-pressed', String(t === tab));
    });
    try { await loadBookings({ force: true }); } catch (err) { toast(err.message, 'error'); }
  });
});

$('settings-form').addEventListener('submit', saveSettings);

setInterval(() => {
  if (document.visibilityState === 'visible') loadBookings().catch(() => {});
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadBookings().catch(() => {});
});

adminBoot(async () => {
  const [, settings] = await Promise.all([loadBookings({ force: true }), api('/api/cake-settings')]);
  showSettings(settings);
});
