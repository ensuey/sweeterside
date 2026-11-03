/* Keeps the menu's "Open now / Closing soon / Closed" line and the closing
   soon bar current while the page is open, in Manila time like the server.
   The server decides: it refuses orders outside the opening hours. This only
   tells the customer in time, and stops the cart at closing. */
(function () {
  'use strict';

  var body = document.body;
  // Closed by hand (a holiday, closing early): the server's line stays as it is.
  if (body.dataset.switchOpen !== '1') return;

  function toMinutes(hhmm) {
    var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  var open = toMinutes(body.dataset.pickupOpen);
  var close = body.dataset.pickupClose === '24:00' ? 24 * 60 : toMinutes(body.dataset.pickupClose);
  var soon = Number(body.dataset.soonMinutes) || 30;
  if (open === null || close === null || !window.Intl) return;

  var status = document.getElementById('shop-status');
  var bar = document.getElementById('soonbar');
  var fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  function nowMinutes() {
    var h = 0, m = 0;
    fmt.formatToParts(new Date()).forEach(function (p) {
      if (p.type === 'hour') h = Number(p.value);
      if (p.type === 'minute') m = Number(p.value);
    });
    return h * 60 + m;
  }

  function clock12(mins) {
    if (mins >= 24 * 60) return 'midnight';
    var h = Math.floor(mins / 60);
    return (h % 12 || 12) + ':' + String(mins % 60).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
  }

  function setStatus(kind, pill, text) {
    if (!status) return;
    status.className = 'status status--' + kind;
    status.textContent = '';
    var span = document.createElement('span');
    span.className = 'status__pill';
    span.textContent = pill;
    status.appendChild(span);
    status.appendChild(document.createTextNode(' ' + text));
  }

  var shopOpen = body.dataset.shopOpen === '1';
  var lastInHours = null;

  function update() {
    var now = nowMinutes();
    var inHours = now >= open && now < close;
    var wasInHours = lastInHours;
    lastInHours = inHours;

    // Opening time came while the page was open: reload, so the cart starts.
    // Only on the change itself, so a clock a little off never reloads again and again.
    if (!shopOpen) {
      if (wasInHours === false && inHours) location.reload();
      return;
    }

    // Pre-orders on: after closing, a time tomorrow (or later) can still be
    // chosen, so the cart stays; as soon as possible and dine-in go.
    var types = (body.dataset.orderTypes || '').split(' ');
    var canPreorder = Number(body.dataset.preorderDays) > 0
      && (types.indexOf('pickup') > -1 || types.indexOf('delivery') > -1);
    if (!inHours && canPreorder) {
      shopOpen = false;
      body.dataset.shopOpen = '0';
      body.dataset.preorder = '1';
      if (bar) bar.hidden = true;
      setStatus('closed', 'Closed now', 'You can pre-order for tomorrow at ' + clock12(open) + '.');
      document.dispatchEvent(new CustomEvent('shop:preorder'));
      return;
    }

    if (!inHours) {
      shopOpen = false;
      body.dataset.shopOpen = '0';
      body.classList.add('shop-closed');
      if (bar) bar.hidden = true;
      var message = "We're closed for today. We take orders again from " + clock12(open) + ' tomorrow.';
      setStatus('closed', 'Closed', message);
      // cart.js stops the order and says why; whatever is in the cart is kept.
      document.dispatchEvent(new CustomEvent('shop:closed', { detail: { message: 'Sorry, ' + message.charAt(0).toLowerCase() + message.slice(1) } }));
      return;
    }

    var left = close - now;
    if (left <= soon) {
      setStatus('soon', 'Closing soon', 'We take orders until ' + clock12(close) + ' today.');
      if (bar) {
        bar.textContent = 'Closing soon: we take online orders until ' + clock12(close) + ' today ('
          + left + ' min left).';
        bar.hidden = false;
      }
    } else {
      setStatus('open', 'Open now', 'Tap Add on anything you like to order. Orders until ' + clock12(close) + '.');
      if (bar) bar.hidden = true;
    }
  }

  update();
  setInterval(update, 30 * 1000);
})();
