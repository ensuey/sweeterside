'use strict';
/* The payer's page (/pay/<id>.<key>): sends the reference number. The key
   is the page's own address. */
(function () {
  var form = document.getElementById('pay-form');
  if (!form) return;
  var error = document.getElementById('pay-error');
  var button = form.querySelector('button[type="submit"]');

  function showError(text) {
    error.textContent = text;
    error.hidden = !text;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var method = form.querySelector('input[name="method"]:checked');
    var reference = form.elements.reference.value.trim();
    if (!method) return showError('Choose how you paid.');
    if (reference.length < 4) return showError('Enter the reference number from your receipt.');
    showError('');
    button.disabled = true;
    fetch('/api/pay/reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: decodeURIComponent(location.pathname.slice('/pay/'.length)),
        method: method.value, reference: reference, name: form.elements.name.value.trim(),
      }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) {
          form.hidden = true;
          document.getElementById('pay-done').hidden = false;
          return;
        }
        var fields = data.fields || {};
        showError(fields.reference || fields.method || fields.name || data.error || 'Something went wrong. Please try again.');
        button.disabled = false;
      });
    }).catch(function () {
      showError('Could not send. Check your connection and try again.');
      button.disabled = false;
    });
  });
})();
