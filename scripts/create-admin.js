#!/usr/bin/env node
'use strict';
/* Create or reset an admin account.
     npm run create-admin
     npm run create-admin -- --email dachel@example.com
   Set ADMIN_PASSWORD to skip the prompt (useful for scripted setup). */

const readline = require('node:readline');
const { db } = require('../server/db');
const auth = require('../server/auth');

const MIN_PASSWORD = 12;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
      return;
    }
    // Suppress echo while a password is typed.
    const onData = (char) => {
      if (['\n', '\r', ''].includes(char.toString())) {
        process.stdin.removeListener('data', onData);
      } else {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (a) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
  });
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

(async () => {
  const email = arg('--email') || await ask('Admin email: ');
  if (!EMAIL_RE.test(email)) {
    console.error('\nThat does not look like an email address.');
    process.exit(1);
  }

  const existing = auth.findUserByEmail(email);

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (min 12 chars, hidden): ', { hidden: true });
    const again = await ask('Confirm password: ', { hidden: true });
    if (password !== again) {
      console.error('\nThose passwords do not match.');
      process.exit(1);
    }
  }

  if (password.length < MIN_PASSWORD) {
    console.error(`\nUse at least ${MIN_PASSWORD} characters.`);
    process.exit(1);
  }

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(auth.hashPassword(password), existing.id);
    // A password change must not leave old sessions usable.
    auth.destroyUserSessions(existing.id);
    console.log(`\nPassword updated for ${existing.email}. Existing sessions were signed out.`);
  } else {
    auth.createUser(email, password);
    console.log(`\nAdmin account created for ${email.toLowerCase()}.`);
  }

  console.log('Sign in at http://127.0.0.1:3000/admin/login');
  process.exit(0);
})().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
