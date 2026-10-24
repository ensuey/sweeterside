'use strict';
/* Staff page: the owner adds staff, changes roles, switches people off,
   resets PINs, and sets the POS and tax settings. Loaded after common.js and
   staff-gate.js. Needs the owner's PIN; the very first owner is set up here
   with the admin password. */

const ROLE_OPTIONS = ['owner', 'cashier', 'waiter'];

function fieldErr(id, message) {
  $(id).textContent = message || '';
  $(id).hidden = !message;
}

function errText(e) {
  return e.fields ? Object.values(e.fields).join(' ') : e.message;
}

/* ---------------------------- first owner ---------------------------- */

function showSetup() {
  $('setup').hidden = false;
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    fieldErr('setup-err', '');
    const pin = $('setup-pin').value;
    if (pin !== $('setup-pin2').value) return fieldErr('setup-err', 'The two PINs are different.');
    try {
      await api('/api/staff/first', {
        method: 'POST',
        body: { name: $('setup-name').value, pin, password: $('setup-password').value },
      });
      $('setup').hidden = true;
      toast('Owner set up. Unlock with your PIN.');
      await ownerArea();
    } catch (err) {
      fieldErr('setup-err', errText(err));
    }
  });
}

/* ---------------------------- staff ---------------------------- */

let resetting = null;

async function loadStaff() {
  const { staff } = await staffGate.call('/api/staff');
  const me = staffGate.staff;
  $('staff-list').innerHTML = staff.map((s) => `
    <li class="staff-row${s.active ? '' : ' is-off'}" data-id="${s.id}" data-name="${esc(s.name)}">
      <span class="staff-row__name">${esc(s.name)}${s.id === me.id ? ' <span class="hint">(you)</span>' : ''}${s.active ? '' : ' <span class="hint">· switched off</span>'}</span>
      <label class="vh" for="role-${s.id}">Role of ${esc(s.name)}</label>
      <select id="role-${s.id}" data-role>
        ${ROLE_OPTIONS.map((r) => `<option value="${r}"${r === s.role ? ' selected' : ''}>${staffGate.ROLE[r]}</option>`).join('')}
      </select>
      <button class="btn btn--ghost btn--sm" type="button" data-pin>Reset PIN</button>
      <button class="btn ${s.active ? 'btn--danger-ghost' : 'btn--ghost'} btn--sm" type="button" data-active="${s.active ? '0' : '1'}">
        ${s.active ? 'Switch off' : 'Switch on'}</button>
    </li>`).join('');
}

async function updateStaff(id, body, done) {
  try {
    const { staff } = await staffGate.call(`/api/staff/${id}`, { method: 'PATCH', body });
    toast(done(staff));
  } catch (err) {
    toast(errText(err), 'error');
  }
  await loadStaff();
}

/* ---------------------------- POS and tax settings ---------------------------- */

async function loadSettings() {
  const s = await staffGate.call('/api/pos/settings');
  $('svc-on').checked = s.service_charge.on;
  $('svc-rate').value = s.service_charge.rate_bp / 100;
  $('svc-base').value = s.service_charge.base;
  for (const c of document.querySelectorAll('[data-svc-type]')) c.checked = s.service_charge.types.includes(c.dataset.svcType);
  $('limit').value = s.cashier_discount_limit_bp / 100;
  $('lock-min').value = s.pos_lock_minutes;
  for (const r of document.getElementsByName('vat')) r.checked = s.vat_registered !== null && r.value === (s.vat_registered ? '1' : '0');
}

/* ---------------------------- start ---------------------------- */

async function ownerArea() {
  await staffGate.start();
  const me = staffGate.staff;
  if (me.role !== 'owner') {
    $('owner-area').hidden = true;
    $('not-owner').hidden = false;
    $('not-owner-who').textContent = `${me.name} is signed in as a ${staffGate.ROLE[me.role].toLowerCase()}.`;
    return;
  }
  $('not-owner').hidden = true;
  $('owner-area').hidden = false;
  $('me').textContent = `${me.name} · Owner`;
  await Promise.all([loadStaff(), loadSettings()]);
}

function bind() {
  $('switch-staff').addEventListener('click', async () => { await staffGate.lock(); });
  $('lock-btn').addEventListener('click', () => staffGate.lock());
  // Someone else unlocked after a lock: show the page for them.
  let shownFor = null;
  staffGate.onChange((s) => {
    const id = s ? s.staff.id : null;
    if (id && shownFor !== null && id !== shownFor) ownerArea().catch((e) => pageError(e.message));
    if (id) shownFor = id;
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    fieldErr('add-err', '');
    try {
      const { staff } = await staffGate.call('/api/staff', {
        method: 'POST', body: { name: $('add-name').value, role: $('add-role').value, pin: $('add-pin').value },
      });
      $('add-form').reset();
      toast(`${staff.name} added.`);
      await loadStaff();
    } catch (err) {
      fieldErr('add-err', errText(err));
    }
  });

  $('staff-list').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-role]');
    if (!sel) return;
    const row = sel.closest('[data-id]');
    updateStaff(row.dataset.id, { role: sel.value }, (s) => `${s.name} is now ${staffGate.ROLE[s.role].toLowerCase()}.`);
  });
  $('staff-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    if (e.target.closest('[data-pin]')) {
      resetting = row.dataset.id;
      $('pin-title').textContent = `New PIN for ${row.dataset.name}`;
      $('pin-form').reset();
      fieldErr('pin-err', '');
      $('pin-dialog').showModal();
    }
    const act = e.target.closest('[data-active]');
    if (act) {
      updateStaff(row.dataset.id, { active: act.dataset.active === '1' },
        (s) => `${s.name} is switched ${s.active ? 'on' : 'off'}.`);
    }
  });

  $('pin-cancel').addEventListener('click', () => $('pin-dialog').close());
  $('pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('pin-new').value !== $('pin-new2').value) return fieldErr('pin-err', 'The two PINs are different.');
    try {
      const { staff } = await staffGate.call(`/api/staff/${resetting}/pin`, { method: 'POST', body: { pin: $('pin-new').value } });
      $('pin-dialog').close();
      toast(`New PIN saved for ${staff.name}.`);
    } catch (err) {
      fieldErr('pin-err', errText(err));
    }
  });

  $('pos-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await staffGate.call('/api/pos/settings', {
        method: 'PUT',
        body: {
          service_charge_on: $('svc-on').checked,
          service_charge_rate: $('svc-rate').value,
          service_charge_base: $('svc-base').value,
          service_charge_types: [...document.querySelectorAll('[data-svc-type]')].filter((c) => c.checked).map((c) => c.dataset.svcType),
          cashier_discount_limit: $('limit').value,
          pos_lock_minutes: $('lock-min').value,
        },
      });
      toast('POS settings saved.');
      await loadSettings();
    } catch (err) {
      toast(errText(err), 'error');
    }
  });

  $('tax-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const choice = [...document.getElementsByName('vat')].find((r) => r.checked);
    if (!choice) return toast('Choose non-VAT or VAT-registered.', 'error');
    try {
      const s = await staffGate.call('/api/pos/settings', { method: 'PUT', body: { vat_registered: choice.value === '1' } });
      toast(s.vat_registered ? 'Saved: VAT-registered.' : 'Saved: non-VAT registered.');
    } catch (err) {
      toast(errText(err), 'error');
    }
  });
}

adminBoot(async () => {
  bind();
  const { has_staff: hasStaff } = await api('/api/pos/staff');
  if (!hasStaff) return showSetup();
  await ownerArea();
});
