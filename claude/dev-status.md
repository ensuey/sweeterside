# Sweeter Side — dev status

Live at https://sweeterside.ph (Fly.io app `sweeterside`, region `sin`,
volume `sweeterside_data` at `/data`). `www.sweeterside.ph` and
`sweeterside.fly.dev` redirect there (`CANONICAL_HOST` secret). Node 22, no
npm dependencies, SQLite via `node:sqlite`.

**Tests:** 172 (`npm test`):
- 60 in `test/server.test.js`
- 14 in `test/anti-fake-orders.test.js`
- 20 in `test/pricing.test.js`
- 12 in `test/pos-data.test.js`
- 13 in `test/pos-orders.test.js`
- 12 in `test/pos-payments.test.js`
- 7 in `test/pos-reports.test.js`
- 5 in `test/pos-online.test.js`
- 3 in `test/canonical.test.js`
- 6 in `test/client-ip.test.js`
- 6 in `test/imagemeta.test.js`
- 9 in `test/push.test.js`
- 5 in `test/seo.test.js`

## In-store POS (live; plan in `claude/pos-plan.md`)

| Phase | Branch | PR | State |
|---|---|---|---|
| 1. Data model, pricing engine, tests | `pos-1-pricing` | #13 | merged, deployed |
| 2. POS order-taking UI | `pos-2-order-taking` | #14 → #17 | merged, deployed |
| 3. Payments, shifts, receipts | `pos-3-payments` | #15 → #17 | merged, deployed |
| 4. Reports and audit UI | `pos-4-reports` | #16 → #17 | merged, deployed |

Phases 2–4 reached `main` through #17. Deleting #13's branch on merge closed
the stacked #14 and #16, and #15 merged into the phase 2 branch, so #17
carried the same commits. Next time, merge stacked PRs without
`--delete-branch`, or retarget each to `main` first.

Deployed 2026-10-24 (Fly v12). Before the one-way centavo migration, the
live database was copied on the volume to `/data/app-before-pos-2026-10-24.db`
(8 orders, 9 items). After the deploy, every order and line matched it × 100.

What Phase 1 shipped:
- **Money in centavos:** the order and line money columns are renamed to
  `*_cents` and multiplied by 100. Orders read back still carry their peso
  fields.
- **Pricing engine:** `server/pricing.js`, shared by the online checkout and
  the POS. It covers SC/PWD (non-VAT primary, VAT kept), the
  best-for-customer comparison, vouchers, manual discounts with the cashier
  limit, service charge, delivery fee changes and price overrides.
- **Staff:** owner, cashier and waiter roles with scrypt PINs, a 5-wrong lock,
  staff sessions under the admin session with an idle lock, and owner-PIN
  overrides.
- **Audit log:** append-only (triggers refuse UPDATE and DELETE).
- **POS settings:** `vat_registered` is set to off by the migration; the
  service charge is off; the cashier limit is 10%; the idle lock is 5 minutes.
- **New columns:** `orders.source` (backfilled `'online'`), `gross_cents`,
  discount columns, `pricing` JSON and `paid_at`. Voucher uses from POS orders
  count only once paid.

What Phase 2 shipped:
- **POS page** (`/admin/pos`), tablet first with two panels on phones:
  - item grid with photos, search, categories and "N left";
  - ticket with dine-in, takeout and delivery, notes and price changes;
  - discounts, SC/PWD claimants, service charge and delivery fee, totals
    priced by the server.
- **Tabs:** save without sending; Send to kitchen goes to the queue as
  Confirmed; items added later are sent on their own; move and merge tabs.
- **Voids:** taking off sent items needs a reason and the owner's PIN. A held
  tab is discarded; a sent one is voided.
- **Safety:** idempotent saves (request key), versioned tabs (no lost
  updates), offline banner, ticket kept in sessionStorage.
- **Staff page** (`/admin/staff`): first owner (needs the admin password),
  add staff, roles, switch off, reset PIN; POS settings; tax settings with a
  warning.
- **Shared PIN lock** (`admin/staff-gate.js`): lock screen, PIN pad, idle
  lock, owner override dialog. A locked POS answers 423; a wrong PIN is a 403
  with `wrong_pin`.
- **Elsewhere:** Items page "Eligible for SC/PWD"; the queue shows Counter
  orders, notes and the POS discounts; POS and Staff in the admin nav.

What Phase 3 shipped:
- **Payments:** cash with tendered, change and quick buttons; GCash, Maya, QR
  Ph and card with a reference; split payments, paid only when covered;
  idempotent; a `METHODS` registry ready for PayMongo.
