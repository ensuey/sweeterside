# Sweeter Side — dev status

Live at https://sweeterside.fly.dev (Fly.io app `sweeterside`, region `sin`,
volume `sweeterside_data` at `/data`). Node 22, no npm dependencies, SQLite
via `node:sqlite`.

**Tests:** 131 (`npm test`):
- 57 in `test/server.test.js`
- 14 in `test/anti-fake-orders.test.js`
- 20 in `test/pricing.test.js`
- 12 in `test/pos-data.test.js`
- 13 in `test/pos-orders.test.js`
- 8 in `test/pos-payments.test.js`
- 7 in `test/pos-reports.test.js`

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
- Dachel to set the real pick-up hours (still 10:00–20:00).
- Owner notifications (Messenger / WhatsApp) were discussed and put on hold.
- POS order #12 (a takeout saved at the counter, never sent) is still open on
  the live site: send it, take payment, or void it.
- Check the POS item photos on the counter iPad.
- Do a real print test of the 58/80 mm receipts on the thermal printer.
- The owner setup steps above (PINs, receipts, POS settings) are still to do.
