# Sweeter Side — dev status

Live at https://sweeterside.fly.dev (Fly.io app `sweeterside`, region `sin`,
volume `sweeterside_data` at `/data`). Node 22, no npm dependencies, SQLite
via `node:sqlite`.

**Tests:** 115 (`npm test`):
- 57 in `test/server.test.js`
- 14 in `test/anti-fake-orders.test.js`
- 20 in `test/pricing.test.js`
- 12 in `test/pos-data.test.js`
- 12 in `test/pos-orders.test.js`

## In-store POS (in progress; plan in `claude/pos-plan.md`)

| Phase | Branch | PR | State |
|---|---|---|---|
| 1. Data model, pricing engine, tests | `pos-1-pricing` | #13 | open |
| 2. POS order-taking UI | `pos-2-order-taking` | #14 | open (stacked on #13) |
| 3. Payments, shifts, receipts | `pos-3-payments` | — | to do |
| 4. Reports and audit UI | `pos-4-reports` | — | to do |

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
- Dachel to set the real pick-up hours (still 10:00–20:00).
- Owner notifications (Messenger / WhatsApp) were discussed and put on hold.
