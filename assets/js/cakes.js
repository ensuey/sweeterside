/* Sweeter Side — custom cake booking request.
   Uploads the reference photo first (if any), then sends the request. The
   server checks everything again, including whether the day is still free. */
(function () {
  'use strict';

  var MAX_PHOTO = 5 * 1024 * 1024;
  var PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var $ = function (id) { return document.getElementById(id); };
  var form = $('cake-form');
  if (!form || !window.fetch) return;

  var body = document.body;
  var fullDates = (body.dataset.full || '').split(' ').filter(Boolean);
  var photoFile = null;   // the File the customer picked
  var photoToken = null;  // set once that file is uploaded
  var photoUrl = null;    // object URL for the preview
  var sending = false;

  form.hidden = false;
  document.querySelector('.cakes__nojs').hidden = true;

  /* ---------------------------- helpers ---------------------------- */

  /** '2026-11-08' -> 'Sun 8 Nov' (a calendar day, so read as UTC) */
  function niceDate(ymd) {
    var d = new Date(ymd + 'T00:00:00Z');
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }

  function clearErrors() {
    Array.prototype.forEach.call(form.querySelectorAll('[data-err]'), function (p) {
      p.hidden = true; p.textContent = '';
    });
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) {
      el.removeAttribute('aria-invalid');
    });
    $('cake-error').hidden = true;
  }

  function showErrors(fields) {
    var first = null;
    Object.keys(fields || {}).forEach(function (name) {
      var p = form.querySelector('[data-err="' + name + '"]');
      if (p) { p.textContent = fields[name]; p.hidden = false; }
      var input = form.elements[name];
      if (input && input.setAttribute) {
        input.setAttribute('aria-invalid', 'true');
        if (!first) first = input;
      } else if (p && !first) {
        first = p;
      }
    });
    if (first) {
      if (first.focus && first.tagName !== 'P') first.focus();
      else first.scrollIntoView({ block: 'center' });
    }
  }

  function formError(message) {
    var box = $('cake-error');
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ block: 'center' });
  }

  function handover() {
    var checked = form.querySelector('input[name="handover"]:checked');
    return checked ? checked.value : '';
  }

  /* ---------------------------- day ---------------------------- */

  var dateInput = $('k-date');
  dateInput.min = body.dataset.earliest;
  dateInput.max = body.dataset.latest;

  function checkDate() {
    var p = form.querySelector('[data-err="needed_on"]');
    var day = dateInput.value;
    var message = '';
    if (day && fullDates.indexOf(day) > -1) message = niceDate(day) + ' is fully booked. Please choose another day.';
    else if (day && day < dateInput.min) message = 'The earliest day we can make it is ' + niceDate(dateInput.min) + '.';
    else if (day && day > dateInput.max) message = 'We take bookings up to ' + niceDate(dateInput.max) + '.';
    p.textContent = message;
    p.hidden = !message;
    if (message) dateInput.setAttribute('aria-invalid', 'true');
    else dateInput.removeAttribute('aria-invalid');
    return !message;
  }

  /** Days fill up while the page is open; ask again after a refusal. */
  function refreshAvailability() {
    return fetch('/api/cakes/availability').then(function (r) { return r.json(); }).then(function (a) {
      fullDates = a.full_dates || [];
      dateInput.min = a.earliest;
      dateInput.max = a.latest;
    }).catch(function () { /* keep what we have */ });
  }

  dateInput.addEventListener('change', checkDate);

  /* ---------------------------- hand-over ---------------------------- */

  function showAddress() {
    var delivery = handover() === 'delivery';
    $('k-address-field').hidden = !delivery;
    $('k-address').disabled = !delivery;
  }
  form.addEventListener('change', function (e) {
    if (e.target.name === 'handover') showAddress();
  });
  showAddress();

  /* ---------------------------- photo ---------------------------- */

  function setPhoto(file) {
    var p = form.querySelector('[data-err="photo"]');
    p.hidden = true;
    if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; }
    photoFile = null;
    photoToken = null;

    if (file) {
      if (PHOTO_TYPES.indexOf(file.type) === -1) {
        p.textContent = 'Choose a JPEG, PNG or WebP photo.';
        p.hidden = false;
      } else if (file.size > MAX_PHOTO) {
        p.textContent = 'That photo is over 5 MB. Choose a smaller one.';
        p.hidden = false;
      } else {
        photoFile = file;
        photoUrl = URL.createObjectURL(file);
        $('photo-preview').src = photoUrl;
      }
    }
    $('photo-chosen').hidden = !photoFile;
    $('k-photo').value = '';
  }

  $('k-photo').addEventListener('change', function (e) { setPhoto(e.target.files[0]); });
  $('photo-remove').addEventListener('click', function () { setPhoto(null); });

  function uploadPhoto() {
    if (!photoFile || photoToken) return Promise.resolve(photoToken);
    return fetch('/api/cakes/photo', {
      method: 'POST',
      headers: { 'Content-Type': photoFile.type },
      body: photoFile,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || !data.photo) {
          var err = new Error(data.error || 'The photo did not upload. Try again, or remove it.');
          err.field = 'photo';
          throw err;
        }
        photoToken = data.photo;
        return photoToken;
      });
    });
  }

  /* ---------------------------- submit ---------------------------- */

  function checkFields() {
    var errors = {};
    var phoneDigits = form.elements.phone.value.replace(/\D/g, '');
    if (!form.querySelector('input[name="size"]:checked')) errors.size = 'Choose a size.';
    if (!form.elements.flavour.value) errors.flavour = 'Choose a flavour.';
    if (!dateInput.value) errors.needed_on = 'Choose the day you need the cake.';
    else if (!checkDate()) errors.needed_on = form.querySelector('[data-err="needed_on"]').textContent;
    if (handover() === 'delivery' && !form.elements.address.value.trim()) errors.address = 'Enter the delivery address.';
    if (!form.elements.name.value.trim()) errors.name = 'Enter your full name.';
    if (!phoneDigits) errors.phone = 'Enter a phone number we can call.';
    else if (!isPhMobile(form.elements.phone.value)) errors.phone = 'Please enter a valid PH mobile number, e.g. 0917 123 4567.';
    return errors;
  }

  /** 0917 123 4567, +63 917 123 4567 or 639171234567: the forms the server accepts. */
  function isPhMobile(raw) {
    var s = String(raw || '').trim();
    if (!/^\+?[\d\s()-]+$/.test(s)) return false;
    return /^(\+63|63|0)9\d{9}$/.test(s.replace(/[\s()-]/g, ''));
  }

  function finish(booking) {
    form.hidden = true;
    $('cake-done-text').textContent = 'Your request number is #' + booking.id + ', for ' +
      niceDate(booking.needed_on) + ' (' + booking.size + ').';
    $('cake-done').hidden = false;
    $('cake-done-title').focus();
    if (photoUrl) URL.revokeObjectURL(photoUrl);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sending) return;
    clearErrors();

    var missing = checkFields();
    if (Object.keys(missing).length) {
      formError('Please fill in the highlighted fields.');
      showErrors(missing);
      return;
    }

    sending = true;
    var submit = $('cake-submit');
    submit.disabled = true;
    submit.textContent = photoFile && !photoToken ? 'Uploading photo…' : 'Sending…';

    uploadPhoto().then(function (token) {
      submit.textContent = 'Sending…';
      var size = form.querySelector('input[name="size"]:checked');
      return fetch('/api/cakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size: size ? size.value : '',
          flavour: form.elements.flavour.value,
          occasion: form.elements.occasion.value,
          cake_message: form.elements.cake_message.value,
          design_notes: form.elements.design_notes.value,
          photo: token || '',
          needed_on: dateInput.value,
          handover: handover(),
          address: handover() === 'delivery' ? form.elements.address.value : '',
          name: form.elements.name.value,
          phone: form.elements.phone.value,
        }),
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok && data.booking) { finish(data.booking); return; }
        if (res.status === 422 && data.fields) {
          // A photo that was refused must be chosen again.
          if (data.fields.photo) setPhoto(null);
          formError(data.error || 'Please check the highlighted fields.');
          showErrors(data.fields);
          if (data.fields.needed_on) refreshAvailability();
          return;
        }
        formError(data.error || 'Your request could not be sent. Please try again.');
      });
    }).catch(function (err) {
      if (err.field) { formError(err.message); var f = {}; f[err.field] = err.message; showErrors(f); return; }
      formError('Could not reach the shop. Check your connection and try again.');
    }).then(function () {
      sending = false;
      submit.disabled = false;
      submit.textContent = 'Send cake request';
    });
  });

  // Clear a field's error as soon as the customer starts fixing it.
  form.addEventListener('input', function (e) {
    var name = e.target.name;
    if (!name || !e.target.hasAttribute('aria-invalid')) return;
    e.target.removeAttribute('aria-invalid');
    var p = form.querySelector('[data-err="' + name + '"]');
    if (p) { p.hidden = true; p.textContent = ''; }
  });
})();
