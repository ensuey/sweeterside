# Security audit: routes and protections

What every HTTP route needs before it runs, and the security findings still
open. `CLAUDE.md` says to add each new endpoint here. Update the table in the
same PR as the route.

Last checked against `server/index.js` on 2026-11-01 (after PR #23).

## How a request is checked

- **Admin session**: `requireApiAuth`.
  - Hashed session token in the `HttpOnly; SameSite=Strict` cookie, `Secure` on the live site (`FORCE_SECURE_COOKIES=1` in `fly.toml`).
  - No session: **401**. `common.js` takes a 401 to mean signed out.
- **CSRF**: `requireApiAuth(…, { csrf: true })`.
  - The `X-CSRF-Token` header must match the session's token (checked with `timingSafeEqual`).
  - Wrong or missing: **403**.
- **Staff PIN**: `requireStaff`.
  - The admin session plus a staff session in `X-Staff-Token`.
  - Locked POS: **423**.
  - With `permission`, the role must have it in `staff.PERMISSIONS`, else **403**.
  - A wrong PIN is **403 `wrong_pin`**, never 401.
- **Owner override**: actions over a role's limit need an owner PIN in the body. The server checks it in `staff.authorise` and audits it.
- **Body size**:
  - JSON: `MAX_JSON` 64 KB (`readJson`).
  - Images: `MAX_UPLOAD` 5 MB (`readBody`).
  - Over the limit: **413**.
- **Validation**: module validators throw `ValidationError`, which becomes **422** with field messages. Other errors give a generic message, and only 5xx details are logged.
- **Rate limits**: per client IP, sliding windows (`rateLimiter`). The IP is `Fly-Client-IP` on Fly and the socket address elsewhere, never `X-Forwarded-For` (F1, fixed).
- **Headers** on every response:
  - CSP: `script-src 'self'`, no inline scripts. Inline style attributes are allowed.
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.
  - Fly forces HTTPS (`force_https`).

## Route table

Legend:
- **Auth**:
  - — public;
  - S: admin session;
  - P: admin session + staff PIN;
  - P(perm): P plus that role permission.
- **CSRF**: ✓ needs the token.
- **Limit**: rate limit per IP.

### Public: customer menu and cakes

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /`, `GET /cakes` | — | | | Server-rendered; every field escaped. |
| `GET /healthz` | — | | | `{ ok, items }` only. |
| `GET /robots.txt`, `GET /sitemap.xml`, `GET /llms.txt` | — | | | For search engines and AI assistants. Public facts only (`server/business.js` and the live menu with prices); robots.txt keeps crawlers out of `/admin` and `/api/`. |
| `GET /api/checkout-token` | — | | | Signed token; an order must arrive 3 s – 2 h after it was issued. |
| `POST /api/orders` | — | | 5 / 10 min | Prices and totals recomputed on the server; stale total refused. Honeypot field, PH mobile check, blocklist, max 3 open orders per number. Refusals logged by reason code only. |
| `POST /api/vouchers/check` | — | | 20 / 10 min | Every check counts, to stop code guessing. |
| `GET /api/cakes/availability` | — | | | Dates and slots only. |
| `POST /api/cakes/photo` | — | | 5 / 10 min | Magic bytes checked (JPEG/PNG/WebP), 5 MB, random file name, private folder, metadata stripped (F2). Unattached photos removed after a day. |
| `POST /api/cakes` | — | | 3 / 10 min | Booking; same phone checks and blocklist as orders. |
| `GET /assets/…`, `GET /admin/*.js|css` | — | | | Static files; path containment in `safeResolve`. The admin HTML shells are never served this way. |
| `GET /assets/uploads/…` | — | | | Menu item photos only (public by design), resolved through `menu.resolveImage`. |

### Sign-in

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /admin/login` | — | | | Redirects to `/admin` when signed in. |
| `POST /api/login` | — | | 6 fails per email + IP, or 20 per email from anywhere → 15 min lock | scrypt hashes. |
| `POST /api/logout` | — | | | Clears the session. Cross-site requests cannot carry the `SameSite=Strict` cookie. |
| `GET /api/session` | S | | | Email and CSRF token for the admin pages. |
| `GET /admin`, `/admin/{items,vouchers,cakes,blocked,pos,staff,reports,settings}` | S | | | Page shells; redirect to sign-in without a session. `no-store`. |

### Admin: menu, vouchers, settings

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /api/items`, `GET /api/categories` | S | | | |
| `POST /api/items`, `PUT|PATCH|DELETE /api/items/:id` | S | ✓ | | `menu.validate`: whole-peso prices, image must resolve inside `assets/`, crop inside the image. Rewrites `index.html` (escaped). |
| `POST /api/items/reorder`, `PATCH /api/items/:id/stock` | S | ✓ | | |
| `POST /api/categories`, `PUT|PATCH|DELETE /api/categories/:id`, `POST /api/categories/reorder` | S | ✓ | | A category with items cannot be deleted (FK `RESTRICT`). |
| `GET /api/images` | S | | | Image list from `assets/` and uploads. |
| `POST /api/images` | S | ✓ | | Item photo upload: magic bytes, 5 MB, random name, metadata stripped (F2). Public once used on the menu. |
| `GET /api/vouchers`, `POST /api/vouchers`, `PUT|PATCH|DELETE /api/vouchers/:id`, `PATCH /api/vouchers/:id/active` | S | ✓ (writes) | | |
| `GET|PUT|PATCH /api/settings` | S | ✓ (writes) | | Ordering settings, delivery fee, shop open/closed. |
| `GET|PUT|PATCH /api/cake-settings` | S | ✓ (writes) | | |

### Admin: orders, blocklist, cakes

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /api/orders` | S | | | Queue with history and blocked flags. `pos_input` and request keys are never sent (`withLines`). |
| `PATCH|PUT /api/orders/:id` | S | ✓ | | Status through `orders.setStatus`: Confirm first where required; cancel reasons; **cancel refused while money is paid and not refunded** (409). |
| `GET /api/blocked`, `POST /api/blocked`, `DELETE /api/blocked/:id` | S | ✓ (writes) | | Block by number or from an order, optionally cancelling it as fake. `created_by` is the admin's email. |
| `GET /api/cakes`, `GET /api/cakes/counts` | S | | | |
| `GET /api/cakes/:id/photo` | S | | | Private reference photo; token format checked. |
| `PATCH|PUT /api/cakes/:id` | S | ✓ | | Quotes, deposits, status. |

### POS: staff sessions

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /api/pos/staff` | S | | | Names and roles for the PIN screen. |
| `POST /api/pos/unlock` | S | ✓ | 30 wrong PINs / 10 min per IP; 5 per staff → 5 min lock | Wrong PIN gives 403 `wrong_pin`. scrypt PINs. |
| `POST /api/pos/lock` | S | ✓ | | |
| `GET /api/pos/me` | P | | | Who is unlocked and their permissions. |
| `POST /api/staff/first` | S | ✓ | login lock | Creates the first owner; needs the admin password again. 409 once staff exist. |
| `GET /api/staff`, `POST /api/staff`, `PATCH|PUT|POST /api/staff/:id`, `…/:id/pin` | P(manage_staff) | ✓ (writes) | | Audited (`staff_add`, `staff_change`, `staff_pin_change`). |

### POS: tickets, payments, shifts

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /api/pos/menu`, `GET /api/pos/open`, `GET /api/pos/recent` | P | | | `recent` lists paid POS **and online** orders (reprint, refund). |
| `POST /api/pos/quote` | P | ✓ | | Totals priced by `server/pricing.js`; the browser's numbers are never used. |
| `POST /api/pos/orders`, `PUT|PATCH /api/pos/orders/:id` | P | ✓ | | Request key (idempotent) and `version` (no lost updates). Discounts, SC/PWD, price overrides and voids checked against role limits, with owner override audited. **POS orders only.** |
| `GET /api/pos/orders/:id` | P | | | Reads POS **and online** orders (for the pay screen). SC/PWD IDs masked unless `see_id_numbers`. |
| `POST /api/pos/orders/:id/{table,merge,void}` | P | ✓ | | POS orders only. Void needs a reason and the owner. |
| `POST /api/pos/orders/:id/pay` | P (`take_payment` or owner override) | ✓ | | POS and online orders. Request key; amounts checked against what is due; cash needs an open shift. |
| `POST /api/pos/orders/:id/refund` | P (`refund` or owner override) | ✓ | | Reason required; audited. |
| `GET /api/pos/orders/:id/receipt` | P | | | IDs in full only for `see_id_numbers` roles. |
| `GET /api/pos/shift` | P | | | |
| `POST /api/pos/shift/{open,close}` | P(manage_shift) | ✓ | | Audited. |
| `POST /api/pos/shift/cash` | P(cash_movement) | ✓ | | Cash in/out with a reason; audited. |
| `GET /api/pos/shifts`, `GET /api/pos/shifts/:id` | P(manage_shift) | | | X/Z readings. |
| `GET /api/pos/receipt-settings`, `GET /api/pos/settings` | P | | | |
| `PUT|PATCH /api/pos/receipt-settings`, `PUT|PATCH /api/pos/settings` | P(tax_settings) | ✓ | | Owner only; audited (`settings_change`). |

### POS: online orders (PR #23)

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /api/pos/online/pending` | **S only** | | | The bell feed: `{ id, order_type, status }` only, **no customer details**. Has no PIN so it works while the POS is locked. |
| `GET /api/pos/online` | P | | | Active online orders. Waiters (no `takeout_and_delivery`) get **dine-in only**. No `pos_input`. |
| `PATCH /api/pos/online/:id` | P | ✓ | | `{ status, reason? }` through `orders.setStatus`. Online orders only (a POS id is 404). Waiters dine-in only (403). Cancel needs a reason; audited as `order_cancel`. |

### Order alerts (Web Push, PR #29)

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /api/push` | S | | | Whether alerts are set up, the public VAPID key, and the device list (label, push service host, dates, a short hash). Never the keys or the push address. |
| `POST /api/push/subscriptions` | S | ✓ | 20 devices | Push address must be https at a known push service (Apple, Google, Mozilla, Microsoft), so the server cannot be pointed at internal addresses (SSRF). p256dh must be a point on P-256; auth 16 bytes. 503 when no VAPID keys. |
| `DELETE /api/push/subscriptions` (by address), `DELETE /api/push/subscriptions/:id` | S | ✓ | | Turn alerts off for this device, or remove one from the list. |
| `POST /api/push/test` | S | ✓ | | Sends a test alert to every device. |
| `GET /admin/sw.js` | — | | | The alerts service worker: shows notifications, opens `/admin…` only, caches nothing. `Service-Worker-Allowed: /admin`, `no-cache`. |
| `GET /admin/manifest.webmanifest` | — | | | Home Screen app manifest (`start_url /admin`). |

Alerts are sent after a new online order or cake booking, encrypted per device (RFC 8291) and signed with the VAPID key (RFC 8292, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` fly secrets). They carry the order number, type and total (cakes: number, date, size), never names, phones or addresses. A device the push service reports gone (404/410) is removed.

### Reports and audit (owner)

| Route | Auth | CSRF | Limit | Notes |
|---|---|---|---|---|
| `GET /api/reports/{summary,sc-pwd,discounts,threshold}` | P(reports) | | | |
| `GET /api/reports/sc-pwd.csv` | P(reports) | | | The only place SC/PWD IDs appear in full outside receipts. CSV formula characters neutralised. |
| `GET /api/audit`, `GET /api/audit.csv` | P(audit) | | | Append-only log (triggers refuse UPDATE and DELETE). |

## Open findings

### F1 (high, fixed): the client IP came from raw `X-Forwarded-For`
- **Where:** `clientIp()` in `server/index.js` returns the **first** entry of `X-Forwarded-For`. The client controls that entry: Fly's proxy appends the real address at the end.
- **Effect:** any client can send a new made-up IP on each request. That gets around:
  - **The admin sign-in lock.** It is keyed on email + IP (`auth.throttleKey`), so passwords can be guessed without ever locking. scrypt slows each guess but does not stop it.
  - The first-owner password check (same lock).
  - The public limits: orders, voucher checks (code guessing), cake bookings and cake photo uploads.
  - The per-IP wrong-PIN cap. The per-staff 5-PIN lock still holds.
- **Fix:**
  - Read `Fly-Client-IP` only, as `CLAUDE.md` requires, and fall back to the socket address when it is missing (local runs).
  - Add a per-email sign-in lock that does not depend on the IP.
  - Add a test that a forged `X-Forwarded-For` does not reset the limits.
- **Status:** fixed 2026-11-02. `clientIp()` reads `Fly-Client-IP` only when running on Fly (`FLY_APP_NAME` set) and the socket address otherwise. `X-Forwarded-For` is ignored. Sign-in also has a per-email lock (20 fails from any address, 15 min), and a lock that has run out starts the count again. Tests: `test/client-ip.test.js`.

### F2 (medium, fixed): EXIF metadata was not stripped from uploads
- **Where:** `cakes.savePhoto` and `handleUpload` (item photos) write the bytes as received.
- **Effect:** a customer's cake photo can carry GPS coordinates and the device model. It stays private behind the admin session, but it is still personal data kept for no reason. Item photos are public once on the menu, so their metadata is public too.
- **Fix:** remove the JPEG APP1 (EXIF/XMP) segments, the PNG `eXIf`/`tEXt`/`iTXt`/`zTXt` chunks and the WebP `EXIF`/`XMP ` chunks before saving. This can be done with plain buffer parsing (no dependency, as `imagesize.js` does). Test with a JPEG that has GPS.
- **Status:** fixed 2026-11-02. `server/imagemeta.js` strips EXIF/XMP/IPTC/comments (JPEG), text/EXIF/time chunks (PNG) and EXIF/XMP chunks (WebP), and drops anything after the end of the image. A JPEG keeps only its orientation. Both upload paths save the cleaned file. Photos already on the volume were cleaned the same day with `node scripts/strip-photo-metadata.js --apply` (13 menu photos, 9 changed; no cake photos yet). Run it again if older photos are ever restored from a backup. Tests: `test/imagemeta.test.js`.

### Lower priority
- **Session cookie:** `fly.toml` sets `FORCE_SECURE_COOKIES=1`, so it is always `Secure` on the live site. Local runs fall back to `X-Forwarded-Proto`.
- **HSTS:** no `Strict-Transport-Security` header. Fly redirects HTTP to HTTPS, but HSTS would stop the first plain request.
- **Bell feed:** `GET /api/pos/online/pending` deliberately skips the PIN. It returns ids, types and statuses only. Keep it that way: never add names, phones or totals to it.
- **Domain move (PR #25):** `CANONICAL_HOST` sends GET and HEAD on `www.` and `.fly.dev` to a fixed host. It is not an open redirect, and saves and `/healthz` are not moved.

## Change log
- 2026-11-03: robots.txt, sitemap.xml and llms.txt added (local SEO).
- 2026-11-02: order alerts (Web Push) routes added.
- 2026-11-02: F2 fixed: new uploads are stripped, and the existing menu photos were cleaned on the live volume.
- 2026-11-02: F1 fixed (client IP, per-email sign-in lock).
- 2026-11-01: file created from `server/index.js` (PRs up to #23). F1 and F2 recorded.
