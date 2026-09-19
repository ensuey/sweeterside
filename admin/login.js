'use strict';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('error');
const submit = document.getElementById('submit');
const password = document.getElementById('password');
const toggle = document.getElementById('toggle-password');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

toggle.addEventListener('click', () => {
  const shown = password.type === 'text';
  password.type = shown ? 'password' : 'text';
  toggle.textContent = shown ? 'Show' : 'Hide';
  toggle.setAttribute('aria-pressed', String(!shown));
  toggle.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
  password.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;

  const email = document.getElementById('email').value.trim();
  if (!email || !password.value) {
    showError('Enter your email and password.');
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: password.value }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      window.location.assign('/admin');
      return;
    }
    showError(data.error || 'Could not sign in. Try again.');
  } catch {
    showError('Could not reach the server. Check that it is running.');
  }

  submit.disabled = false;
  submit.textContent = 'Sign in';
  password.select();
});
