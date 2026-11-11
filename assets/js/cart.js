/* Sweeter Side — cart and checkout (delivery, pick-up or dine-in).
   Adds an "Add" button to every card, keeps the cart in this browser, and
   posts the order to the server. The server reprices everything; the totals
   shown here are only what the customer sees before confirming. */
(function () {
  'use strict';

  var STORAGE_KEY = 'sweeterside-cart-v1'; // lines: { id, qty, opts? }
  var TYPE_KEY = 'sweeterside-order-type';
  var VOUCHER_KEY = 'sweeterside-voucher';
  var MAX_QTY = 50;
  var SLOT_MINUTES = 15;

  var dialog = document.getElementById('cart');
  if (!dialog || typeof dialog.showModal !== 'function' || !window.fetch) return;
  // While the shop is closed the menu is for browsing only: no Add buttons and
  // no cart. A saved cart is left alone for when the shop opens again.
  // Outside the hours with pre-orders on, the cart works for a later time.
  if (document.body.dataset.shopOpen === '0' && document.body.dataset.preorder !== '1') return;

  var $ = function (id) { return document.getElementById(id); };
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card[data-id]'));
  var form = $('checkout');
  var view = $('cart-view');
  var done = $('cart-done');
  var paying = $('cart-paying'); // back from GCash, while the payment is checked
  // GCash (PayMongo) is offered only while the server has it switched on.
  // 'live' for everyone; 'test' (PayMongo test keys) only for the signed-in owner.
  var gcashMode = $('pay') ? $('pay').dataset.gcash : '0';
  var gcashOn = gcashMode === 'live' || gcashMode === 'test';
  var leaving = false; // on the way to GCash's page
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
      cat: card.dataset.cat, // category slug, for suggestions
      price: Number(card.dataset.price),
      max: remaining === undefined ? MAX_QTY : Math.min(MAX_QTY, Number(remaining)),
      shot: card.querySelector('.shot'), // the card's photo, copied as the cart thumbnail
      options: readOptions(card), // { price, sale_type, sale_value, groups }, or null
    };
  });

  function readOptions(card) {
    if (!card.dataset.options) return null;
    try { return JSON.parse(card.dataset.options); } catch (e) { return null; }
  }

  /* ---------------------------- options ---------------------------- */

  // A line is one item with one set of options. The same item with other
  // options is another line.
  function keyOf(id, opts) { return opts && opts.length ? id + ':' + opts.join('.') : String(id); }

  /** Every option of an item, by id: { id, name, price, available, group }. */
  function optionMap(item) {
    var map = {};
    if (item.options) item.options.groups.forEach(function (g) {
      g.options.forEach(function (o) { map[o.id] = { id: o.id, name: o.name, price: o.price, available: o.available, group: g }; });
    });
    return map;
  }

  /** Why these options do not fit the item's groups, or '' when they do. */
  function optionProblem(item, opts) {
    var map = optionMap(item);
    for (var i = 0; i < opts.length; i++) {
      if (!map[opts[i]] || !map[opts[i]].available) return 'gone';
    }
    var groups = item.options ? item.options.groups : [];
    for (var j = 0; j < groups.length; j++) {
      var g = groups[j];
      var n = opts.filter(function (id) { return map[id].group.id === g.id; }).length;
      if (n < g.min) return g.kind === 'single' || g.min === 1 ? 'Choose ' + g.name.toLowerCase() + '.'
        : 'Choose at least ' + g.min + '.';
      if (n > g.max) return g.max === 1 ? 'Choose only one.' : 'Choose at most ' + g.max + '.';
    }
    return '';
  }

  /** The same rule as the server: a sale applies to the item and its options. */
  function salePrice(price, rule) {
    if (rule.sale_type === 'percent') return Math.round(price * (100 - rule.sale_value) / 100);
    if (rule.sale_type === 'amount') return Math.max(0, price - rule.sale_value);
    return price;
  }

  /** What one unit of a line costs. */
  function unitPrice(line) {
    var item = catalog[line.id];
    if (typeof line.price === 'number') return line.price; // the server's, after a refused order
    if (!item.options) return item.price;
    var map = optionMap(item);
    var full = item.options.price + (line.opts || []).reduce(function (sum, id) { return sum + (map[id] ? map[id].price : 0); }, 0);
    return salePrice(full, item.options);
  }

  /** "Large · Extra shot, Oat milk": the options of a line, in menu order. */
  function optionsText(line) {
    var item = catalog[line.id];
    if (!item.options || !line.opts || !line.opts.length) return '';
    var parts = [];
    item.options.groups.forEach(function (g) {
      var names = g.options.filter(function (o) { return line.opts.indexOf(o.id) > -1; }).map(function (o) { return o.name; });
      if (names.length) parts.push(names.join(', '));
    });
    return parts.join(' · ');
  }

  /** Units of an item over all its lines: today's limit counts the item. */
  function itemQty(id) {
    return lines.reduce(function (sum, l) { return sum + (l.id === id ? l.qty : 0); }, 0);
  }
  // Delivery areas (fee and usual time) and the free delivery threshold, from
  // Settings. The server prices the order again; this is so the total shown
  // is the total charged.
  var deliveryInfo = { areas: [], free_min: null };
  try { deliveryInfo = JSON.parse(document.body.dataset.delivery || '{}'); } catch (e) { /* keep the empty default */ }
  var areas = deliveryInfo.areas || [];
  var freeMin = deliveryInfo.free_min || null;
  // The order types turned on in the admin, e.g. "delivery pickup dinein".
  var enabledTypes = (document.body.dataset.orderTypes || '').split(' ').filter(Boolean);
  var pickupOpen = toMinutes(document.body.dataset.pickupOpen);
  var pickupClose = toMinutes(document.body.dataset.pickupClose);

  var lines = []; // [{ id, qty, opts, key }], in the order they were added
  var voucher = null; // { code, label, discount } once the server accepts a code
  var type = null; // 'delivery' | 'pickup' | 'dinein', or null when none is open
  var sending = false;
  var shopClosed = false; // set if the shop closes while this page is open

  // Closing time came while the page was open (hours.js): stop taking the
  // order and say why. Whatever is in the cart is kept for next time.
  // Closing time came while the page was open, and pre-orders are on: as
  // soon as possible and dine-in go; a later time can still be chosen.
  document.addEventListener('shop:preorder', function () {
    refreshTypes();
  });

  document.addEventListener('shop:closed', function (e) {
    shopClosed = true;
    $('cart-closed').textContent = e.detail && e.detail.message ? e.detail.message : $('cart-closed').textContent;
    render();
  });

  // Announces cart changes to screen readers without moving focus.
  var live = document.createElement('p');
  live.className = 'vh';
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);

  document.documentElement.classList.add('has-cart');

  /* ---------------------------- helpers ---------------------------- */

  function money(n) { return '₱' + Number(n).toLocaleString('en-US'); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function count() {
    return lines.reduce(function (sum, l) { return sum + l.qty; }, 0);
  }
  function subtotal() {
    return lines.reduce(function (sum, l) { return sum + unitPrice(l) * l.qty; }, 0);
  }
  /** The area chosen: { id, name, fee, eta }, { other: true }, or null. */
  function area() {
    var v = $('o-area') ? $('o-area').value : '';
    if (v === 'other') return { other: true };
    for (var i = 0; i < areas.length; i++) if (String(areas[i].id) === v) return areas[i];
    return null;
  }
  // Free delivery: the items after the voucher come to the threshold or more
  // (not for "Other area", whose fee is still to be confirmed).
  function freeDelivery() {
    var a = area();
    return !!(freeMin && a && !a.other && a.fee > 0 && subtotal() - discount() >= freeMin);
  }
  // Only delivery pays the fee; pick-up and dine-in pay at the counter.
  function fee() {
    if (type !== 'delivery') return 0;
    var a = area();
    if (!a || a.other || freeDelivery()) return 0;
    return a.fee;
  }
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

  /* Pick-up: a day (today up to N days ahead) and a 15-minute slot within
     the hours. Delivery: as soon as possible, or a day and a 30-minute
     window. "As soon as possible" and dine-in only while open now. The
     same rules as server/schedule.js, which checks them again. */
  var WINDOW_MINUTES = 30;
  var LEAD = { pickup: 15, delivery: 30 };
  var preorderDays = Number(document.body.dataset.preorderDays) || 0;
  var switchOn = document.body.dataset.switchOpen === '1';
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Today in Manila, 'YYYY-MM-DD'. */
  function manilaToday() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
  function addDays(ymd, n) {
    var d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dayLabel(ymd) {
    var today = manilaToday();
    if (ymd === today) return 'Today';
    if (ymd === addDays(today, 1)) return 'Tomorrow';
    var d = new Date(ymd + 'T00:00:00Z');
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }
  function hhmm(t) { return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }
  function openNow() {
    var now = manilaMinutes();
    return switchOn && pickupOpen !== null && pickupClose !== null && now >= pickupOpen && now < pickupClose;
  }

  /** The start times (minutes) offered on a day. */
  function slotsOn(kind, date) {
    if (pickupOpen === null || pickupClose === null || !switchOn) return [];
    var today = manilaToday();
    if (date < today || date > addDays(today, preorderDays)) return [];
    var step = kind === 'delivery' ? WINDOW_MINUTES : SLOT_MINUTES;
    var last = kind === 'delivery' ? pickupClose - WINDOW_MINUTES : Math.min(pickupClose, 24 * 60 - SLOT_MINUTES);
    var first = pickupOpen;
    if (date === today) while (first < manilaMinutes() + LEAD[kind]) first += step;
    var out = [];
    for (var t = first; t <= last; t += step) out.push(t);
    return out;
  }

  /** The days to choose from: those with a time left, or today for ASAP. */
  function daysFor(kind) {
    var today = manilaToday();
    var out = [];
    for (var i = 0; i <= preorderDays; i++) {
      var d = addDays(today, i);
      if (slotsOn(kind, d).length || (i === 0 && openNow())) out.push(d);
    }
    return out;
  }

  function fill(select, options, keep) {
    var previous = select.value;
    select.textContent = '';
    options.forEach(function (o) {
      var opt = el('option', null, o.label);
      opt.value = o.value;
      select.appendChild(opt);
    });
    if (keep && options.some(function (o) { return o.value === previous; })) select.value = previous;
  }

  /** Rebuild a type's day and time choices, keeping the customer's if still
      offered; otherwise the first (as soon as possible, or the next time). */
  function fillWhen(kind) {
    var daySel = $(kind === 'pickup' ? 'o-pickup-date' : 'o-deliver-date');
    var timeSel = $(kind === 'pickup' ? 'o-pickup' : 'o-deliver');
    var days = daysFor(kind);
    fill(daySel, days.map(function (d) { return { value: d, label: dayLabel(d) }; }), true);
    // One day only (today): nothing to ask.
    daySel.closest('.when__part').hidden = days.length < 2;
    var date = daySel.value;
    var times = [];
    if (date === manilaToday() && openNow()) times.push({ value: 'asap', label: 'As soon as possible' });
    slotsOn(kind, date).forEach(function (t) {
      times.push({ value: hhmm(t), label: kind === 'delivery' ? windowLabel(t) : clockLabel(t) });
    });
    fill(timeSel, times, true);
    return days.length > 0;
  }

  /** "10:30–11:00 AM", or "11:30 AM–12:00 PM" across noon. */
  function windowLabel(t) {
    var a = clockLabel(t);
    var b = clockLabel(t + WINDOW_MINUTES);
    return (a.slice(-2) === b.slice(-2) ? a.slice(0, -3) : a) + '–' + b;
  }

  /** The day the order is for: limits count against it. */
  function orderDay() {
    if (type === 'pickup' && $('o-pickup').value !== 'asap' && $('o-pickup-date').value) return $('o-pickup-date').value;
    if (type === 'delivery' && $('o-deliver').value !== 'asap' && $('o-deliver-date').value) return $('o-deliver-date').value;
    return manilaToday();
  }

  /* Items with a daily limit: how many are left on each day, so "only N
     left" follows the day chosen. */
  var stockByDay = {};
  try { stockByDay = JSON.parse(document.body.dataset.stock || '{}'); } catch (e) { stockByDay = {}; }
  function applyDay() {
    var left = stockByDay[orderDay()];
    if (!left) return;
    var cut = [];
    Object.keys(catalog).forEach(function (id) {
      if (!(id in left)) return;
      catalog[id].max = Math.min(MAX_QTY, left[id]);
      for (var i = lines.length - 1; i >= 0 && itemQty(id) > catalog[id].max; i--) {
        if (lines[i].id !== id) continue;
        lines[i].qty -= Math.min(lines[i].qty, itemQty(id) - catalog[id].max);
        if (lines[i].qty === 0) lines.splice(i, 1);
        if (cut.indexOf(id) === -1) cut.push(id);
      }
    });
    if (cut.length) {
      notice(cut.length === 1
        ? 'Only ' + catalog[cut[0]].max + ' ' + catalog[cut[0]].name + ' left for that day. Your cart has been updated.'
        : 'Some items have only a few left for that day. Your cart has been updated.');
      save();
    }
  }

  /* ---------------------------- order type ---------------------------- */

  /** Which types can be chosen right now: turned on, dine-in only while
      open, and pick-up or delivery while there is a time to choose. */
  function availableTypes() {
    var ok = { pickup: fillWhen('pickup'), delivery: fillWhen('delivery'), dinein: openNow() };
    return enabledTypes.filter(function (t) { return ok[t]; });
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
    applyDay();
    render();
  }

  /** Show the types that are open, and keep or pick a sensible current one. */
  function refreshTypes() {
    var open = availableTypes();
    Array.prototype.forEach.call(form.querySelectorAll('.otype__opt[data-type]'), function (opt) {
      opt.hidden = open.indexOf(opt.dataset.type) === -1;
    });
    // With a single choice there is nothing to ask.
    $('otype').hidden = open.length < 2;

    var note = '';
    if (enabledTypes.indexOf('pickup') > -1 && open.indexOf('pickup') === -1) {
      note = 'Pick-up is closed for now.';
    }
    if (enabledTypes.indexOf('dinein') > -1 && open.indexOf('dinein') === -1 && open.length) {
      note = (note ? note + ' ' : '') + "Dine-in orders are taken while we're open.";
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

  function find(key) {
    for (var i = 0; i < lines.length; i++) if (lines[i].key === key) return lines[i];
    return null;
  }

  /* Storage can be missing or blocked (private mode); the cart then simply
     lasts until the page is closed. */
  function save() {
    var stored = lines.map(function (l) { return { id: l.id, qty: l.qty, opts: l.opts, src: l.src }; });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)); } catch (e) { /* ignore */ }
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
        delivery_area: $('o-area') ? $('o-area').value : '',
        items: lines.map(function (l) { return { id: Number(l.id), qty: l.qty, options: l.opts || [], source: l.src || '' }; }),
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
      var opts = Array.isArray(l.opts) ? l.opts.map(Number).sort(function (a, b) { return a - b; }) : [];
      // The options were changed since (or the item now has some to choose).
      if (optionProblem(catalog[id], opts)) { dropped++; return; }
      var key = keyOf(id, opts);
      var qty = Math.min(catalog[id].max - itemQty(id), Math.floor(Number(l && l.qty)));
      if (qty > 0 && !find(key)) lines.push({ id: id, qty: qty, opts: opts, key: key, src: l.src === 'suggested' ? 'suggested' : '' });
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

  function add(id, opts, src) {
    if (!catalog[id]) return;
    opts = opts || [];
    var key = keyOf(id, opts);
    var line = find(key);
    if (itemQty(id) >= catalog[id].max) {
      live.textContent = '';
      notice(catalog[id].max < MAX_QTY
        ? 'That is all the ' + catalog[id].name + ' we have left today.'
        : 'Order at most ' + MAX_QTY + ' of any one item.');
      return;
    }
    if (line) line.qty += 1;
    else lines.push({ id: id, qty: 1, opts: opts, key: key, src: src || '' });
    save();
    render();
    live.textContent = catalog[id].name + ' added. ' + plural(count(), 'item') + ' in your cart.';
    track('add_to_cart', { value: catalog[id].price, items: [{ id: id, quantity: 1 }] });
  }

  /** A tracking event (tracking.js), when a tool is on and the customer said yes. */
  function track(name, data) {
    if (window.ssTrack) window.ssTrack(name, data);
  }

  function setQty(key, qty) {
    var line = find(key);
    if (!line) return;
    if (qty <= 0) lines.splice(lines.indexOf(line), 1);
    else line.qty = Math.min(catalog[line.id].max - itemQty(line.id) + line.qty, qty);
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
    li.dataset.key = line.key;

    // A small square copy of the card's photo. The name is right beside it, so
    // the picture is decorative for screen readers.
    var thumb = el('div', 'cline__thumb');
    thumb.setAttribute('aria-hidden', 'true');
    if (item.shot) {
      var shot = item.shot.cloneNode(true);
      var pic = shot.querySelector('img');
      if (pic) pic.alt = '';
      thumb.appendChild(shot);
    }

    var main = el('div', 'cline__main');
    main.appendChild(el('span', 'cline__name', item.name));
    var chosen = optionsText(line);
    if (chosen) main.appendChild(el('span', 'cline__opts', chosen));
    main.appendChild(el('span', 'cline__each', money(unitPrice(line)) + ' each'));

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
    plus.disabled = itemQty(line.id) >= item.max;
    plus.setAttribute('aria-label', 'One more ' + item.name);
    stepper.appendChild(minus);
    stepper.appendChild(qty);
    stepper.appendChild(plus);

    li.appendChild(thumb);
    li.appendChild(main);
    li.appendChild(stepper);
    li.appendChild(el('span', 'cline__total', money(unitPrice(line) * line.qty)));
    return li;
  }

  /* ------------------------- goes well with ------------------------- */

  // Up to three per category, and a list for any order, set in the admin.
  var suggest = { any: [], by_cat: {} };
  try { suggest = JSON.parse(document.body.dataset.suggest || '{}'); } catch (e) { /* none */ }
  var SUGGEST_MAX = 3;
  var fromSuggest = false; // the item popup was opened from the strip

  /** What to suggest now: from the categories in the cart, then the list for
      any order; never what is in the cart already or cannot be ordered. */
  function suggestions() {
    var picked = [];
    var inCart = {};
    lines.forEach(function (l) { inCart[l.id] = true; });
    var lists = lines.map(function (l) { return (suggest.by_cat || {})[catalog[l.id].cat] || []; });
    lists.push(suggest.any || []);
    lists.forEach(function (ids) {
      ids.forEach(function (raw) {
        var id = String(raw);
        var item = catalog[id];
        if (picked.length >= SUGGEST_MAX || !item || inCart[id] || picked.indexOf(id) > -1) return;
        if (itemQty(id) >= item.max) return;
        picked.push(id);
      });
    });
    return picked;
  }

  function renderSuggest() {
    var box = $('cart-suggest');
    if (!box) return;
    var ids = count() ? suggestions() : [];
    var list = $('suggest-list');
    list.textContent = '';
    box.hidden = ids.length === 0;
    ids.forEach(function (id) {
      var item = catalog[id];
      var li = el('li', 'suggest__item');
      var thumb = el('div', 'cline__thumb');
      thumb.setAttribute('aria-hidden', 'true');
      if (item.shot) {
        var shot = item.shot.cloneNode(true);
        var pic = shot.querySelector('img');
        if (pic) { pic.alt = ''; pic.removeAttribute('loading'); }
        thumb.appendChild(shot);
      }
      var main = el('div', 'suggest__main');
      main.appendChild(el('span', 'suggest__name', item.name));
      // An item with options says "from": the popup asks which ones.
      var card = document.querySelector('.card[data-id="' + id + '"] .price');
      main.appendChild(el('span', 'suggest__price', item.options && card ? card.textContent.trim() : money(item.price)));
      var btn = el('button', 'suggest__add', item.options ? 'Choose' : 'Add');
      btn.type = 'button';
      btn.dataset.suggest = id;
      btn.setAttribute('aria-label', (item.options ? 'Choose options for ' : 'Add ') + item.name);
      li.appendChild(thumb);
      li.appendChild(main);
      li.appendChild(btn);
      list.appendChild(li);
    });
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
    renderSuggest();

    $('cart-empty').hidden = n > 0;
    $('cart-sum').hidden = n === 0;
    // No type open (all turned off, or only pick-up and it is past closing).
    $('cart-closed').hidden = n === 0 || (type !== null && !shopClosed);
    form.hidden = n === 0 || type === null || shopClosed;

    $('cart-subtotal').textContent = money(subtotal());
    // The code box opens only after "I have a voucher code" is ticked; once a
    // code is applied, the tick box gives way to the applied code.
    if (voucher) $('v-have').checked = true;
    $('v-have').closest('label').hidden = !!voucher;
    $('voucher-entry').hidden = !!voucher || !$('v-have').checked;
    $('voucher-applied').hidden = !voucher;
    $('cart-discount-row').hidden = !voucher;
    if (voucher) {
      $('voucher-label').textContent = voucher.code + ' · ' + voucher.label;
      $('cart-voucher-code').textContent = voucher.code;
      $('cart-discount').textContent = '−' + money(discount());
    }
    $('cart-fee-row').hidden = type !== 'delivery';
    var a = area();
    $('cart-fee').textContent = !a ? 'Choose your area' : a.other ? 'To be confirmed'
      : freeDelivery() ? 'Free' : a.fee === 0 ? 'Free' : money(a.fee);
    // "Add ₱X more for free delivery": only for an area with a fee, under the threshold.
    var short = freeMin && type === 'delivery' && a && !a.other && a.fee > 0 ? freeMin - (subtotal() - discount()) : 0;
    $('cart-free').hidden = !(short > 0);
    if (short > 0) $('cart-free').textContent = 'Add ' + money(short) + ' more for free delivery.';
    $('o-area-eta').textContent = a && a.eta ? a.eta + '.' : a && a.other ? 'We will call you with the fee before we send it.' : '';
    $('cart-total').textContent = money(total());
    renderPay();
    var gcash = payMethod() === 'gcash';
    submitBtn.textContent = sending ? (gcash ? 'Opening GCash…' : 'Placing order…')
      : (gcash ? 'Pay with GCash · ' : 'Place order · ') + money(total());

    renderChange();
  }

  /* ---------------------------- paying with GCash ---------------------------- */

  /** 'gcash' when chosen and allowed, else 'cash' (in person). */
  function payMethod() {
    if (!gcashOn || !form.elements.pay || form.elements.pay.value !== 'gcash') return 'cash';
    var a = type === 'delivery' ? area() : null;
    return a && a.other ? 'cash' : 'gcash';
  }

  /** The pay choice, and what changes with it: the cash field and the notes. */
  function renderPay() {
    $('pay').hidden = !gcashOn || type === null;
    if (!gcashOn) return;
    $('pay-cash-label').textContent = type === 'delivery' ? 'Cash on delivery' : 'Pay at the counter';
    // "Other area": the fee is agreed by phone first, so GCash waits for another time.
    var other = type === 'delivery' && area() && area().other;
    var gcashInput = form.querySelector('input[name="pay"][value="gcash"]');
    gcashInput.disabled = !!other;
    if (other && gcashInput.checked) form.querySelector('input[name="pay"][value="cash"]').checked = true;
    $('pay-note').hidden = !other;
    $('pay-note').textContent = other ? 'For "Other area" we call you with the fee first, so please pay in cash.' : '';

    var gcash = payMethod() === 'gcash';
    var cashField = $('o-cash').closest('.cfield');
    cashField.hidden = type !== 'delivery' || gcash;
    $('o-cash').disabled = cashField.hidden;
    Array.prototype.forEach.call(form.querySelectorAll('.checkout__note[data-for]'), function (note) {
      note.hidden = gcash || note.dataset.for.split(' ').indexOf(type) === -1;
    });
    $('gcash-note').hidden = !gcash;
    $('gcash-note').textContent = gcashMode === 'test'
      ? 'Test mode: only you see GCash, because you are signed in to the admin. PayMongo takes pretend payments; no real money.'
      : 'You will pay on GCash\'s page. Your order goes to the kitchen once it is paid.';
  }

  function renderChange() {
    var out = $('o-change');
    var raw = $('o-cash').value.trim();
    out.classList.remove('is-short');
    if (!count()) { out.textContent = ''; return; }
    // Left blank: the customer pays the exact amount.
    if (raw === '') { out.textContent = 'Blank means the exact amount: no change needed.'; return; }

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
      var line = find(String(i.key || i.id));
      if (line) line.price = i.price;
      else if (catalog[String(i.id)] && !catalog[String(i.id)].options) catalog[String(i.id)].price = i.price;
    });
    (quote.unavailable || []).forEach(function (id) {
      id = String(id);
      lines = lines.filter(function (l) { return l.id !== id; });
      delete catalog[id];
      // Grey the card (and its copy in Best sellers) as the server would now render it.
      Array.prototype.forEach.call(document.querySelectorAll('.card[data-id="' + id + '"]'), function (card) {
        card.classList.add('card--soldout');
        card.setAttribute('data-soldout', '');
        var btn = card.querySelector('[data-add]');
        if (btn) btn.hidden = true;
      });
    });
    // Fewer left today than the cart held: take what is left.
    Object.keys(quote.limits || {}).forEach(function (id) {
      if (!catalog[id]) return;
      catalog[id].max = Math.min(catalog[id].max, quote.limits[id]);
      // Take units off this item's lines, last first, down to what is left.
      for (var i = lines.length - 1; i >= 0 && itemQty(id) > catalog[id].max; i--) {
        if (lines[i].id !== id) continue;
        lines[i].qty -= Math.min(lines[i].qty, itemQty(id) - catalog[id].max);
        if (lines[i].qty === 0) lines.splice(i, 1);
      }
    });
    // Fees changed while the page was open: the page has to be loaded again to
    // show them, and the server has already priced the order with the new fee.
    // The server's view of the voucher: a new discount, or null when the code
    // stopped working (expired or turned off). The error message says which.
    if ('voucher' in quote && voucher) {
      if (quote.voucher) voucher = { code: quote.voucher.code, label: quote.voucher.label, discount: quote.voucher.discount };
      else setVoucher(null);
    }
    save();
    render();
  }

  /** 0917 123 4567, +63 917 123 4567 or 639171234567: the forms the server accepts. */
  function isPhMobile(raw) {
    var s = String(raw || '').trim();
    if (!/^\+?[\d\s()-]+$/.test(s)) return false;
    return /^(\+63|63|0)9\d{9}$/.test(s.replace(/[\s()-]/g, ''));
  }

  /* ---------------------------- checkout token ---------------------------- */

  /* The server only takes an order that carries a token it signed at least a
     few seconds earlier and at most two hours before. One is fetched when the
     cart opens and renewed once it gets old. */
  var token = null; // { value, at: when it arrived (this clock), minMs }
  var TOKEN_RENEW_MS = 100 * 60 * 1000;

  function fetchToken() {
    return fetch('api/checkout-token', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        token = data && data.token ? { value: data.token, at: Date.now(), minMs: data.min_ms || 3000 } : null;
        return token;
      })
      .catch(function () { return null; });
  }

  function freshToken() {
    if (token && Date.now() - token.at < TOKEN_RENEW_MS) return Promise.resolve(token);
    return fetchToken();
  }

  /** The token, once it is old enough for the server (a fast customer waits a moment). */
  function readyToken() {
    return freshToken().then(function (t) {
      if (!t) return null;
      var wait = t.minMs + 500 - (Date.now() - t.at);
      if (wait <= 0) return t;
      return new Promise(function (resolve) { setTimeout(function () { resolve(t); }, wait); });
    });
  }

  /* Every field is required. The server checks all of this too; checking here
     saves a round trip and points the customer at what is missing. */
  function checkFields() {
    var errors = {};
    var name = form.elements.name.value.trim();
    if (!name) errors.name = 'Enter your full name.';

    if (type !== 'dinein') {
      var phone = form.elements.phone.value;
      if (!phone.replace(/\D/g, '')) errors.phone = 'Enter a phone number we can call.';
      else if (!isPhMobile(phone)) errors.phone = 'Please enter a valid PH mobile number, e.g. 0917 123 4567.';
    }

    if (type === 'delivery') {
      var address = form.elements.address.value.trim();
      var landmark = form.elements.landmark.value.trim();
      var cashRaw = form.elements.cash.value.trim();
      if (!area()) errors.delivery_area = 'Choose your area, or "Other area" and we will call you with the fee.';
      var cash = Number(cashRaw);
      if (!address) errors.address = 'Enter the delivery address.';
      if (!landmark) errors.landmark = 'Add a landmark or directions, e.g. beside 7-Eleven, green gate.';
      else if (landmark.length < 5) errors.landmark = 'Tell us a little more so the rider can find you.';
      // Cash is optional: blank is the exact amount. Paying with GCash: no cash.
      if (payMethod() === 'gcash') cashRaw = '';
      if (cashRaw && (!isFinite(cash) || cash < 0 || Math.floor(cash) !== cash)) errors.cash = 'Enter the cash as a whole number of pesos.';
      else if (cashRaw && cash < total()) errors.cash = 'The total is ' + money(total()) + ', so the cash must be at least that.';
    }

    if (type === 'delivery' && !form.elements.deliver_at.value) {
      errors.deliver_at = 'Choose when you would like it delivered.';
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
    var paid = !!order.paid_online;
    $('done-total-label').textContent = paid ? 'Paid with GCash' : counter ? 'Total to pay at the counter' : 'Total to pay';
    $('done-cash-row').hidden = counter || paid;
    $('done-change-row').hidden = counter || paid;
    $('done-cash').textContent = order.change_due === 0 ? 'Exact amount' : money(order.cash);
    $('done-change').textContent = order.change_due === 0 ? 'None (exact amount)' : money(order.change_due);
    // The server's total and lines, with the order number so each tool counts it once.
    track('purchase', {
      id: 'order-' + order.id,
      value: order.total,
      items: (order.items || []).map(function (l) { return { id: l.item_id, quantity: l.qty }; }),
    });

    // What was ordered, as a short summary.
    var lines = $('done-lines');
    lines.textContent = '';
    (order.items || []).forEach(function (l) {
      var li = el('li');
      var what = el('span', 'done__what', l.qty + ' × ' + l.name);
      if (l.options_text) what.appendChild(el('span', 'cline__opts', l.options_text));
      li.appendChild(what);
      li.appendChild(el('span', 'done__line-total', money(l.price * l.qty)));
      lines.appendChild(li);
    });

    // The type of order and when.
    var when;
    var next;
    if (order.order_type === 'pickup') {
      when = order.scheduled_label ? 'Pick-up · ' + order.scheduled_label : 'Pick-up · as soon as it is ready';
      next = order.scheduled_label
        ? 'Pick it up on ' + order.scheduled_label + '.'
        : 'Pick it up as soon as it is ready. Dachel will call you when it is.';
    } else if (order.order_type === 'dinein') {
      when = 'Dine-in · table ' + order.table_no;
      next = 'We will bring it to table ' + order.table_no + '.';
    } else {
      when = 'Delivery · ' + (order.delivery_area || 'today') + (order.scheduled_label ? ' · ' + order.scheduled_label
        : order.eta ? ' · ' + order.eta.charAt(0).toLowerCase() + order.eta.slice(1) : '');
      next = order.fee_to_confirm
        ? 'Delivery fee: to be confirmed. We will call you with it before we send your order. Pay in cash when it arrives.'
        : 'Pay in cash when it arrives.';
    }
    $('done-when').textContent = when;
    $('done-next').textContent = next;
    // Dine-in customers are in the shop; the others get a call to confirm.
    var minutes = Number(document.body.dataset.callMinutes) || 5;
    $('done-call').textContent = order.order_type === 'dinein' ? ''
      : "We'll call you within about " + minutes + ' minute' + (minutes === 1 ? '' : 's') + ' to confirm.';
    $('done-call').hidden = order.order_type === 'dinein';

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
      landmark: type === 'delivery' ? form.elements.landmark.value : '',
      delivery_area: type === 'delivery' ? form.elements.delivery_area.value : '',
      cash: type === 'delivery' && payMethod() !== 'gcash' ? form.elements.cash.value.trim() : '',
      pay: payMethod(),
      table_no: type === 'dinein' ? form.elements.table_no.value : '',
      pickup_at: type === 'pickup' ? form.elements.pickup_at.value : '',
      pickup_date: type === 'pickup' && form.elements.pickup_at.value !== 'asap' ? form.elements.pickup_date.value : '',
      deliver_at: type === 'delivery' ? form.elements.deliver_at.value : '',
      deliver_date: type === 'delivery' && form.elements.deliver_at.value !== 'asap' ? form.elements.deliver_date.value : '',
      voucher: voucher ? voucher.code : '',
      items: lines.map(function (l) { return { id: Number(l.id), qty: l.qty, options: l.opts || [], source: l.src || '' }; }),
      expected_total: total(),
      website: form.elements.website.value, // the honeypot: empty for people
    };

    sending = true;
    submitBtn.disabled = true;
    render();

    readyToken().then(function (t) {
      payload.checkout_token = t ? t.value : '';
      return fetch('api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    }).then(function (r) {
      // GCash: off to PayMongo's page. The cart stays until the payment is
      // confirmed on the way back (see "Back from GCash" below).
      if (r.ok && r.data.checkout_url) {
        if (!/^https:\/\/[a-z0-9.-]*paymongo\.com\//.test(r.data.checkout_url)) {
          formError('GCash could not be opened. Please try again or pay in cash.');
          return;
        }
        leaving = true;
        window.location.assign(r.data.checkout_url);
        return;
      }
      // GCash is down: back to paying in person.
      if (r.status === 409 && r.data.pay_unavailable) {
        form.querySelector('input[name="pay"][value="cash"]').checked = true;
        formError(r.data.error);
        return;
      }
      if (r.ok && r.data.order) {
        lines = [];
        setVoucher(null); // a code is used once per order; the next one starts fresh
        token = null;     // and so does the checkout token
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
      // The token was missing or too old (a page left open for hours): get a
      // new one, and the next tap goes through.
      if (r.status === 409 && r.data.retry) {
        token = null;
        fetchToken();
        formError(r.data.error);
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
      if (leaving) return; // the page is going to GCash: keep the button busy
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
    freshToken();
    dialog.showModal();
    if (count()) track('begin_checkout', { value: total(), count: count() });
  }

  dialog.addEventListener('close', function () {
    view.hidden = false;
    done.hidden = true;
    paying.hidden = true;
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    opener = null;
  });

  dialog.addEventListener('click', function (e) {
    if (e.target === dialog || e.target.closest('[data-close]')) { dialog.close(); return; }

    // Only the strip's own buttons: <body> carries data-suggest too (the lists).
    var sug = e.target.closest('button[data-suggest]');
    if (sug) {
      var sid = sug.dataset.suggest;
      if (catalog[sid] && catalog[sid].options) {
        var cardBtn = document.querySelector('.card[data-id="' + sid + '"] .card__btn');
        if (cardBtn) { fromSuggest = true; cardBtn.click(); }
        return;
      }
      add(sid, [], 'suggested');
      // Focus moves to the new line's stepper; the strip is redrawn without it.
      var added = $('cart-lines').querySelector('.cline[data-key="' + sid + '"] [data-step="1"]');
      if (added) added.focus();
      return;
    }

    var step = e.target.closest('[data-step]');
    if (step) {
      var key = step.closest('.cline').dataset.key;
      var line = find(key);
      if (!line) return;
      setQty(key, line.qty + Number(step.dataset.step));
      // Keep keyboard focus on the same control after the list is rebuilt.
      var again = $('cart-lines').querySelector('.cline[data-key="' + key + '"] [data-step="' + step.dataset.step + '"]');
      if (again && !again.disabled) again.focus();
      else if (!find(key)) (($('cart-lines').querySelector('[data-step]')) || dialog.querySelector('.sheet__close')).focus();
    }
  });

  /* ---------------------------- wiring ---------------------------- */

  $('v-apply').addEventListener('click', function () { checkVoucher($('v-code').value); });
  $('v-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); checkVoucher($('v-code').value); }
  });
  $('v-code').addEventListener('input', function () { voucherError(''); });
  $('v-have').addEventListener('change', function () {
    voucherError('');
    if (this.checked) {
      render();
      $('v-code').focus();
    } else {
      $('v-code').value = '';
      render();
    }
  });
  $('v-remove').addEventListener('click', function () {
    setVoucher(null);
    voucherError('');
    $('v-code').focus();
  });

  cards.forEach(function (card) {
    var btn = card.querySelector('[data-add]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (catalog[card.dataset.id] && catalog[card.dataset.id].options) {
        card.querySelector('.card__btn').click();
        return;
      }
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
    var sheetPrice = $('sheet-price');
    var sheetOpts = $('sheet-opts');
    var chosenIds = function () {
      return Array.prototype.map.call(sheetOpts.querySelectorAll('input:checked'), function (i) { return i.value; })
        .filter(Boolean).map(Number).sort(function (a, b) { return a - b; });
    };
    var showSheetPrice = function () {
      var item = catalog[sheet.dataset.id];
      if (!item || !item.options) { sheetAdd.textContent = 'Add to cart'; return; }
      var each = unitPrice({ id: sheet.dataset.id, opts: chosenIds() });
      sheetPrice.textContent = money(each);
      sheetAdd.textContent = 'Add to cart · ' + money(each);
    };
    sheet.addEventListener('sheet:open', showSheetPrice);
    sheet.addEventListener('close', function () { fromSuggest = false; });
    sheetOpts.addEventListener('change', function (e) {
      var set = e.target.closest('fieldset');
      if (set) set.querySelector('.opts__err').hidden = true;
      showSheetPrice();
    });
    sheetAdd.addEventListener('click', function () {
      var item = catalog[sheet.dataset.id];
      if (!item) return;
      var opts = item.options ? chosenIds() : [];
      // Each group's rule, shown on the group, before anything is added.
      var first = null;
      if (item.options) item.options.groups.forEach(function (g) {
        var problem = optionProblem({ options: { groups: [g] } }, opts.filter(function (id) {
          return g.options.some(function (o) { return o.id === id; });
        }));
        var set = sheetOpts.querySelector('fieldset[data-group="' + g.id + '"]');
        if (!set) return;
        var err = set.querySelector('.opts__err');
        err.textContent = problem === 'gone' ? 'That choice is not available.' : problem;
        err.hidden = !problem;
        if (problem && !first) first = set.querySelector('input:not(:disabled)');
      });
      if (first) { first.focus(); return; }
      add(sheet.dataset.id, opts, fromSuggest ? 'suggested' : '');
      sheet.close();
    });
  }

  $('cart-open').addEventListener('click', open);
  form.addEventListener('submit', submit);
  $('o-cash').addEventListener('input', renderChange);
  ['o-pickup-date', 'o-deliver-date'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      fillWhen(id === 'o-pickup-date' ? 'pickup' : 'delivery');
      applyDay();
      render();
    });
  });
  ['o-pickup', 'o-deliver'].forEach(function (id) {
    $(id).addEventListener('change', function () { applyDay(); render(); });
  });
  // A new area changes the fee, the time and the total.
  $('o-area').addEventListener('change', function () { render(); });
  // Exact amount: the total, so no change is needed (blank means the same).
  $('o-exact').addEventListener('click', function () {
    $('o-cash').value = String(total());
    renderChange();
  });
  form.addEventListener('change', function (e) {
    if (e.target.name === 'type') setType(e.target.value);
    if (e.target.name === 'pay') { clearErrors(); render(); }
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

  /* ---------------------------- back from GCash ---------------------------- */

  // PayMongo sends the customer back with ?gcash=<order>.<key> (and &back=1
  // when they left without paying). The server says whether it is paid; the
  // cart is emptied only then.
  var gcashRef = (window.location.search.match(/[?&]gcash=([^&]+)/) || [])[1];
  if (gcashRef) {
    var leftGcash = /[?&]back=1(&|$)/.test(window.location.search);
    // Keep the key out of the address bar, the history and any shared link.
    history.replaceState(null, '', window.location.pathname + window.location.hash);
    returnFromGcash(decodeURIComponent(gcashRef), leftGcash);
  }

  function showPaying(text) {
    view.hidden = true;
    done.hidden = true;
    paying.hidden = false;
    $('paying-text').textContent = text;
    if (!dialog.open) dialog.showModal();
  }

  /** Paid: the order is placed. Empty the cart and show the confirmation. */
  function finishPaid(order) {
    lines = [];
    setVoucher(null);
    token = null;
    save();
    form.reset();
    setType(type);
    paying.hidden = true;
    showDone(order);
  }

  /** Not paid: back to the cart, which is still full, with a word on why. */
  function notPaid(message) {
    paying.hidden = true;
    view.hidden = false;
    if (dialog.open) dialog.close();
    open();
    notice(message);
  }

  function checkPayment(ref) {
    return fetch('api/orders/payment?ref=' + encodeURIComponent(ref), { cache: 'no-store' })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, data: d }; }); });
  }

  function returnFromGcash(ref, left) {
    showPaying('This takes a few seconds.');
    if (left) {
      fetch('api/orders/payment/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: ref }),
      }).then(function (res) { return res.json().catch(function () { return {}; }); }).then(function (d) {
        // Paid after all (it happens when GCash was slow to send them back).
        if (d.status === 'paid') return checkPayment(ref).then(function (r) { finishPaid(r.data.order); });
        notPaid('You left GCash before paying, so your order was not placed. Your cart is still here: pay again, or choose cash.');
      }).catch(function () {
        notPaid('Could not reach the shop. Check your connection; your cart is still here.');
      });
      return;
    }
    var tries = 0;
    (function poll() {
      checkPayment(ref).then(function (r) {
        if (r.ok && r.data.status === 'paid') return finishPaid(r.data.order);
        if (!r.ok || r.data.status === 'cancelled') {
          return notPaid('Your GCash payment did not go through, so your order was not placed. Your cart is still here.');
        }
        tries += 1;
        if (tries < 20) { setTimeout(poll, 3000); return; }
        showPaying('GCash has not confirmed order #' + r.data.order.id + ' yet. If you paid, there is nothing more to do: '
          + 'we will see it within a few minutes. If you did not, it is cancelled in 15 minutes.');
      }).catch(function () {
        tries += 1;
        if (tries < 20) setTimeout(poll, 3000);
        else showPaying('Could not reach the shop to check your payment. Please call us.');
      });
    })();
  }
})();