- **Refunds:** full or by line (with the line's service charge share), owner
  approval, a reason, audited.
- **Shifts:** open with starting cash, cash in and out with reasons, X
  reading, close with counted cash (a note if it is off), the Z reading saved.
  Cash needs an open shift.
- **Printing** (browser print, 58/80 mm): receipts with SC/PWD details,
  payments and change; the ORDER SLIP notice until BIR mode; kitchen tickets;
  X and Z readings.
- **Staff page:** receipt settings and BIR details.

What Phase 4 shipped:
- **Reports page** (`/admin/reports`, owner PIN): sales by day, item,
  category, type, source and staff; payments by method; discounts; refunds.
- **SC/PWD report** with a CSV export: full IDs in the CSV only; no VAT column
  while non-VAT.
- **Vouchers and manual discounts** report (staff, approver, reason).
- **Audit log** viewer with filters and a CSV export.
- **Php 3M tracker** (year to date): warnings at 80% and 95%.
- **CSV exports** are formula-safe; every report endpoint is owner-only on the
  server.

Fixes since the POS went live:
- **#18 (v13): held POS tabs counted as new orders.** The Orders page said
  "1 new order to confirm" with an empty list. A tab saved but not sent to
  the kitchen is left out of the queue, but `orders.counts()` still counted
  it. The counts now use the same filter as the list.
- **#19 (v13): admin pages full width.** All admin pages and the top bar use
  the whole screen with a side gutter, and the order queue adds columns on
  wide screens.
- **#19 (v13): POS item photos on iPad.** The photo box is now made square
  with padding instead of `aspect-ratio`. The sprite position is set in JS as
  plain percentages instead of nested `calc()`. Photos are no longer
  lazy-loaded inside the scrolling grid. Not yet confirmed on a real iPad.
- **#20 (v14): security review fixes.**
  - **SC/PWD IDs in `pos_input`.** Every order response carried the raw
    `pos_input` column (what the cashier typed, with ID numbers in full), past
    the masking. It reached waiters through the POS, and the counter tablet's
    admin session through `/api/orders`. `withLines()` now drops `pos_input`
    and `last_request_key`.
  - **Manual discount limit bypass.** Removing unsent items could stretch an
    allowed discount past the cashier limit with no owner PIN. The limit is
    now checked on every save against the order as it then stands. An
    owner-approved discount keeps the share it was approved at
    (`approved_bp`), and re-approvals are audited.

## Since 2026-11-01: online orders at the POS, the domain, security, order alerts, phones, SEO (#21–#34)

All merged and deployed (Fly v15–v26).

- **#21 (v15): the logo for items without a photo.**
  - New items start on the logo instead of the first image in `assets/` (the
    `Meals.jpg` poster), and the server falls back to it when no image is sent.
  - A one-time migration (`replacePosterImages`, flag
    `poster_images_replaced`) moved every item still on a poster to the logo
    with no crop. On the live site that was Cookies and Cream (a pixelated
    184×245 crop), Spanish Latte and Hazelnut Latte. New databases are seeded
    with the logo. Backup before it:
    `/data/app-backup-20261101-081931-before-logo.db`.
- **#22 (v16): take payment for online orders; quieter Block number.**
  - Unpaid order cards have **Take payment**, which opens the POS pay screen
    for that order (`/admin/pos?pay=<id>`).
  - `payments.pay`, `refund` and `receipt` accept online orders. `pos.view`
    reads them (`online: true`, never held). Save, void, move and merge stay
    POS-only.
  - Cancelling an order with money paid on it is refused until it is refunded.
  - "Block this number" is now a small grey "Block number" link.
- **#23 (v17): online orders in the POS window, with a bell.**
  - An **Online orders** button in the POS bar. New orders ring a Web Audio
    bell (no sound file), then again every 30 s while a New order is unopened
    on that tablet. It rings while the POS is locked, and a 🔔/🔕 button mutes
    it.
  - Opening an order shows the details and the next step: Confirm → Start
    preparing (prints the kitchen ticket) → Ready / Out for delivery / Served
    → Completed. Take payment comes first if it is still unpaid; Cancel needs
    a reason.
  - Waiters see and move dine-in online orders only.
  - Routes:
    - `GET /api/pos/online/pending`: ids, types and statuses only, no PIN;
    - `GET /api/pos/online`: needs a PIN;
    - `PATCH /api/pos/online/:id`: needs a PIN and CSRF, and audits a cancel
      as `order_cancel`.
- **#24 (v18): `claude/security-audit.md`.** Every route with its auth, CSRF
  and limits, plus the open findings. Keep it updated with each new route.
- **#25 (v18) + secret (v21): the domain.**
  - `CANONICAL_HOST=sweeterside.ph` (a Fly secret, set 2026-11-02) sends GET
    and HEAD on `www.sweeterside.ph` and `sweeterside.fly.dev` to
    `https://sweeterside.ph` with a 301.
  - Saves and `/healthz` are never moved.
  - Let's Encrypt certificates for both names, issued by Fly.
  - DNS is at dot.ph (`dns1`/`dns2.domains.ph`): A `66.241.125.143`, AAAA
    `2a09:8280:1::1c7:3fc3:0`.
- **#26 (v19): F1, the client IP.**
  - `clientIp()` read the first `X-Forwarded-For` entry, which the client
    writes, so the sign-in lock and every public rate limit could be bypassed.
    It now reads `Fly-Client-IP` on Fly (`FLY_APP_NAME`) and the socket
    address elsewhere.
  - Sign-in also locks an email for 15 min after 20 wrong passwords from any
    addresses.
  - A lock that has run out starts the count again.
  - Confirmed on the live site: a forged header no longer resets the voucher
    check limit.
- **#27 (v20) + #28: F2, photo metadata.**
  - `server/imagemeta.js` strips GPS, camera and other metadata from JPEG,
    PNG and WebP uploads (menu and cake photos), and drops images appended
    after the end. A JPEG keeps only its orientation.
  - The 13 existing menu photos on the volume were cleaned with
    `scripts/strip-photo-metadata.js --apply` (9 changed). There are no cake
    photos yet.
- **#29 (v22) + keys (v23): order alerts (Web Push).**
  - Every new online order and cake booking is pushed to each device that
    turned alerts on: "New order #31 · Pick-up · ASAP · Php 258". The alert
    has the number, type and total only (cakes: number, date, size), never
    names, phones or addresses. Tapping it opens Orders (or Cakes).
  - Turned on from **Settings → Order alerts** (moved from Orders in #32). On an iPhone this works only
    from the admin added to the Home Screen, on iOS 16.4 or later. The panel
    has a test alert and a device list with Remove.
  - `server/push.js` uses `node:crypto` only: aes128gcm per device
    (RFC 8291) and VAPID ES256 (RFC 8292). Push addresses must be at a known
    push service (no SSRF). Devices reported gone (404/410) are removed.
    Alerts go out after the response.
  - `/admin/sw.js` shows notifications and caches nothing; there is also
    `/admin/manifest.webmanifest`, and Home Screen links on every admin page.
    The `push_subscriptions` table is capped at 20 devices.
  - Keys: the `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` Fly secrets, set
    2026-11-02 with `node scripts/vapid-keys.js | flyctl secrets import`.
    **Do not make new keys:** that turns alerts off on every device.
  - Live: the owner's iPhone turned alerts on and the test alert arrived
    (2026-11-02).
- **#31 (v24): the admin on phones.** Measured at iPhone 17 Plus width
  (434 px):
  - **Top bar:** the eight page links ran 194 px off the screen, so every
    admin page scrolled sideways, and the bar was 167 px and pinned. Under
    760 px the logo, shop pill and buttons share one row, and the links go on
    a second row that scrolls sideways and fades at the edge; the current
    page's link is brought into view (`common.js`). The bar is 101 px and
    scrolls away.
  - **No zoom on tap:** every field was 14–15 px, so iPhone Safari zoomed in
    on each tap. On touch screens (`pointer: coarse`) fields are 16 px.
  - **Home Screen app:** the admin top bar and the POS bar leave room for the
    status bar (`env(safe-area-inset-top)`).
  - **Report tables** scroll inside their box.
  - Not yet confirmed on the real iPhone.
- **#32 (v25): Settings page** (`/admin/settings`, admin sign-in, in every
  page's nav).
  - Holds **Fake-order protection** and **Order alerts**, moved off the
    Orders page. Ordering hours, the delivery fee, order types and the shop
    switch stay on Orders.
  - The fake-order code moved from `orders.js` to `settings.js`, and
    `push.js` loads on Settings. It still saves through `/api/settings` and
    `/api/push`.
- **#34 (v26): local SEO and AI search** for café, coffee shop, cake shop
  and pastries in San Isidro, Davao Oriental.
  - **One source for the facts:** `server/business.js` holds the name,
    address (Unit 5, Lasaca Bldg, Public Market, Batobato, San Isidro, Davao
    Oriental 8209), map position (6.8340817, 126.0873542), phone
    (0932 762 0367), hours (daily 10:00–20:00, assumed every day), the
    Google Maps and Facebook links, and delivery areas (Batobato, Manikling,
    Baon, Bitaogan). It must match the Google Business Profile exactly.
  - **Pages:** keyword titles and descriptions, canonical links, Open Graph,
    geo tags. Below the menu: "Visit our café and cake shop in San Isidro"
    and "Questions" (FAQ). The footer has the name, address and phone.
  - **JSON-LD** (`server/seo.js`): `CafeOrCoffeeShop` + `Bakery`, the menu
    with today's prices from the database, `WebSite` and `FAQPage`. The
    cakes page describes custom cakes as a `Service`, from the lowest size
    price. `<` is escaped, and the CSP is unchanged.
  - **Crawler files:** `robots.txt` (admin and API out), `sitemap.xml`, and
    `llms.txt` (a summary with the menu and prices for AI assistants).
  - Live: the structured data reads 32 menu items with prices.

After deploying (owner, once):
1. Staff → create the owner PIN (needs the admin password), then add the
   cashiers and waiters.
2. Staff → Tax settings: confirm **non-VAT** (already set by the migration).
3. Staff → Receipts: address, contact, paper width. Leave BIR mode off until
   the accountant confirms the TIN and PTU.
4. Staff → POS settings: service charge (off by default), cashier discount
   limit (10%), idle lock (5 min).
5. POS → Shift → open with the starting cash before taking cash.

## Features shipped

- Customer menu rendered from the database (works without JavaScript), with
  search, category filters and an item popup with photos.
- Admin with scrypt passwords, hashed session tokens, CSRF, login throttling
  and a strict CSP (no inline scripts).
- Cart and checkout: Delivery (cash on delivery), Pick-up (time today) and
  Dine-in (table number). Prices recomputed by the server, stale totals
  refused, 5 orders per IP per 10 minutes.
- Items page: Available / Not available / Sold out, and a max per day.
- Promotions: best seller badge, sale prices, voucher codes.
- Custom cake bookings (`/cakes`) with notice period, cakes per day, a
  reference photo, quotes and deposits.
- Shop open / closed switch with a closed note; cakes stay bookable.
- Cart thumbnails and a voucher box behind "I have a voucher code".
- **Fake-order protection**
  - PH mobile numbers checked and stored as `+639XXXXXXXXX` (orders and cake
    bookings), older rows backfilled.
  - Required landmark / directions for delivery.
  - Hidden honeypot field at checkout.
  - Signed checkout token: orders under 3 seconds or over 2 hours after the
    cart opened are refused (`CHECKOUT_SECRET`, or a generated key kept in
    the database).
  - At most 3 orders in progress per number (a setting).
  - New **Confirmed** status: delivery and pick-up must be confirmed before
    Preparing (per-type switches; dine-in off by default), with a
    "Waiting N min" badge after 10 minutes.
  - Cancel reasons (customer, no-show, fake, other) and a per-number history
    badge on each order.
  - Optional auto-confirm for trusted numbers (3 completed, 0 no-shows/fakes).
  - Blocklist: "Block this number" on orders and a Blocked numbers page;
    blocked numbers cannot order or book cakes.
  - Refusals logged by reason code only.

## Still to do

- Dachel to replace the placeholder cake sizes, prices and flavours.
- Dachel to set the real opening hours on Settings (still 10:00–20:00).
- Owner notifications (Messenger / WhatsApp) were discussed and put on hold.
- POS order #12 (a takeout saved at the counter, never sent) is still open on
  the live site: send it, take payment, or void it.
- Check the POS item photos on the counter iPad.
- SEO after #34 (owner):
  - **Google Business Profile:** primary category Café, plus Coffee shop,
    Cake shop and Bakery; website `https://sweeterside.ph`; the same hours,
    phone and address as the site; photos; reviews.
  - **Google Search Console:** add `sweeterside.ph`, submit
    `https://sweeterside.ph/sitemap.xml`, and request indexing of `/` and
    `/cakes`.
  - Check `https://sweeterside.ph` in Google's Rich Results Test.
  - Update the Facebook page website link.
  - Confirm the hours are the same every day, or say which days differ.
- Check the admin layout on the iPhone after #31: no sideways scrolling, the
  link row swipes with the current page in view, no zoom when tapping a field,
  nothing under the clock or Dynamic Island.
- On the counter iPad, open `https://sweeterside.ph/admin/pos`, enter a PIN
  and tap once so the new-order bell can play. Keep the tab open and the
  screen on during service; check that the bell rings for a test order.
- Staff sign in again on `https://sweeterside.ph` (sign-ins do not carry over
  from `sweeterside.fly.dev`).
- Update links to `https://sweeterside.ph`: the Messenger page button, social
  profiles, Google Business profile, printed QR codes.
- Turn on order alerts on any other phone or tablet that should get them
  (Dachel's phone, the counter iPad): Home Screen app → Settings → Order alerts.
- Delete the photo backup with the metadata still in it:
  `/data/photos-backup-20261102-033855-before-strip.tar.gz` (the owner runs
  the `rm` through `flyctl ssh console`).
- Do a real print test of the 58/80 mm receipts on the thermal printer.
- The owner setup steps above (PINs, receipts, POS settings) are still to do.
