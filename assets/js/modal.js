'use strict';
/* Customer popups (the cart and the item popup) open as ordinary page
   elements, not in the browser's top layer. Session replays (Microsoft
   Clarity) do not draw the top layer, so a popup opened with showModal() was
   missing from every recording. This gives back what showModal() did: a
   dimmed background, the page behind made inert (no clicks, no focus, hidden
   from screen readers), Esc to close, and focus moved into the popup.
   menu.js and cart.js return focus to what opened it on 'close'. */
(function () {
  var stack = []; // open popups, newest last: { dialog, inerted }
  var scrim = null;

  function top() { return stack.length ? stack[stack.length - 1].dialog : null; }

  function layout() {
    var n = stack.length;
    document.documentElement.classList.toggle('modal-open', n > 0);
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.className = 'scrim';
      // Tap the dimmed page to close the popup on top.
      scrim.addEventListener('click', function () { var d = top(); if (d) d.close(); });
      document.body.appendChild(scrim);
    }
    scrim.hidden = n === 0;
    // Popups at 51, 53…; the scrim just under the newest, so one open below it is dimmed too.
    scrim.style.zIndex = String(48 + 2 * n);
    stack.forEach(function (s, i) { s.dialog.style.zIndex = String(51 + 2 * i); });
  }

  function open(dialog) {
    if (dialog.open) return;
    if (!scrim) layout();
    // Everything else on the page goes inert, including a popup already open below.
    var inerted = [];
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el === dialog || el === scrim || el.inert || el.tagName === 'SCRIPT') return;
      el.inert = true;
      inerted.push(el);
    });
    stack.push({ dialog: dialog, inerted: inerted });
    dialog.setAttribute('aria-modal', 'true');
    dialog.show();
    layout();
    var first = dialog.querySelector('[autofocus]')
      || dialog.querySelector('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
    if (first) first.focus({ preventScroll: true });

    dialog.addEventListener('close', function onClose() {
      dialog.removeEventListener('close', onClose);
      for (var i = stack.length - 1; i >= 0; i--) {
        if (stack[i].dialog !== dialog) continue;
        stack[i].inerted.forEach(function (el) { el.inert = false; });
        stack.splice(i, 1);
        break;
      }
      dialog.style.zIndex = '';
      layout();
    });
  }

  document.addEventListener('keydown', function (e) {
    var d = top();
    if (e.key !== 'Escape' || !d) return;
    e.preventDefault();
    d.close();
  });

  window.ssModal = { open: open };
})();
