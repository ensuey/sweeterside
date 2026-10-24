'use strict';
/* The staff PIN lock, shared by the POS and the Staff page. Loaded after
   common.js.

   The tablet is signed in as the admin; whoever is using it taps their name
   and types their PIN. The token that unlocks is kept in sessionStorage (this
   tab only) and sent as X-Staff-Token. When the server answers 423 the POS is
   locked (idle too long, or someone pressed Lock): the PIN screen comes back,
   and the request that was refused is sent again once someone unlocks. POS
   saves carry a request key, so sending one twice is safe.

   staffGate.askOverride() is the owner's PIN for one action. */

const staffGate = (() => {
  const KEY = 'ss_staff';
  const ROLE = { owner: 'Owner', cashier: 'Cashier', waiter: 'Waiter' };
  // What an owner is approving, in words.
  const NEEDS = {
    void: 'Taking off items already sent to the kitchen',
    price_override: 'Changing a price',
    discount_over_limit: 'A discount above the cashier limit',
    manual_discount: 'A manual discount',
    apply_voucher: 'A voucher',
    claim_sc_pwd: 'An SC/PWD discount',
    remove_service_charge: 'Removing the service charge',
    change_delivery_fee: 'Changing the delivery fee',
    takeout_and_delivery: 'A takeout or delivery order',
    take_payment: 'Taking payment',
    refund: 'A refund',
  };

  let current = null; // { token, staff, permissions, lock_minutes }
  try { current = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { current = null; }
  const listeners = [];
  let waiting = null; // the unlock in progress, shared by every request that hit the lock
  let idleTimer = null;

  function save(next) {
    current = next;
    try {
      if (next) sessionStorage.setItem(KEY, JSON.stringify(next));
      else sessionStorage.removeItem(KEY);
    } catch { /* private mode: stays in memory */ }
    listeners.forEach((fn) => fn(current));
    resetIdle();
  }

  function can(permission) {
    return !!current && current.permissions.includes(permission);
  }

  /* ---------------- idle lock ---------------- */

  // The server locks after the idle time too; this just shows the PIN screen
  // at that moment instead of on the next tap.
  function resetIdle() {
    clearTimeout(idleTimer);
    if (!current) return;
    idleTimer = setTimeout(() => lock(), (current.lock_minutes || 5) * 60 * 1000);
  }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (current) resetIdle(); }, true));

  /* ---------------- requests ---------------- */

  /**
   * Like api() in common.js, plus the staff token. A locked POS shows the PIN
   * screen and retries after unlocking. A dropped connection throws with
   * err.offline set.
   */
  async function call(path, { method = 'GET', body } = {}) {
    if (!current) await unlock();
    const headers = { 'X-Staff-Token': current.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw Object.assign(new Error('No connection. Check the Wi-Fi and try again.'), { offline: true });
    }
    if (res.status === 401) {
      window.location.assign('/admin/login');
      throw new Error('Signed out');
    }
    if (res.status === 423) {
      save(null);
      await unlock();
      return call(path, { method, body });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || `Request failed (${res.status})`), {
        status: res.status, fields: data.fields, data,
      });
    }
    return data;
  }

  /* ---------------- PIN pad ---------------- */

  /**
   * A PIN pad in `root`: dots, 0-9, delete and OK, plus the number keys.
   * onSubmit(pin) returns a promise; a rejection shows its message.
   */
  function pinPad(root, onSubmit) {
    let pin = '';
    root.innerHTML = `
      <div class="pin__dots" aria-hidden="true"></div>
      <p class="pin__err" role="alert"></p>
      <div class="pinpad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" class="pinpad__key" data-d="${n}">${n}</button>`).join('')}
        <button type="button" class="pinpad__key pinpad__key--soft" data-del aria-label="Delete">⌫</button>
        <button type="button" class="pinpad__key" data-d="0">0</button>
        <button type="button" class="pinpad__key pinpad__key--ok" data-ok>OK</button>
      </div>`;
    const dots = root.querySelector('.pin__dots');
    const err = root.querySelector('.pin__err');
    let busy = false;
    const draw = () => {
      dots.innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) =>
        `<span class="pin__dot${i < pin.length ? ' is-on' : ''}"></span>`).join('');
      dots.setAttribute('aria-label', `${pin.length} digits entered`);
    };
    const submit = async () => {
      if (busy || pin.length < 4) {
        if (pin.length < 4) err.textContent = 'PINs are 4 to 6 digits.';
        return;
      }
      busy = true;
      err.textContent = '';
      try {
        await onSubmit(pin);
      } catch (e) {
        err.textContent = e.message;
        pin = '';
        draw();
      } finally {
        busy = false;
      }
    };
    const press = (d) => {
      err.textContent = '';
      if (d === 'del') pin = pin.slice(0, -1);
      else if (pin.length < 6) pin += d;
      draw();
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.d !== undefined) press(b.dataset.d);
      else if (b.dataset.del !== undefined) press('del');
      else if (b.dataset.ok !== undefined) submit();
    });
    const onKey = (e) => {
      if (!root.isConnected || root.closest('[hidden]')) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') { e.preventDefault(); submit(); } else return;
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey);
    draw();
    return { reset() { pin = ''; err.textContent = ''; draw(); }, destroy() { document.removeEventListener('keydown', onKey); } };
  }

  /* ---------------- the lock screen ---------------- */

  function lockScreen() {
    let el = document.getElementById('gate');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'gate';
    el.className = 'gate';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'gate-title');
    el.hidden = true;
    el.innerHTML = `
      <div class="gate__panel">
        <img class="gate__logo" src="/assets/Sweeter%20Side%20-%20PNG.png" alt="" width="64" height="64">
        <h1 class="gate__title" id="gate-title">Who's at the counter?</h1>
        <p class="gate__lead" id="gate-lead">Tap your name.</p>
        <ul class="gate__staff" id="gate-staff"></ul>
        <div class="gate__pin" id="gate-pin" hidden></div>
        <button class="btn btn--ghost" type="button" id="gate-back" hidden>Not you? Choose again</button>
        <p class="gate__setup" id="gate-setup" hidden>
          No staff are set up yet. <a href="/admin/staff">Set up the owner's PIN</a> first.
        </p>
        <a class="gate__exit" href="/admin">Back to the admin</a>
      </div>`;
    document.body.appendChild(el);
    return el;
  }

  /** While the PIN screen is up, nothing behind it can be reached, by touch or keyboard. */
  function locked(on) {
    document.body.classList.toggle('is-locked', on);
    for (const el of document.body.children) {
      if (el.id !== 'gate' && el.tagName !== 'SCRIPT') el.inert = on;
    }
  }

  /** Show the PIN screen until someone unlocks. @returns the staff session */
  function unlock() {
    if (waiting) return waiting;
    waiting = new Promise((resolve) => {
      const el = lockScreen();
      const list = el.querySelector('#gate-staff');
      const pinBox = el.querySelector('#gate-pin');
      const back = el.querySelector('#gate-back');
      const lead = el.querySelector('#gate-lead');
      let pad = null;

      const choose = () => {
        if (pad) pad.destroy();
        pinBox.hidden = true;
        back.hidden = true;
        list.hidden = false;
        lead.textContent = 'Tap your name.';
        const first = list.querySelector('button');
        if (first) first.focus();
      };

      el.hidden = false;
      locked(true);
      api('/api/pos/staff').then(({ staff, has_staff: hasStaff }) => {
        el.querySelector('#gate-setup').hidden = hasStaff;
        list.innerHTML = staff.map((s) => `
          <li><button type="button" class="gate__who" data-id="${s.id}" data-name="${esc(s.name)}">
            <span class="gate__name">${esc(s.name)}</span><span class="gate__role">${ROLE[s.role]}</span>
          </button></li>`).join('');
        choose();
      }).catch((e) => { lead.textContent = e.message; });

      list.onclick = (e) => {
        const b = e.target.closest('.gate__who');
        if (!b) return;
        list.hidden = true;
        pinBox.hidden = false;
        back.hidden = false;
        lead.textContent = `${b.dataset.name}, enter your PIN.`;
        pad = pinPad(pinBox, async (pin) => {
          const opened = await api('/api/pos/unlock', { method: 'POST', body: { staff_id: Number(b.dataset.id), pin } });
          pad.destroy();
          el.hidden = true;
          locked(false);
          save(opened);
          waiting = null;
          resolve(opened);
        });
      };
      back.onclick = choose;
    });
    return waiting;
  }

  async function lock() {
    const token = current && current.token;
    save(null);
    if (token) {
      try {
        await fetch('/api/pos/lock', { method: 'POST', headers: { 'X-Staff-Token': token, 'X-CSRF-Token': state.csrf } });
      } catch { /* locked on this tablet either way; the server locks it when idle */ }
    }
    unlock();
  }

  /* ---------------- manager override ---------------- */

  /**
   * Ask an owner to approve `needs` (permission names) with their PIN.
   * options.reason: also ask for a reason, with this label.
   * @returns {Promise<{ staff_id, pin, reason }|null>} null when cancelled
   */
  async function askOverride(needs, { reason = null } = {}) {
    const { staff } = await api('/api/pos/staff');
    const owners = staff.filter((s) => s.role === 'owner');
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'modal modal--sm override';
      dlg.setAttribute('aria-labelledby', 'ov-title');
      dlg.innerHTML = `
        <div class="modal__form">
          <div class="modal__head"><h2 class="modal__title" id="ov-title">Owner approval</h2></div>
          <div class="modal__body">
            <ul class="override__needs">${needs.map((n) => `<li>${esc(NEEDS[n] || n)}</li>`).join('')}</ul>
            ${reason ? `<div class="field"><label for="ov-reason">${esc(reason)}</label>
              <input id="ov-reason" maxlength="200" autocomplete="off"></div>` : ''}
            <div class="field">
              <label for="ov-owner">Owner</label>
              <select id="ov-owner">${owners.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
            </div>
            <div class="override__pin"></div>
          </div>
          <div class="modal__foot"><button class="btn btn--ghost" type="button" data-cancel>Cancel</button></div>
        </div>`;
      document.body.appendChild(dlg);
      const done = (value) => { pad.destroy(); dlg.close(); dlg.remove(); resolve(value); };
      const pad = pinPad(dlg.querySelector('.override__pin'), async (pin) => {
        const why = reason ? dlg.querySelector('#ov-reason').value.trim() : null;
        if (reason && !why) throw new Error('Give a reason first.');
        done({ staff_id: Number(dlg.querySelector('#ov-owner').value), pin, reason: why });
      });
      dlg.querySelector('[data-cancel]').onclick = () => done(null);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
      dlg.showModal();
      (dlg.querySelector('#ov-reason') || dlg.querySelector('.pinpad__key')).focus();
    });
  }

  /* ---------------- start ---------------- */

  /** Check the saved session still works (or ask for a PIN). */
  async function start() {
    if (current) {
      try {
        const me = await call('/api/pos/me');
        save({ ...current, staff: me.staff, permissions: me.permissions });
        return current;
      } catch (e) {
        if (e.offline) return current;
      }
    }
    save(null);
    return unlock();
  }

  return {
    ROLE, NEEDS, start, call, can, lock, unlock, askOverride, pinPad,
    get staff() { return current && current.staff; },
    onChange(fn) { listeners.push(fn); },
  };
})();
