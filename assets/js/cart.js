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
  var messengerPage = document.body.dataset.messengerPage || '';

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

  /* Every field is required. The server checks all of this too; checking here
     saves a round trip and points the customer at what is missing. */
  function checkFields() {
    var errors = {};
    var name = form.elements.name.value.trim();
    var phoneDigits = form.elements.phone.value.replace(/\D/g, '');
    var address = form.elements.address.value.trim();
    var cashRaw = form.elements.cash.value.trim();
    var cash = Number(cashRaw);

    if (!name) errors.name = 'Enter your full name.';
    if (!phoneDigits) errors.phone = 'Enter a phone number we can call.';
    else if (phoneDigits.length < 7 || phoneDigits.length > 15) errors.phone = 'That phone number does not look right.';
    if (!address) errors.address = 'Enter the delivery address.';
    if (!cashRaw) errors.cash = 'Enter how much cash you will pay with.';
    else if (!isFinite(cash) || cash < 0 || Math.floor(cash) !== cash) errors.cash = 'Enter the cash as a whole number of pesos.';
    else if (cash < total()) errors.cash = 'The total is ' + money(total()) + ', so the cash must be at least that.';
    return errors;
  }

  /* ---------------------------- messenger ---------------------------- */

  function messengerUrl() {
    return 'https://m.me/' + encodeURIComponent(messengerPage);
  }

  /** The message the customer sends us: the order as the server recorded it. */
  function orderMessage(order, details) {
    var out = ['Hi Sweeter Side! I just placed order #' + order.id + ' on your website.', ''];
    order.items.forEach(function (l) {
      out.push(l.qty + ' × ' + l.name + ' — ' + money(l.price * l.qty));
    });
    out.push('');
    out.push('Subtotal: ' + money(order.subtotal));
    out.push('Delivery fee: ' + (order.delivery_fee === 0 ? 'Free' : money(order.delivery_fee)));
    out.push('Total: ' + money(order.total));
    out.push('Cash: ' + money(order.cash) + (order.change_due === 0
      ? ' (exact amount)' : ' (change ' + money(order.change_due) + ')'));
    out.push('');
    out.push('Name: ' + details.name.trim());
    out.push('Phone: ' + details.phone.trim());
    out.push('Address: ' + details.address.trim().replace(/\s*\n\s*/g, ', '));
    return out.join('\n');
  }

  /* Copy without the Clipboard API: needs a selectable textarea inside the
     dialog, because everything outside a modal dialog is inert. */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    done.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    done.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function msgrStatus(copied, opened) {
    var text;
    if (copied && opened) text = 'Your order is copied. In Messenger, paste it and tap Send.';
    else if (copied) text = 'Your order is copied. Tap the button above to open Messenger, then paste and send.';
    else text = 'We could not copy it automatically. Open “See the message” below, copy it, and send it to us on Messenger.';
    $('msgr-status').textContent = text;
    if (!copied) $('msgr-text').closest('details').open = true;
  }

  /* Called straight after the order is placed. Browsers allow opening a new
     tab only shortly after a tap; if this one is blocked (common on iPhone),
     the big button does the same thing on the next tap. */
  function sendToMessenger(message) {
    var win = null;
    try { win = window.open(messengerUrl(), '_blank'); } catch (e) { win = null; }
    if (win) { try { win.opener = null; } catch (e) { /* cross-origin */ } }
    return copyText(message).then(function (copied) { msgrStatus(copied, !!win); });
  }

  function showDone(order, details) {
    $('done-id').textContent = '#' + order.id;
    $('done-total').textContent = money(order.total);
    $('done-cash').textContent = money(order.cash);
    $('done-change').textContent = order.change_due === 0 ? 'None (exact amount)' : money(order.change_due);

    var hasMessenger = !!messengerPage;
    $('msgr').hidden = !hasMessenger;
    $('msgr-off').hidden = hasMessenger;
    if (hasMessenger) {
      var message = orderMessage(order, details);
      $('msgr-text').value = message;
      $('msgr-open').href = messengerUrl();
      $('msgr-status').textContent = '';
      $('msgr-text').closest('details').open = false;
    }

    view.hidden = true;
    done.hidden = false;
    $('done-title').focus();
    if (hasMessenger) sendToMessenger($('msgr-text').value);
  }

  function submit(event) {
    event.preventDefault();
    if (sending || !count()) return;
    clearErrors();
    notice('');

    var missing = checkFields();
    if (Object.keys(missing).length) {
      formError('Please fill in every field before placing your order.');
      showErrors(missing);
      return;
    }

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
        showDone(r.data.order, payload);
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

  // The link opens Messenger itself (a real tap is never blocked); copy alongside it.
  $('msgr-open').addEventListener('click', function () {
    copyText($('msgr-text').value).then(function (copied) { msgrStatus(copied, true); });
  });
  $('msgr-copy').addEventListener('click', function () {
    var ta = $('msgr-text');
    ta.focus();
    ta.select();
    copyText(ta.value).then(function (copied) {
      $('msgr-status').textContent = copied
        ? 'Copied. Paste it in Messenger and tap Send.'
        : 'Select the text above and copy it.';
    });
  });

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
