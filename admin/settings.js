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

$('trust-form').addEventListener('submit', saveTrust);

adminBoot(async () => showTrust(await api('/api/settings')));
