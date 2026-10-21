/* Sweeter Side — cart and delivery checkout.
   Adds an "Add" button to every card, keeps the cart in this browser, and
   posts the order to the server. The server reprices everything; the totals
   shown here are only what the customer sees before confirming. */
(function () {
  'use strict';

  var STORAGE_KEY = 'sweeterside-cart-v1';
  var MAX_QTY = 50;

  var dialog = document.getElementById('cart');
  if (!dialog || typeof dialog.showModal !== 'function' || !window.fetch) return;

  var $ = function (id) { return document.getElementById(id); };
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card[data-id]'));
  var form = $('checkout');
  var view = $('cart-view');
  var done = $('cart-done');
  var submitBtn = $('checkout-submit');

  // Everything the cart knows about the menu comes from the rendered cards.
  var catalog = {};
  cards.forEach(function (card) {
    catalog[card.dataset.id] = { name: card.dataset.name, price: Number(card.dataset.price) };
  });
  var deliveryFee = Number(document.body.dataset.deliveryFee) || 0;

  var lines = []; // [{ id: '12', qty: 2 }], in the order they were added
  var sending = false;

  // Announces cart changes to screen readers without moving focus.
  var live = document.createElement('p');
  live.className = 'vh';
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);

  document.documentElement.classList.add('has-cart');

  /* ---------------------------- helpers ---------------------------- */

  function money(n) { return 'Php ' + Number(n).toLocaleString('en-US'); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function count() {
    return lines.reduce(function (sum, l) { return sum + l.qty; }, 0);
  }
  function subtotal() {
    return lines.reduce(function (sum, l) { return sum + catalog[l.id].price * l.qty; }, 0);
  }
  function total() { return subtotal() + deliveryFee; }

  function find(id) {
    for (var i = 0; i < lines.length; i++) if (lines[i].id === id) return lines[i];
    return null;
  }

  /* Storage can be missing or blocked (private mode); the cart then simply
     lasts until the page is closed. */
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(lines)); } catch (e) { /* ignore */ }
  }

  function load() {
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { saved = []; }
    if (!Array.isArray(saved)) saved = [];

    var dropped = 0;
    saved.forEach(function (l) {
      var id = String(l && l.id);
      var qty = Math.min(MAX_QTY, Math.floor(Number(l && l.qty)));
      if (!catalog[id]) { dropped++; return; }
      if (qty > 0 && !find(id)) lines.push({ id: id, qty: qty });
    });
    if (dropped) {
      notice(plural(dropped, 'item') + ' in your saved cart ' +
        (dropped === 1 ? 'is' : 'are') + ' no longer on the menu and ' +
        (dropped === 1 ? 'was' : 'were') + ' removed.');
      save();
    }
  }

  function notice(message) {
    var el = $('cart-notice');
    el.textContent = message || '';
    el.hidden = !message;
  }

  /* ---------------------------- cart actions ---------------------------- */

  function add(id) {
    if (!catalog[id]) return;
    var line = find(id);
    if (line) line.qty = Math.min(MAX_QTY, line.qty + 1);
    else lines.push({ id: id, qty: 1 });
    save();
    render();
    live.textContent = catalog[id].name + ' added. ' + plural(count(), 'item') + ' in your cart.';
  }

  function setQty(id, qty) {
    var line = find(id);
    if (!line) return;
    if (qty <= 0) lines.splice(lines.indexOf(line), 1);
    else line.qty = Math.min(MAX_QTY, qty);
    save();
    render();
  }

  /* ---------------------------- rendering ---------------------------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function lineNode(line) {
    var item = catalog[line.id];
    var li = el('li', 'cline');
    li.dataset.id = line.id;

    var main = el('div', 'cline__main');
    main.appendChild(el('span', 'cline__name', item.name));
    main.appendChild(el('span', 'cline__each', money(item.price) + ' each'));

    var stepper = el('div', 'stepper');
    var minus = el('button', 'stepper__btn', line.qty === 1 ? '×' : '−');
    minus.type = 'button';
    minus.dataset.step = '-1';
    minus.setAttribute('aria-label', line.qty === 1
      ? 'Remove ' + item.name : 'One less ' + item.name);
    var qty = el('span', 'stepper__n', String(line.qty));
    qty.setAttribute('aria-label', line.qty + ' × ' + item.name);
    var plus = el('button', 'stepper__btn', '+');
    plus.type = 'button';
    plus.dataset.step = '1';
    plus.disabled = line.qty >= MAX_QTY;
    plus.setAttribute('aria-label', 'One more ' + item.name);
    stepper.appendChild(minus);
    stepper.appendChild(qty);
    stepper.appendChild(plus);

    li.appendChild(main);
    li.appendChild(stepper);
    li.appendChild(el('span', 'cline__total', money(item.price * line.qty)));
    return li;
  }

  function render() {
    var n = count();

    // Bar at the bottom of the page.
    $('cartbar').hidden = n === 0;
    $('cartbar-n').textContent = plural(n, 'item');
    $('cartbar-total').textContent = money(subtotal());
    document.body.classList.toggle('cart-open-bar', n > 0);

    // Dialog contents.
    var list = $('cart-lines');
    list.textContent = '';
    lines.forEach(function (l) { list.appendChild(lineNode(l)); });

    $('cart-empty').hidden = n > 0;
    $('cart-sum').hidden = n === 0;
    form.hidden = n === 0;

    $('cart-subtotal').textContent = money(subtotal());
    $('cart-fee').textContent = deliveryFee === 0 ? 'Free' : money(deliveryFee);
    $('cart-total').textContent = money(total());
    submitBtn.textContent = sending ? 'Placing order…' : 'Place order · ' + money(total());

    renderChange();
  }

  function renderChange() {
    var out = $('o-change');
    var raw = $('o-cash').value.trim();
    out.classList.remove('is-short');
    if (raw === '' || !count()) { out.textContent = ''; return; }

    var cash = Number(raw);
    var due = total();
    if (!isFinite(cash)) {
      out.textContent = '';
    } else if (cash < due) {
      out.textContent = 'That is ' + money(due - cash) + ' short of the total.';
      out.classList.add('is-short');
    } else if (cash === due) {
      out.textContent = 'Exact amount. No change needed.';
    } else {
      out.textContent = 'Your change: ' + money(cash - due);
    }
  }

  /* ---------------------------- checkout ---------------------------- */

  function clearErrors() {
    Array.prototype.forEach.call(form.querySelectorAll('[data-err]'), function (p) {
      p.hidden = true; p.textContent = '';
    });
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (input) {
      input.removeAttribute('aria-invalid');
    });
    $('cart-error').hidden = true;
  }

  function showErrors(fields) {
    var first = null;
    Object.keys(fields || {}).forEach(function (name) {
      var p = form.querySelector('[data-err="' + name + '"]');
      if (p) { p.textContent = fields[name]; p.hidden = false; }
      var input = form.elements[name];
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        if (!first) first = input;
      }
    });
    if (first) first.focus();
  }

  function formError(message) {
    var box = $('cart-error');
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
  }

  /* The server refused because prices, the fee or the menu changed: take its
     numbers, update the cart, and let the customer look before resubmitting. */
  function applyQuote(quote) {
    (quote.items || []).forEach(function (i) {
      var id = String(i.id);
      if (catalog[id]) catalog[id].price = i.price;
    });
    (quote.unavailable || []).forEach(function (id) {
      id = String(id);
      var line = find(id);
      if (line) lines.splice(lines.indexOf(line), 1);
      delete catalog[id];
    });
    if (typeof quote.delivery_fee === 'number') deliveryFee = quote.delivery_fee;
    save();
    render();
  }

  function showDone(order) {
    $('done-id').textContent = '#' + order.id;
    $('done-total').textContent = money(order.total);
    $('done-cash').textContent = money(order.cash);
    $('done-change').textContent = order.change_due === 0 ? 'None (exact amount)' : money(order.change_due);
    view.hidden = true;
    done.hidden = false;
    $('done-title').focus();
  }

  function submit(event) {
    event.preventDefault();
    if (sending || !count()) return;
    clearErrors();
    notice('');

    var payload = {
      name: form.elements.name.value,
      phone: form.elements.phone.value,
      address: form.elements.address.value,
      cash: form.elements.cash.value.trim(),
      items: lines.map(function (l) { return { id: Number(l.id), qty: l.qty }; }),
      expected_total: total(),
    };

    sending = true;
    submitBtn.disabled = true;
    render();

    fetch('api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    }).then(function (r) {
      if (r.ok && r.data.order) {
        lines = [];
        save();
        form.reset();
        render();
        showDone(r.data.order);
        return;
      }
      if (r.status === 422 && r.data.fields) {
        formError(r.data.error || 'Please check the highlighted fields.');
        showErrors(r.data.fields);
        return;
      }
      if (r.status === 409 && r.data.quote) {
        applyQuote(r.data.quote);
        if (count()) formError(r.data.error);
        else notice(r.data.error);
        return;
      }
      formError(r.data.error || 'Your order could not be placed. Please try again.');
    }).catch(function () {
      formError('Could not reach the shop. Check your connection and try again.');
    }).then(function () {
      sending = false;
      submitBtn.disabled = false;
      render();
    });
  }

  /* ---------------------------- open / close ---------------------------- */

  var opener = null;

  function open() {
    opener = document.activeElement;
    view.hidden = false;
    done.hidden = true;
    render();
    dialog.showModal();
  }

  dialog.addEventListener('close', function () {
    view.hidden = false;
    done.hidden = true;
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    opener = null;
  });

  dialog.addEventListener('click', function (e) {
    if (e.target === dialog || e.target.closest('[data-close]')) { dialog.close(); return; }

    var step = e.target.closest('[data-step]');
    if (step) {
      var id = step.closest('.cline').dataset.id;
      var line = find(id);
      if (!line) return;
      setQty(id, line.qty + Number(step.dataset.step));
      // Keep keyboard focus on the same control after the list is rebuilt.
      var again = $('cart-lines').querySelector('.cline[data-id="' + id + '"] [data-step="' + step.dataset.step + '"]');
      if (again && !again.disabled) again.focus();
      else if (!find(id)) (($('cart-lines').querySelector('[data-step]')) || dialog.querySelector('.sheet__close')).focus();
    }
  });

  /* ---------------------------- wiring ---------------------------- */

  cards.forEach(function (card) {
    var btn = card.querySelector('[data-add]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      add(card.dataset.id);
      btn.classList.add('is-added');
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.classList.remove('is-added'); }, 900);
    });
  });

  var sheet = document.getElementById('sheet');
  var sheetAdd = document.getElementById('sheet-add');
  if (sheet && sheetAdd) {
    sheetAdd.hidden = false;
    sheetAdd.addEventListener('click', function () {
      add(sheet.dataset.id);
      sheet.close();
    });
  }

  $('cart-open').addEventListener('click', open);
  form.addEventListener('submit', submit);
  $('o-cash').addEventListener('input', renderChange);

  // Clear a field's error as soon as the customer starts fixing it.
  form.addEventListener('input', function (e) {
    var name = e.target.name;
    if (!name || !e.target.hasAttribute('aria-invalid')) return;
    e.target.removeAttribute('aria-invalid');
    var p = form.querySelector('[data-err="' + name + '"]');
    if (p) { p.hidden = true; p.textContent = ''; }
  });

  load();
  render();
})();
