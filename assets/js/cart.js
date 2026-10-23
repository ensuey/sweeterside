/* Sweeter Side — cart and checkout (delivery, pick-up or dine-in).
   Adds an "Add" button to every card, keeps the cart in this browser, and
   posts the order to the server. The server reprices everything; the totals
   shown here are only what the customer sees before confirming. */
(function () {
  'use strict';

  var STORAGE_KEY = 'sweeterside-cart-v1';
  var TYPE_KEY = 'sweeterside-order-type';
  var VOUCHER_KEY = 'sweeterside-voucher';
  var MAX_QTY = 50;
  var SLOT_MINUTES = 15;

  var dialog = document.getElementById('cart');
  if (!dialog || typeof dialog.showModal !== 'function' || !window.fetch) return;
  // While the shop is closed the menu is for browsing only: no Add buttons and
  // no cart. A saved cart is left alone for when the shop opens again.
  if (document.body.dataset.shopOpen === '0') return;

  var $ = function (id) { return document.getElementById(id); };
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card[data-id]'));
  var form = $('checkout');
  var view = $('cart-view');
  var done = $('cart-done');
  var submitBtn = $('checkout-submit');

  // Everything the cart knows about the menu comes from the rendered cards.
  // Sold-out cards are left out, so they cannot be added and a saved cart
  // holding one has it removed. `max` is how many can be ordered today.
  var catalog = {};
  cards.forEach(function (card) {
    if (card.hasAttribute('data-soldout')) return;
    var remaining = card.dataset.remaining;
    catalog[card.dataset.id] = {
      name: card.dataset.name,
      price: Number(card.dataset.price),
      max: remaining === undefined ? MAX_QTY : Math.min(MAX_QTY, Number(remaining)),
    };
  });
  var deliveryFee = Number(document.body.dataset.deliveryFee) || 0;
  // The order types turned on in the admin, e.g. "delivery pickup dinein".
  var enabledTypes = (document.body.dataset.orderTypes || '').split(' ').filter(Boolean);
  var pickupOpen = toMinutes(document.body.dataset.pickupOpen);
  var pickupClose = toMinutes(document.body.dataset.pickupClose);

  var lines = []; // [{ id: '12', qty: 2 }], in the order they were added
  var voucher = null; // { code, label, discount } once the server accepts a code
  var type = null; // 'delivery' | 'pickup' | 'dinein', or null when none is open
  var sending = false;
  var shopClosed = false; // set if the shop closes while this page is open

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
  // Only delivery pays the fee; pick-up and dine-in pay at the counter.
  function fee() { return type === 'delivery' ? deliveryFee : 0; }
  // A voucher comes off the items only, never the delivery fee.
  function discount() { return voucher ? Math.min(voucher.discount, subtotal()) : 0; }
  function total() { return subtotal() - discount() + fee(); }

  /* ---------------------------- pick-up times ---------------------------- */

  function toMinutes(hhmm) {
    var m = /^(\d\d):(\d\d)$/.exec(hhmm || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Pick-up is in the shop's time zone. The Philippines has no daylight
  // saving, so Manila is always UTC+8, whatever the customer's phone says.
  function manilaMinutes() {
    var now = new Date();
    return (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  }

  function clockLabel(mins) {
    var h = Math.floor(mins / 60);
    return (h % 12 || 12) + ':' + pad(mins % 60) + (h < 12 ? ' AM' : ' PM');
  }

  /** Today's choices: "As soon as possible" while open, then 15-minute slots
      from at least 15 minutes from now until closing. [{ value, label }] */
  function pickupSlots() {
    if (pickupOpen === null || pickupClose === null) return [];
    var now = manilaMinutes();
    var slots = [];
    if (now >= pickupOpen && now < pickupClose) {
      slots.push({ value: 'asap', label: 'As soon as possible' });
    }
    var first = Math.max(pickupOpen, Math.ceil((now + 15) / SLOT_MINUTES) * SLOT_MINUTES);
    for (var t = first; t <= pickupClose; t += SLOT_MINUTES) {
      slots.push({ value: pad(Math.floor(t / 60)) + ':' + pad(t % 60), label: clockLabel(t) });
    }
    return slots;
  }

  /** Rebuild the pick-up select, keeping the customer's choice if it is still offered. */
  function fillPickupTimes() {
    var select = $('o-pickup');
    var previous = select.value;
    var slots = pickupSlots();
    select.textContent = '';
    slots.forEach(function (s) {
      var opt = el('option', null, s.label);
      opt.value = s.value;
      select.appendChild(opt);
    });
    if (slots.some(function (s) { return s.value === previous; })) select.value = previous;
    return slots.length > 0;
  }

  /* ---------------------------- order type ---------------------------- */

  /** Which types can be chosen right now: turned on, and pick-up only while
      there is a slot left today. */
  function availableTypes() {
    var pickupOk = fillPickupTimes();
    return enabledTypes.filter(function (t) { return t !== 'pickup' || pickupOk; });
  }

  function setType(next) {
    type = next;
    try { if (next) localStorage.setItem(TYPE_KEY, next); } catch (e) { /* ignore */ }

    Array.prototype.forEach.call(form.querySelectorAll('input[name="type"]'), function (r) {
      r.checked = r.value === next;
    });
    // Hide, and disable, every field the chosen type does not use, so the
    // browser neither shows nor submits it.
    Array.prototype.forEach.call(form.querySelectorAll('[data-for]'), function (node) {
      var off = node.dataset.for.split(' ').indexOf(next) === -1;
      node.hidden = off;
      Array.prototype.forEach.call(node.querySelectorAll('input, textarea, select'), function (input) {
        input.disabled = off;
      });
    });
    clearErrors();
    render();
  }

  /** Show the types that are open, and keep or pick a sensible current one. */
  function refreshTypes() {
    var open = availableTypes();
    Array.prototype.forEach.call(form.querySelectorAll('.otype__opt'), function (opt) {
      opt.hidden = open.indexOf(opt.dataset.type) === -1;
    });
    // With a single choice there is nothing to ask.
    $('otype').hidden = open.length < 2;

    var note = '';
    if (enabledTypes.indexOf('pickup') > -1 && open.indexOf('pickup') === -1) {
      note = 'Pick-up is closed for today.';
    }
    $('otype-note').textContent = note;
    $('otype-note').hidden = !note;

    var saved = null;
    try { saved = localStorage.getItem(TYPE_KEY); } catch (e) { saved = null; }
    var next = open.indexOf(type) > -1 ? type
      : open.indexOf(saved) > -1 ? saved
      : open[0] || null;
    setType(next);
  }

  function find(id) {
    for (var i = 0; i < lines.length; i++) if (lines[i].id === id) return lines[i];
    return null;
  }

  /* Storage can be missing or blocked (private mode); the cart then simply
     lasts until the page is closed. */
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(lines)); } catch (e) { /* ignore */ }
    // A percentage voucher depends on what is in the cart.
    if (voucher) scheduleVoucherCheck();
  }

  /* ---------------------------- voucher ---------------------------- */

  function voucherError(message) {
    $('voucher-err').textContent = message || '';
    $('voucher-err').hidden = !message;
  }

  function setVoucher(next) {
    voucher = next;
    try {
      if (next) localStorage.setItem(VOUCHER_KEY, next.code);
      else localStorage.removeItem(VOUCHER_KEY);
    } catch (e) { /* ignore */ }
    render();
  }

  /** Ask the server what a code takes off this cart. It prices the cart exactly
      as it will price the order. */
  function checkVoucher(code) {
    code = String(code || '').trim();
    if (!code) { voucherError('Enter a voucher code.'); return Promise.resolve(); }
    if (!count()) return Promise.resolve();
    voucherError('');
    $('v-apply').disabled = true;
    return fetch('api/vouchers/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code,
        type: type || 'delivery',
        items: lines.map(function (l) { return { id: Number(l.id), qty: l.qty }; }),
      }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok && data.voucher) {
          setVoucher({ code: data.voucher.code, label: data.voucher.label, discount: data.discount });
          $('v-code').value = '';
          return;
        }
        // Items that went off the menu are dealt with when ordering; here only the code matters.
        var message = (data.fields && (data.fields.voucher || data.fields.items))
          || data.error || 'That code could not be checked. Please try again.';
        setVoucher(null);
        voucherError(message);
      });
    }).catch(function () {
      voucherError('Could not reach the shop to check that code. Try again.');
    }).then(function () {
      $('v-apply').disabled = false;
    });
  }

  // Re-check once the customer stops changing the cart, not on every tap.
  var voucherTimer = null;
  function scheduleVoucherCheck() {
    clearTimeout(voucherTimer);
    voucherTimer = setTimeout(function () {
      if (voucher && count()) checkVoucher(voucher.code);
    }, 400);
  }

  function load() {
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { saved = []; }
    if (!Array.isArray(saved)) saved = [];

    var dropped = 0;
    saved.forEach(function (l) {
      var id = String(l && l.id);
      if (!catalog[id]) { dropped++; return; }
      var qty = Math.min(catalog[id].max, Math.floor(Number(l && l.qty)));
      if (qty > 0 && !find(id)) lines.push({ id: id, qty: qty });
    });
    if (dropped) {
      notice(plural(dropped, 'item') + ' in your saved cart ' +
        (dropped === 1 ? 'is' : 'are') + ' sold out or no longer on the menu and ' +
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
    if (line && line.qty >= catalog[id].max) {
      live.textContent = '';
      notice(catalog[id].max < MAX_QTY
        ? 'That is all the ' + catalog[id].name + ' we have left today.'
        : 'Order at most ' + MAX_QTY + ' of any one item.');
      return;
    }
    if (line) line.qty += 1;
    else lines.push({ id: id, qty: 1 });
    save();
    render();
    live.textContent = catalog[id].name + ' added. ' + plural(count(), 'item') + ' in your cart.';
  }

  function setQty(id, qty) {
    var line = find(id);
    if (!line) return;
    if (qty <= 0) lines.splice(lines.indexOf(line), 1);
    else line.qty = Math.min(catalog[id].max, qty);
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
    plus.disabled = line.qty >= item.max;
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
    // No type open (all turned off, or only pick-up and it is past closing).
    $('cart-closed').hidden = n === 0 || (type !== null && !shopClosed);
    form.hidden = n === 0 || type === null || shopClosed;

    $('cart-subtotal').textContent = money(subtotal());
    $('voucher').hidden = n === 0 || type === null || shopClosed;
    $('voucher-entry').hidden = !!voucher;
    $('voucher-applied').hidden = !voucher;
    $('cart-discount-row').hidden = !voucher;
    if (voucher) {
      $('voucher-label').textContent = voucher.code + ' · ' + voucher.label;
      $('cart-voucher-code').textContent = voucher.code;
      $('cart-discount').textContent = '−' + money(discount());
    }
    $('cart-fee-row').hidden = type !== 'delivery';
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
      // The order type is a group of radios, which has no single element to mark.
      if (input && input.setAttribute) {
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
      // Grey the card as the server would now render it.
      var card = document.querySelector('.card[data-id="' + id + '"]');
      if (card) {
        card.classList.add('card--soldout');
        card.setAttribute('data-soldout', '');
        var btn = card.querySelector('[data-add]');
        if (btn) btn.hidden = true;
      }
    });
    // Fewer left today than the cart held: take what is left.
    Object.keys(quote.limits || {}).forEach(function (id) {
      if (!catalog[id]) return;
      catalog[id].max = Math.min(catalog[id].max, quote.limits[id]);
      var line = find(id);
      if (line) line.qty = Math.min(line.qty, catalog[id].max);
    });
    // Other types are quoted with no fee, which says nothing about delivery's.
    if (type === 'delivery' && typeof quote.delivery_fee === 'number') deliveryFee = quote.delivery_fee;
    // The server's view of the voucher: a new discount, or null when the code
    // stopped working (expired or turned off). The error message says which.
    if ('voucher' in quote && voucher) {
      if (quote.voucher) voucher = { code: quote.voucher.code, label: quote.voucher.label, discount: quote.voucher.discount };
      else setVoucher(null);
    }
    save();
    render();
  }

  /* Every field is required. The server checks all of this too; checking here
     saves a round trip and points the customer at what is missing. */
  function checkFields() {
    var errors = {};
    var name = form.elements.name.value.trim();
    if (!name) errors.name = 'Enter your full name.';

    if (type !== 'dinein') {
      var phoneDigits = form.elements.phone.value.replace(/\D/g, '');
      if (!phoneDigits) errors.phone = 'Enter a phone number we can call.';
      else if (phoneDigits.length < 7 || phoneDigits.length > 15) errors.phone = 'That phone number does not look right.';
    }

    if (type === 'delivery') {
      var address = form.elements.address.value.trim();
      var cashRaw = form.elements.cash.value.trim();
      var cash = Number(cashRaw);
      if (!address) errors.address = 'Enter the delivery address.';
      if (!cashRaw) errors.cash = 'Enter how much cash you will pay with.';
      else if (!isFinite(cash) || cash < 0 || Math.floor(cash) !== cash) errors.cash = 'Enter the cash as a whole number of pesos.';
      else if (cash < total()) errors.cash = 'The total is ' + money(total()) + ', so the cash must be at least that.';
    }

    if (type === 'pickup' && !form.elements.pickup_at.value) {
      errors.pickup_at = 'Choose when you will pick up your order.';
    }
    if (type === 'dinein' && !form.elements.table_no.value.trim()) {
      errors.table_no = 'Enter your table number.';
    }
    return errors;
  }

  function showDone(order) {
    var counter = order.order_type !== 'delivery';
    $('done-id').textContent = '#' + order.id;
    $('done-total').textContent = money(order.total);
    $('done-discount-row').hidden = !order.discount;
    $('done-voucher-code').textContent = order.voucher_code || '';
    $('done-discount').textContent = '−' + money(order.discount || 0);
    $('done-total-label').textContent = counter ? 'Total to pay at the counter' : 'Total to pay';
    $('done-cash-row').hidden = counter;
    $('done-change-row').hidden = counter;
    $('done-cash').textContent = money(order.cash);
    $('done-change').textContent = order.change_due === 0 ? 'None (exact amount)' : money(order.change_due);

    var next;
    if (order.order_type === 'pickup') {
      next = order.pickup_at === 'asap'
        ? 'Pick it up as soon as it is ready. Dachel will call you when it is.'
        : 'Pick it up at ' + clockLabel(toMinutes(order.pickup_at)) + ' today.';
    } else if (order.order_type === 'dinein') {
      next = 'We will bring it to table ' + order.table_no + '.';
    } else {
      next = 'Dachel will call you to confirm.';
    }
    $('done-next').textContent = next;

    view.hidden = true;
    done.hidden = false;
    $('done-title').focus();
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

    // Fields the type does not use go as empty strings; the server ignores them.
    var payload = {
      type: type,
      name: form.elements.name.value,
      phone: type === 'dinein' ? '' : form.elements.phone.value,
      address: type === 'delivery' ? form.elements.address.value : '',
      cash: type === 'delivery' ? form.elements.cash.value.trim() : '',
      table_no: type === 'dinein' ? form.elements.table_no.value : '',
      pickup_at: type === 'pickup' ? form.elements.pickup_at.value : '',
      voucher: voucher ? voucher.code : '',
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
        setVoucher(null); // a code is used once per order; the next one starts fresh
        save();
        form.reset();
        setType(type); // reset() unchecked the type; keep it for next time
        showDone(r.data.order);
        return;
      }
      if (r.status === 422 && r.data.fields) {
        formError(r.data.error || 'Please check the highlighted fields.');
        showErrors(r.data.fields);
        return;
      }
      // The shop closed while this page was open: stop taking the order, keep the cart.
      if (r.status === 409 && r.data.closed) {
        shopClosed = true;
        $('cart-closed').textContent = r.data.error;
        render();
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
    refreshTypes(); // the page may have been open a while: recheck pick-up times
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

  $('v-apply').addEventListener('click', function () { checkVoucher($('v-code').value); });
  $('v-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); checkVoucher($('v-code').value); }
  });
  $('v-code').addEventListener('input', function () { voucherError(''); });
  $('v-remove').addEventListener('click', function () {
    setVoucher(null);
    voucherError('');
    $('v-code').focus();
  });

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
  form.addEventListener('change', function (e) {
    if (e.target.name === 'type') setType(e.target.value);
  });

  // Clear a field's error as soon as the customer starts fixing it.
  form.addEventListener('input', function (e) {
    var name = e.target.name;
    if (!name || !e.target.hasAttribute('aria-invalid')) return;
    e.target.removeAttribute('aria-invalid');
    var p = form.querySelector('[data-err="' + name + '"]');
    if (p) { p.hidden = true; p.textContent = ''; }
  });

  load();
  refreshTypes();

  // A code applied before a reload is checked again; it may have expired.
  var savedCode = null;
  try { savedCode = localStorage.getItem(VOUCHER_KEY); } catch (e) { savedCode = null; }
  if (savedCode && count()) checkVoucher(savedCode);
})();
