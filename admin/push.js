'use strict';
/* Settings page: order alerts on this device (Web Push). Loaded after
   settings.js; uses api(), toast() and state.csrf from common.js.

   An iPhone only allows push from the admin added to the Home Screen, so in
   plain Safari this explains how to add it instead of offering the button. */

const ALERTS = { publicKey: null, endpoint: null, registration: null };

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS asks for the desktop site
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

/** A short name for this device in the list. */
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || isIos()) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Device';
}

function keyBytes(b64url) {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The same short hash the server shows, to spot this device in the list. */
async function endpointHash(endpoint) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16);
}

function showDevices(devices, mine) {
  $('alerts-devices-title').hidden = !devices.length;
  $('alerts-devices').innerHTML = devices.map((d) => `
    <li class="alerts__device" data-device-id="${d.id}">
      <span><strong>${esc(d.label)}</strong>${d.endpoint_hash === mine ? ' <span class="flag flag--good">This device</span>' : ''}
        <span class="hint">· on since ${esc(String(d.created_at).slice(0, 10))}${d.last_ok_at ? ` · last alert ${esc(String(d.last_ok_at).slice(0, 16))} UTC` : ''}</span></span>
      <button class="link-quiet" type="button" data-device-remove>Remove</button>
    </li>`).join('');
}

function setState(text) {
  $('alerts-state').textContent = text;
}

async function refreshAlerts() {
  const data = await api('/api/push');
  ALERTS.publicKey = data.public_key;
  let mine = null;
  if (pushSupported()) {
    ALERTS.registration = await navigator.serviceWorker.getRegistration('/admin').catch(() => null);
    const sub = ALERTS.registration && await ALERTS.registration.pushManager.getSubscription().catch(() => null);
    ALERTS.endpoint = sub ? sub.endpoint : null;
    if (sub) mine = await endpointHash(sub.endpoint);
  }
  const listed = mine && data.devices.some((d) => d.endpoint_hash === mine);
  showDevices(data.devices, mine);

  $('alerts-ios').hidden = true;
  $('alerts-on').hidden = true;
  $('alerts-off').hidden = true;
  $('alerts-test').hidden = !data.devices.length || !data.enabled;

  if (!data.enabled) return setState('Alerts are not set up on the server yet.');
  if (!pushSupported()) {
    if (isIos() && !isStandalone()) {
      $('alerts-ios').hidden = false;
      return setState('Add the admin to your Home Screen to get alerts on this iPhone.');
    }
    return setState('This browser cannot show alerts. Try Safari on iPhone (from the Home Screen), or Chrome.');
  }
  if (Notification.permission === 'denied') {
    return setState('Notifications are blocked for this app. Allow them in Settings → Notifications → Sweeter Side, then come back.');
  }
  if (listed) {
    $('alerts-off').hidden = false;
    return setState('Alerts are on for this device.');
  }
  $('alerts-on').hidden = false;
  return setState('Alerts are off on this device.');
}

async function turnOn() {
  const b = $('alerts-on');
  b.disabled = true;
  try {
    // Asked straight from the tap: iPhone only shows the question then.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notifications were not allowed, so alerts stay off.', 'warn');
      return;
    }
    const reg = await navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin' });
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(ALERTS.publicKey) });
    const json = sub.toJSON();
    await api('/api/push/subscriptions', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys, label: deviceLabel() } });
    toast('Alerts are on. Send a test to check.');
  } catch (err) {
    toast(err.fields ? Object.values(err.fields).join(' ') : `Could not turn alerts on: ${err.message}`, 'error');
  } finally {
    b.disabled = false;
    refreshAlerts().catch(() => {});
  }
}

async function turnOff() {
  try {
    const sub = ALERTS.registration && await ALERTS.registration.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    toast('Alerts are off on this device.');
  } catch (err) {
    toast(err.message, 'error');
  }
  refreshAlerts().catch(() => {});
}

async function sendTest() {
  const b = $('alerts-test');
  b.disabled = true;
  try {
    const r = await api('/api/push/test', { method: 'POST' });
    toast(r.sent
      ? `Test alert sent to ${plural(r.sent, 'device')}.${r.failed ? ` ${r.failed} did not answer.` : ''}${r.removed ? ` ${r.removed} removed (alerts were turned off there).` : ''}`
      : 'No device took the test alert. Turn alerts on again on the phone.', r.sent ? 'ok' : 'warn');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    b.disabled = false;
    refreshAlerts().catch(() => {});
  }
}

$('alerts-on').addEventListener('click', turnOn);
$('alerts-off').addEventListener('click', turnOff);
$('alerts-test').addEventListener('click', sendTest);
$('alerts-devices').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-device-remove]');
  if (!b) return;
  const id = b.closest('[data-device-id]').dataset.deviceId;
  try {
    await api(`/api/push/subscriptions/${id}`, { method: 'DELETE' });
    toast('That device will no longer get alerts.');
  } catch (err) {
    toast(err.message, 'error');
  }
  refreshAlerts().catch(() => {});
});

refreshAlerts().catch(() => setState('Could not check alerts. Reload the page.'));
