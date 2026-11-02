'use strict';
/* Makes the VAPID key pair that signs order alerts (Web Push).

   Send it straight to Fly, so the private key is never shown or saved:
     node scripts/vapid-keys.js | flyctl secrets import -a sweeterside

   Locally, put the two lines in your environment instead. Making new keys
   turns alerts off on every device until each one turns them on again.
   Same format as push.generateKeys(); kept apart so no database is opened. */

const crypto = require('node:crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pub = publicKey.export({ format: 'jwk' });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
process.stdout.write(`VAPID_PUBLIC_KEY=${raw.toString('base64url')}\nVAPID_PRIVATE_KEY=${privateKey.export({ format: 'jwk' }).d}\n`);
