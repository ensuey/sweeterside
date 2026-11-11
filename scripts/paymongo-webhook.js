#!/usr/bin/env node
'use strict';
/* Register the shop's payment confirmation address with PayMongo, once per
   key (test and live each need their own). Run it where PAYMONGO_SECRET_KEY
   is set, e.g. on the server:
     flyctl ssh console -C "node scripts/paymongo-webhook.js"
   It prints the webhook's signing secret. Set it on the server yourself:
     flyctl secrets set PAYMONGO_WEBHOOK_SECRET=whsk_...
   Nothing is saved or logged; the secret is shown on this screen only. */

const SITE = process.env.CANONICAL_HOST ? `https://${process.env.CANONICAL_HOST}` : 'https://sweeterside.ph';
const URL_ = `${SITE}/api/paymongo/webhook`;
const key = process.env.PAYMONGO_SECRET_KEY || '';

async function main() {
  if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(key)) {
    console.error('PAYMONGO_SECRET_KEY is not set here. Run this on the server, or set it first.');
    process.exit(1);
  }
  const headers = {
    Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
    'Content-Type': 'application/json', Accept: 'application/json',
  };
  const existing = await fetch('https://api.paymongo.com/v1/webhooks', { headers }).then((r) => r.json()).catch(() => ({}));
  const same = (existing.data || []).find((w) => w.attributes && w.attributes.url === URL_);
  if (same) {
    console.log(`A webhook for ${URL_} already exists (${same.id}, ${same.attributes.status}).`);
    console.log('If PAYMONGO_WEBHOOK_SECRET is lost, delete it in the PayMongo dashboard and run this again.');
    return;
  }
  const res = await fetch('https://api.paymongo.com/v1/webhooks', {
    method: 'POST', headers,
    body: JSON.stringify({ data: { attributes: { url: URL_, events: ['checkout_session.payment.paid'] } } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data) {
    console.error(`PayMongo answered ${res.status}. Check the key and try again.`);
    process.exit(1);
  }
  console.log(`Webhook registered for ${URL_} (${data.data.id}, ${key.startsWith('sk_live_') ? 'live' : 'test'} mode).`);
  console.log('Now set its signing secret on the server:');
  console.log(`  flyctl secrets set PAYMONGO_WEBHOOK_SECRET=${data.data.attributes.secret_key}`);
}

main();
