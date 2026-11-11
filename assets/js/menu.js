/* Sweeter Side — menu browsing.
   Progressive enhancement: every item is already in index.html, so the menu
   still reads fine with JavaScript disabled. This only adds search and filtering. */
(function () {
  'use strict';

  // Cards in the category sections. The best sellers row repeats some of them
  // and is hidden during a search or filter rather than filtered itself.
  var cards    = Array.prototype.slice.call(document.querySelectorAll('.section .card'));
  var best     = document.querySelector('[data-best-row]');
  var sections = Array.prototype.slice.call(document.querySelectorAll('.section'));
  var chips    = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var input    = document.getElementById('q');
  var resetBtn = document.querySelector('[data-reset]');

  var filter = 'all';
  var query  = '';

  function norm(s) { return (s || '').toLowerCase().trim(); }

  function apply() {
    var visible = 0;

    cards.forEach(function (card) {
      var matchCat  = filter === 'all' || card.dataset.cat === filter;
      var matchText = !query || norm(card.dataset.name).indexOf(query) !== -1;
      var show = matchCat && matchText;
      card.hidden = !show;
      if (show) visible++;
    });

    // Hide a section header when nothing inside it survived the filter.
    sections.forEach(function (section) {
      var shown = section.querySelectorAll('.card:not([hidden])').length;
      section.hidden = shown === 0;
      var count = section.querySelector('[data-count]');
      if (count) count.textContent = shown + (shown === 1 ? ' item' : ' items');
    });

    if (best) best.hidden = filter !== 'all' || query !== '';
    document.body.dataset.empty = visible === 0 ? 'true' : 'false';
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      filter = chip.dataset.filter;
      chips.forEach(function (c) {
        c.setAttribute('aria-pressed', String(c === chip));
      });
      apply();
    });
  });

  if (input) {
    var t;
    input.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { query = norm(input.value); apply(); }, 120);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      filter = 'all';
      query = '';
      if (input) input.value = '';
      chips.forEach(function (c) {
        c.setAttribute('aria-pressed', String(c.dataset.filter === 'all'));
      });
      apply();
      if (input) input.focus();
    });
  }

  /* ---------- Detail dialog ---------- */
  var sheet = document.getElementById('sheet');

  if (sheet && typeof sheet.showModal === 'function') {
    var shot   = document.getElementById('sheet-shot');
    var img    = document.getElementById('sheet-img');
    var nameEl = document.getElementById('sheet-name');
    var priceEl= document.getElementById('sheet-price');
    var tagEl  = document.getElementById('sheet-tag');
    var descEl = document.getElementById('sheet-desc');
    var optsEl = document.getElementById('sheet-opts');
    var opener = null;

    // Every card opens the popup, best sellers included.
    Array.prototype.forEach.call(document.querySelectorAll('.card'), function (card) {
      var btn = card.querySelector('.card__btn');
      if (!btn) return;

      btn.addEventListener('click', function () {
        var src = card.querySelector('.shot');
        var pic = card.querySelector('.shot img');

        // Show the photo the way the card does: a crop window onto a poster,
        // or (shot--plain) an uploaded photo shown whole. Without the plain
        // class an uploaded photo has no crop size, and the box collapses.
        var plain = src.classList.contains('shot--plain');
        shot.className = plain ? 'shot shot--plain' : 'shot';
        ['--x', '--y', '--w', '--h'].forEach(function (v) {
          if (plain) shot.style.removeProperty(v);
          else shot.style.setProperty(v, src.style.getPropertyValue(v));
        });
        img.src = pic.getAttribute('src');
        img.alt = pic.getAttribute('alt');

        nameEl.textContent  = card.dataset.name;
        if (card.dataset.size) {
          nameEl.appendChild(document.createTextNode(' '));
          var size = document.createElement('span');
          size.className = 'sheet__size';
          size.textContent = card.dataset.size;
          nameEl.appendChild(size);
        }
        if (descEl) {
          descEl.textContent = card.dataset.desc || '';
          descEl.hidden = !card.dataset.desc;
        }
        if (optsEl) renderOptions(card);
        // On sale: the full price struck through before the sale price.
        priceEl.textContent = '';
        if (card.dataset.was) {
          var was = document.createElement('s');
          was.className = 'price__was';
          was.textContent = '₱' + card.dataset.was;
          priceEl.appendChild(was);
          priceEl.appendChild(document.createTextNode(' '));
        }
        priceEl.appendChild(document.createTextNode('₱' + card.dataset.price));

        var soldOut = card.hasAttribute('data-soldout');
        tagEl.textContent   = soldOut ? 'Sold out'
          : card.dataset.badges ? card.dataset.badges
          : card.dataset.tag || '';
        sheet.dataset.id    = card.dataset.id;  // read by cart.js's "Add to cart"
        sheet.toggleAttribute('data-soldout', soldOut); // hides "Add to cart"

        opener = btn;
        sheet.showModal();
        // cart.js prices the choices and adds the item.
        sheet.dispatchEvent(new CustomEvent('sheet:open', { detail: { id: card.dataset.id } }));
      });
    });

    /* The item's option groups as fieldsets: radios to choose one, boxes to
       choose several. Built with DOM calls, so names cannot inject markup. */
    function renderOptions(card) {
      while (optsEl.firstChild) optsEl.removeChild(optsEl.firstChild);
      var data = null;
      try { data = card.dataset.options ? JSON.parse(card.dataset.options) : null; } catch (e) { data = null; }
      if (!data) return;
      data.groups.forEach(function (g) {
        var set = document.createElement('fieldset');
        set.className = 'opts__group';
        set.dataset.group = g.id;
        var legend = document.createElement('legend');
        legend.textContent = g.name + ' ';
        var rule = document.createElement('span');
        rule.className = 'opts__rule';
        rule.textContent = g.kind === 'single' ? (g.required ? '· choose 1' : '· optional')
          : g.min > 0 ? '· choose ' + (g.min === g.max ? g.min : g.min + ' to ' + g.max)
          : '· optional, up to ' + g.max;
        legend.appendChild(rule);
        set.appendChild(legend);
        // An optional "choose one" starts on None, so it can be left out again.
        var list = g.kind === 'single' && !g.required
          ? [{ id: '', name: 'None', price: 0, available: true }].concat(g.options) : g.options;
        list.forEach(function (o, i) {
          var label = document.createElement('label');
          label.className = 'opts__opt' + (o.available ? '' : ' opts__opt--off');
          var input = document.createElement('input');
          input.type = g.kind === 'single' ? 'radio' : 'checkbox';
          input.name = 'opt-' + g.id;
          input.value = String(o.id);
          input.disabled = !o.available;
          if (o.id === '' && i === 0) input.checked = true;
          var name = document.createElement('span');
          name.textContent = o.name + (o.available ? '' : ' (not available)');
          var price = document.createElement('span');
          price.className = 'opts__price';
          price.textContent = o.price > 0 ? '+₱' + o.price : '';
          label.appendChild(input);
          label.appendChild(name);
          label.appendChild(price);
          set.appendChild(label);
        });
        var err = document.createElement('p');
        err.className = 'opts__err';
        err.id = 'opts-err-' + g.id;
        err.setAttribute('role', 'alert');
        err.hidden = true;
        set.setAttribute('aria-describedby', err.id);
        set.appendChild(err);
        optsEl.appendChild(set);
      });
    }

    sheet.querySelector('.sheet__close').addEventListener('click', function () {
      sheet.close();
    });

    // Click the backdrop to dismiss.
    sheet.addEventListener('click', function (e) {
      if (e.target === sheet) sheet.close();
    });

    // Return focus to the card that opened it.
    sheet.addEventListener('close', function () {
      if (opener) { opener.focus(); opener = null; }
    });
  }

  apply();
})();
