'use strict';
/* POS: Utang, customers who pay later. Loaded after pos-pay.js, whose
   printing and money helpers it uses.

   The list shows who owes what. Opening someone shows what was charged and
   paid back, takes a payment towards the balance (cash goes into the
   drawer) and prints a slip or a statement. The owner adds people and sets
   limits; a cashier can too with the owner's PIN.

   The pay screen picks the customer here (UTANG.fillPicker). The server
   checks the list, the limit and every permission. */

const UTANG = (() => {
  const S = { accounts: [], account: null, history: [], key: null };

  const can = () => staffGate.can('give_credit') || staffGate.can('collect_credit');
  const errorText = (e) => (e.fields ? Object.values(e.fields).join(' ') : e.message);

  /** POST or PATCH; when the owner must approve, ask for the PIN and send again. */
  async function withOwner(path, method, body) {
    for (;;) { // until it goes through or is cancelled: a wrong PIN asks again
      try {
        return await staffGate.call(path, { method, body });
      } catch (e) {
        const data = e.data || {};
        if (e.status === 403 && data.override_required) {
          const ov = await staffGate.askOverride(data.needs);
          if (!ov) return null;
          body.override = { staff_id: ov.staff_id, pin: ov.pin };
          continue;
        }
        if (e.status === 403 && data.wrong_pin) { toast(e.message, 'error'); delete body.override; continue; }
        throw e;
      }
    }
  }

  async function load() {
    const { accounts } = await staffGate.call('/api/pos/credit');
    S.accounts = accounts;
    return accounts;
  }

  /* ---------------------------- the pay screen ---------------------------- */

  function pickerInfo() {
    const a = S.accounts.find((x) => x.id === Number($('utang-account').value));
    $('utang-info').textContent = !a ? ''
      : `Owes ${moneyC(Math.max(0, a.balance_cents))}${a.limit_cents === null ? ' · no limit'
        : ` · limit ${moneyC(a.limit_cents)} · ${moneyC(a.left_cents)} left`}${a.note ? ` · ${a.note}` : ''}`;
  }

  /** Fill the pay screen's customer list. keep: the id to select. */
  async function fillPicker(keep = null) {
    const before = keep || Number($('utang-account').value) || null;
    await load();
    const active = S.accounts.filter((a) => a.active).sort((x, y) => x.name.localeCompare(y.name));
    $('utang-account').replaceChildren(
      new Option(active.length ? 'Choose a customer…' : 'No one on the list yet', ''),
      ...active.map((a) => new Option(a.name, String(a.id), false, a.id === before)));
    pickerInfo();
  }

  /* ---------------------------- add or change someone ---------------------------- */

  /** The add / edit form. @returns the saved account, or null when cancelled. */
  function editAccount(account = null) {
    return new Promise((resolve) => {
      const dlg = $('utang-edit-dialog');
      $('utang-edit-title').textContent = account ? `Change ${account.name}` : 'Add to the Utang list';
      $('ue-name').value = account ? account.name : '';
      $('ue-phone').value = account ? account.phone : '';
      $('ue-limit').value = account && account.limit_cents !== null ? String(account.limit_cents / 100) : '';
      $('ue-note').value = account ? account.note : '';
      $('ue-active-box').hidden = !account;
      $('ue-active').checked = account ? account.active : true;
      $('ue-err').hidden = true;
      const finish = (v) => {
        $('utang-edit-form').onsubmit = null;
        $('ue-cancel').onclick = null;
        dlg.onclose = null;
        if (dlg.open) dlg.close();
        resolve(v);
      };
      $('utang-edit-form').onsubmit = async (e) => {
        e.preventDefault();
        const body = {
          name: $('ue-name').value, phone: $('ue-phone').value, limit: $('ue-limit').value, note: $('ue-note').value,
        };
        if (account) body.active = $('ue-active').checked;
        $('ue-save').disabled = true;
        try {
          const res = account
            ? await withOwner(`/api/pos/credit/${account.id}`, 'PATCH', body)
            : await withOwner('/api/pos/credit', 'POST', body);
          if (res) finish(res.account);
        } catch (err) {
          $('ue-err').textContent = errorText(err);
          $('ue-err').hidden = false;
        } finally {
          $('ue-save').disabled = false;
        }
      };
      $('ue-cancel').onclick = () => finish(null);
      dlg.onclose = () => finish(null);
      dlg.showModal();
      $('ue-name').focus();
    });
  }

  /* ---------------------------- the list ---------------------------- */

  function renderList() {
    const q = $('utang-search').value.trim().toLowerCase();
    const shown = S.accounts.filter((a) => !q || a.name.toLowerCase().includes(q));
    const owed = S.accounts.reduce((n, a) => n + Math.max(0, a.balance_cents), 0);
    $('utang-total').textContent = S.accounts.length ? `Owed to the shop in all: ${moneyC(owed)}` : '';
    $('utang-empty').hidden = S.accounts.length > 0;
    $('utang-list').replaceChildren(...shown.map((a) => {
      const li = document.createElement('li');
      li.className = `tab${a.active ? '' : ' tab--off'}`;
      li.dataset.id = String(a.id);
      const main = document.createElement('div');
      main.className = 'tab__main';
      const title = document.createElement('span');
      title.className = 'tab__title';
      title.textContent = a.name;
      const meta = document.createElement('span');
      meta.className = 'tab__meta';
      meta.textContent = [
        a.active ? '' : 'Off the list',
        a.limit_cents === null ? 'No limit' : `Limit ${moneyC(a.limit_cents)}`,
        a.phone,
      ].filter(Boolean).join(' · ');
      main.append(title, meta);
      const total = document.createElement('span');
      total.className = 'tab__total';
      total.textContent = a.balance_cents > 0 ? moneyC(a.balance_cents) : 'Paid up';
      const actions = document.createElement('div');
      actions.className = 'tab__actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn btn--primary btn--sm';
      open.dataset.open = '';
      open.textContent = 'Open';
      actions.append(open);
      li.append(main, total, actions);
      return li;
    }));
  }

  async function showList() {
    $('utang-account-view').hidden = true;
    $('utang-list-view').hidden = false;
    $('utang-title').textContent = 'Utang';
    await load();
    renderList();
    if (!$('utang-dialog').open) $('utang-dialog').showModal();
  }

  /* ---------------------------- one customer ---------------------------- */

  const KIND = { charge: 'Utang', refund: 'Taken off', collection: 'Paid back' };

  function historyRows() {
    let running = 0;
    return S.history.map((h) => {
      running += h.kind === 'charge' ? h.amount_cents : -h.amount_cents;
      return { ...h, running };
    });
  }

  function renderAccount() {
    const a = S.account;
    $('utang-title').textContent = 'Utang';
    $('utang-name').textContent = a.name;
    $('utang-meta').textContent = [
      a.active ? '' : 'Off the list: cannot take more utang',
      a.limit_cents === null ? 'No limit' : `Limit ${moneyC(a.limit_cents)}`,
      a.phone, a.note,
    ].filter(Boolean).join(' · ');
    $('utang-owes').textContent = a.balance_cents > 0 ? `Owes ${moneyC(a.balance_cents)}`
      : a.balance_cents < 0 ? `Paid ${moneyC(-a.balance_cents)} more than they owe` : 'Owes nothing';
    $('utang-edit').hidden = !staffGate.can('manage_credit');
    // Paying back: any method but utang itself; cash needs an open shift.
    const methods = PAY.methods.filter((m) => !m.credit);
    $('collect-method').replaceChildren(...methods.map((m) => {
      const o = new Option(m.label, m.id);
      o.disabled = !!(m.drawer && !PAY.shift);
      return o;
    }));
    $('collect-method').value = PAY.shift ? 'cash' : (methods.find((m) => !m.drawer) || {}).id;
    $('collect-amount').value = a.balance_cents > 0 ? (a.balance_cents / 100).toFixed(2) : '';
    $('collect-tendered').value = '';
    $('collect-ref').value = '';
    $('collect-err').hidden = true;
    $('utang-collect').hidden = a.balance_cents <= 0 || !staffGate.can('collect_credit');
    collectFields();

    const rows = historyRows().reverse(); // newest first
    $('utang-history').replaceChildren(...(rows.length ? rows.map((h) => {
      const li = document.createElement('li');
      li.className = `uh uh--${h.kind}`;
      const what = document.createElement('span');
      what.className = 'uh__what';
      what.textContent = `${KIND[h.kind]}${h.order_id ? ` · order #${h.order_id}` : ''}${h.label ? ` · ${h.label}` : ''}${h.reference ? ` ${h.reference}` : ''}`;
      const meta = document.createElement('span');
      meta.className = 'uh__meta';
      meta.textContent = `${manilaTime(h.at)} · ${h.staff}${h.reason ? ` · ${h.reason}` : ''} · then owed ${moneyC(h.running)}`;
      const amount = document.createElement('span');
      amount.className = 'uh__amount';
      amount.textContent = `${h.kind === 'charge' ? '+' : '−'}${moneyC(h.amount_cents)}`;
      li.append(what, amount, meta);
      if (h.kind === 'collection') {
        const actions = document.createElement('span');
        actions.className = 'uh__actions';
        const slip = document.createElement('button');
        slip.type = 'button';
        slip.className = 'link';
        slip.dataset.slip = String(h.id);
        slip.textContent = 'Print slip';
        actions.append(slip);
        if (staffGate.can('manage_shift')) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'link link--danger';
          del.dataset.uncollect = String(h.id);
          del.textContent = 'Delete…';
          actions.append(del);
        }
        li.append(actions);
      }
      return li;
    }) : [Object.assign(document.createElement('li'), { className: 'uh uh--none', textContent: 'Nothing yet.' })]));
  }

  async function openAccount(id) {
    const [data] = await Promise.all([staffGate.call(`/api/pos/credit/${id}`), loadShift()]);
    S.account = data.account;
    S.history = data.history;
    S.key = newKey();
    $('utang-list-view').hidden = true;
    $('utang-account-view').hidden = false;
    renderAccount();
    if (!$('utang-dialog').open) $('utang-dialog').showModal();
  }

  function collectFields() {
    const m = PAY.methods.find((x) => x.id === $('collect-method').value) || {};
    $('collect-tender-box').hidden = !m.drawer;
    $('collect-ref-box').hidden = !m.reference;
    $('collect-ref-box').querySelector('label').textContent = m.id === 'other' ? 'What was it? (e.g. bank transfer)' : 'Reference number';
    const amount = centsOf($('collect-amount').value);
    const tendered = centsOf($('collect-tendered').value);
    $('collect-change').textContent = m.drawer && tendered
      ? (tendered >= amount ? `Change: ${moneyC(tendered - amount)}` : `Short by ${moneyC(amount - tendered)}`) : '';
  }

  async function submitCollect(e) {
    e.preventDefault();
    const m = PAY.methods.find((x) => x.id === $('collect-method').value);
    if (!m) return;
    const body = { request_key: S.key, method: m.id, amount: $('collect-amount').value };
    if (m.drawer) body.tendered = $('collect-tendered').value || $('collect-amount').value;
    if (m.reference) body.reference = $('collect-ref').value;
    $('collect-submit').disabled = true;
    $('collect-err').hidden = true;
    try {
      const res = await withOwner(`/api/pos/credit/${S.account.id}/collect`, 'POST', body);
      if (!res) return;
      toast(`${moneyC(res.collection.amount_cents)} paid back.${res.change_cents ? ` Change: ${moneyC(res.change_cents)}.` : ''}`);
      loadShift().catch(() => {});
      await openAccount(S.account.id);
      printCollection(res).catch((err) => toast(err.message, 'error'));
    } catch (err) {
      if (err.data && err.data.code === 'no_shift') {
        toast('Open a shift first to take cash.', 'error');
        return;
      }
      // Only a dropped connection keeps the key: the payment may have gone through.
      if (!err.offline) S.key = newKey();
      $('collect-err').textContent = err.offline ? 'No connection. The payment was not recorded; try again.' : errorText(err);
      $('collect-err').hidden = false;
    } finally {
      $('collect-submit').disabled = false;
    }
  }

  async function deleteCollection(id) {
    const why = await ask({ title: 'Delete this payment?', lead: 'What they owe goes back up. It comes out of the drawer if it was cash. This is kept in the audit log.', label: 'Why', ok: 'Delete', danger: true });
    if (why === null) return;
    try {
      const res = await withOwner(`/api/pos/credit/collections/${id}/delete`, 'POST', { why });
      if (!res) return;
      toast('Deleted.');
      loadShift().catch(() => {});
      await openAccount(S.account.id);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  /* ---------------------------- printing ---------------------------- */

  function slipHead(s, title) {
    return `
      <p class="slip__title">${esc(s.receipt_shop_name)}</p>
      ${[s.receipt_address, s.receipt_contact].filter(Boolean).map((x) => `<p class="slip__center">${esc(x)}</p>`).join('')}
      <p class="slip__big">${esc(title)}</p>`;
  }

  /** The slip for one payment back: paid, change, and what is still owed. */
  async function printCollection(res) {
    const s = await receiptSettings();
    const money = (c) => slipMoney(c, s.receipt_currency);
    const row = (label, cents, cls = '') => `<div class="${cls}"><span>${esc(label)}</span><span>${money(cents)}</span></div>`;
    const c = res.collection;
    printSlip(`
      ${slipHead(s, 'UTANG PAYMENT')}
      <p class="slip__meta">${esc(manilaTime(c.at))}<br>Customer: ${esc(res.account.name)}<br>Received by: ${esc(c.staff)}</p>
      <div class="slip__rule"></div>
      ${row(`Paid (${c.label}${c.reference ? ` ${c.reference}` : ''})`, c.amount_cents, 'is-total')}
      ${c.tendered_cents !== null && c.tendered_cents !== c.amount_cents ? row('Cash tendered', c.tendered_cents) : ''}
      ${c.change_cents ? row('Change', c.change_cents) : ''}
      <div class="slip__rule"></div>
      ${row('Still owes', Math.max(0, res.balance_after_cents), 'is-strong')}
      <p class="slip__notice">This is not a sales receipt.</p>`, s.receipt_width);
  }

  /** Everything charged and paid back, with what is owed now. */
  async function printStatement() {
    const s = await receiptSettings();
    const money = (c) => slipMoney(c, s.receipt_currency);
    const a = S.account;
    const rows = historyRows().map((h) => `
      <div class="slip__line"><span>${esc(manilaTime(h.at))} ${esc(KIND[h.kind])}${h.order_id ? ` #${h.order_id}` : ''}</span>
        <span>${h.kind === 'charge' ? '' : '-'}${money(h.amount_cents)}</span></div>`).join('');
    printSlip(`
      ${slipHead(s, 'UTANG STATEMENT')}
      <p class="slip__meta">${esc(a.name)}<br>As of ${esc(manilaTime(new Date().toISOString().slice(0, 19).replace('T', ' ')))}</p>
      <div class="slip__rule"></div>
      ${rows || '<p class="slip__center">Nothing yet.</p>'}
      <div class="slip__rule"></div>
      <div class="is-total"><span>Owes now</span><span>${money(Math.max(0, a.balance_cents))}</span></div>`, s.receipt_width);
  }

  /* ---------------------------- events ---------------------------- */

  function bind() {
    $('utang-btn').addEventListener('click', () => showList().catch((e) => toast(e.message, 'error')));
    $('utang-close').addEventListener('click', () => $('utang-dialog').close());
    $('utang-search').addEventListener('input', renderList);
    $('utang-back').addEventListener('click', () => showList().catch((e) => toast(e.message, 'error')));
    $('utang-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (row && e.target.closest('[data-open]')) openAccount(Number(row.dataset.id)).catch((err) => toast(err.message, 'error'));
    });
    $('utang-add').addEventListener('click', async () => {
      const a = await editAccount(null);
      if (a) { toast(`${a.name} is on the Utang list.`); await showList(); }
    });
    $('utang-edit').addEventListener('click', async () => {
      const a = await editAccount(S.account);
      if (a) { toast('Saved.'); await openAccount(a.id); }
    });
    $('utang-collect').addEventListener('submit', submitCollect);
    $('collect-method').addEventListener('change', collectFields);
    $('collect-amount').addEventListener('input', collectFields);
    $('collect-tendered').addEventListener('input', collectFields);
    $('utang-statement').addEventListener('click', () => printStatement().catch((e) => toast(e.message, 'error')));
    $('utang-history').addEventListener('click', async (e) => {
      const slip = e.target.closest('[data-slip]');
      if (slip) {
        try {
          const res = await staffGate.call(`/api/pos/credit/collections/${slip.dataset.slip}`);
          await printCollection({ ...res, balance_after_cents: res.balance_after_cents });
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      const del = e.target.closest('[data-uncollect]');
      if (del) deleteCollection(Number(del.dataset.uncollect));
    });
    // The pay screen.
    $('utang-account').addEventListener('change', pickerInfo);
    $('utang-new').addEventListener('click', async () => {
      const a = await editAccount(null);
      if (a) await fillPicker(a.id);
    });
    staffGate.onChange((s) => { $('utang-btn').hidden = !(s && can()); });
  }

  bind();
  return { fillPicker, editAccount, showList };
})();
