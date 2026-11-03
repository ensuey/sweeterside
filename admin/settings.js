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

/* ---------------------------- order confirmation ---------------------------- */

function showConfirm(s) {
  $('call-minutes').value = s.confirm_call_minutes;
  $('facebook-url').value = s.facebook_url;
}

async function saveConfirm(event) {
  event.preventDefault();
  const err = $('confirm-err');
  err.hidden = true;
  $('confirm-save').disabled = true;
  try {
    showConfirm(await api('/api/settings', {
      method: 'PUT', body: { confirm_call_minutes: $('call-minutes').value, facebook_url: $('facebook-url').value },
    }));
    toast('Saved.');
  } catch (e) {
    err.textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
    err.hidden = false;
  } finally {
    $('confirm-save').disabled = false;
  }
}

/* ---------------------------- share image ---------------------------- */

const LOGO_SRC = '/assets/Sweeter%20Side%20-%20PNG.png';

function showShare(s) {
  $('share-preview').src = s.share_image ? `/${s.share_image.split('/').map(encodeURIComponent).join('/')}` : LOGO_SRC;
  $('share-remove').hidden = !s.share_image;
  $('share-status').textContent = s.share_image ? '' : 'Using the logo.';
}

/** Upload through the same pipeline as menu photos (type checked, metadata
    stripped), then make it the share image. */
async function uploadShare() {
  const file = $('share-file').files[0];
  if (!file) return;
  $('share-status').textContent = 'Uploading…';
  try {
    const res = await fetch('/api/images', { method: 'POST', headers: { 'X-CSRF-Token': state.csrf }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    const s = await api('/api/settings', { method: 'PUT', body: { share_image: data.path } });
    showShare(s);
    $('share-status').textContent = data.width / data.height < 1.6 || data.width < 1000
      ? `Saved (${data.width} × ${data.height}). A wide picture, about 1200 × 630, shows best.`
      : `Saved (${data.width} × ${data.height}).`;
  } catch (e) {
    $('share-status').textContent = e.fields ? Object.values(e.fields).join(' ') : e.message;
  } finally {
    $('share-file').value = '';
  }
}

async function removeShare() {
  try {
    showShare(await api('/api/settings', { method: 'PUT', body: { share_image: '' } }));
    toast('The logo is used when the site is shared.');
  } catch (e) {
    toast(e.message, 'error');
  }
}

$('trust-form').addEventListener('submit', saveTrust);
$('hours-form').addEventListener('submit', saveHours);
$('confirm-form').addEventListener('submit', saveConfirm);
$('share-file').addEventListener('change', uploadShare);
$('share-remove').addEventListener('click', removeShare);

adminBoot(async () => {
  const s = await api('/api/settings');
  showHours(s);
  showTrust(s);
  showConfirm(s);
  showShare(s);
});
