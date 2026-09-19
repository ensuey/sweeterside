/* Sweeter Side — menu browsing.
   Progressive enhancement: every item is already in index.html, so the menu
   still reads fine with JavaScript disabled. This only adds search and filtering. */
(function () {
  'use strict';

  var cards    = Array.prototype.slice.call(document.querySelectorAll('.card'));
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
      if (count) count.textContent = String(shown);
    });

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
    var opener = null;

    cards.forEach(function (card) {
      var btn = card.querySelector('.card__btn');
      if (!btn) return;

      btn.addEventListener('click', function () {
        var src = card.querySelector('.shot');
        var pic = card.querySelector('.shot img');

        ['--x', '--y', '--w', '--h'].forEach(function (v) {
          shot.style.setProperty(v, src.style.getPropertyValue(v));
        });
        img.src = pic.getAttribute('src');
        img.alt = pic.getAttribute('alt');

        nameEl.textContent  = card.dataset.name;
        priceEl.textContent = 'Php ' + card.dataset.price;
        tagEl.textContent   = card.dataset.cat === 'drinks' ? 'Frappe' : 'Food';

        opener = btn;
        sheet.showModal();
      });
    });

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
