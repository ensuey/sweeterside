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
    const s = await api('/api/settings', { method: 'PUT', body: { open_at: $('open-at').value, close_at: $('close-at').value } });
    showHours(s);
    toast(`Saved. Online ordering is open ${clock12(s.open_at)} to ${clock12(s.close_at)} every day.`);
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('hours-save').disabled = false;
  }
}

$('trust-form').addEventListener('submit', saveTrust);
$('hours-form').addEventListener('submit', saveHours);

adminBoot(async () => {
  const s = await api('/api/settings');
  showHours(s);
  showTrust(s);
});
