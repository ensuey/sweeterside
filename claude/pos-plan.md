# In-store POS: plan

The plan for the cashier/waiter POS in the admin. It is built in four phases,
each on its own branch and PR, with `npm test` green at every step. Zero
dependencies, `node:sqlite`, no inline scripts (CSP unchanged), Manila time.

Tax status: **non-VAT registered** (8% income tax option). `vat_registered` is
set to off by the migration. The VAT path is kept and tested, but sits behind
an owner-only Tax settings section. The 8% is income tax and never appears on
an order or receipt.

## Money

- Every amount in an order is **integer centavos**. The migration renames the
  order money columns to `*_cents` and multiplies the existing values by 100,
  in one transaction. Orders, lines, payments, refunds, the drawer and shifts
  are all stored in centavos.
- Menu prices, sale values and voucher values stay as **whole pesos**,
  because that is what the owner types. The pricing engine multiplies them by
  100 on the way in.
- `orders.get()` still returns the old peso fields (`subtotal`, `discount`,
  `delivery_fee`, `total`, `cash`, `change_due`, and `price` on each line),
  worked out from the centavo columns. The public checkout API speaks pesos,
  as before, so a cached cart page keeps working and the existing tests check
  the same totals.

### Rounding points

All rounding is half-up. Nothing is rounded anywhere else.

| # | Where | Rule |
|---|-------|------|
| R1 | Sale price per unit (`menu.salePrice`) | whole peso (unchanged) |
| R2 | Percent voucher (`pricing.voucherDiscount`) | whole peso (unchanged, so online totals match) |
| R3 | Shared SC/PWD portion = group amount ÷ diners | centavo |
| R4 | SC/PWD: VAT base (amount ÷ 1.12), then 20% | centavo, each step |
| R5 | Manual percent discount | centavo |
| R6 | Service charge | centavo |
| R7 | Splitting an order-level amount across lines | largest remainder, so the parts add up exactly |

Invariant: Σ line net + service charge + delivery fee = total.

## Pricing engine: `server/pricing.js` (Phase 1)

A pure module with no database access. It is used by the online checkout
(`orders.quote`) and by the POS.

Input:
- `lines`: per line, the key, item, name, quantity, regular unit price
  (centavos), sale unit price, whether it is eligible for SC/PWD, and an
  optional price override.
- `type`: the order type.
- `tax`: `{ vat_registered }`.
- `voucher`: the voucher row, already validated for dates and on/off.
- `manual`: `{ kind, value, line?, reason }`.
- `claimants`: each `{ type: sc|pwd, name, id_no, signature, mode:
  exclusive|shared, lines: {key: qty} }`.
- `diners`: the number of diners, for shared claims.
- `service`: `{ on, rate_bp, types, base, removed_reason }`.
- `delivery_fee` and `fee_reason`.
- `limits`: `{ manual_pct }`.
- `override`: whether a manager override was granted.

Order of operations:
1. Sale and override prices.
2. SC/PWD.
3. Voucher **or** manual discount, on the amounts not covered by SC/PWD.
4. Service charge.
5. Delivery fee.
6. Total.

**SC/PWD portion.** An exclusive claim covers the units the claimant ticked.
A shared claim covers the eligible units nobody claimed, divided by the
number of diners (R3).

**SC/PWD maths:**
- Non-VAT: `discount = 20% × amount`.
- VAT-registered: `base = amount / 1.12`, `vat_exempt = amount − base`,
  `discount = 20% × base`.

**No stacking.** `SC_PWD_POLICY = 'best_for_customer'`. Each claimant's
portion is priced two ways:
- SC/PWD on the regular price;
- the sale price minus that portion's share of the voucher or manual
  discount.

The claimant gets whichever is lower, and the choice is recorded (`applied:
'sc_pwd' | 'promo'`). A tie goes to SC/PWD. Setting the policy to
`'always_sc_pwd'` turns the comparison off.

**Manual discount:**
- A percentage or a fixed Php amount, on the whole order or one line, with a
  reason.
- Above the cashier limit (default 10%) it needs an override.
- It cannot be combined with a voucher.

**Service charge:**
- Off by default; 10% when on, for dine-in.
- Charged on the amount after discounts by default; a setting switches it to
  before discounts.
- It can be removed from an order, with a reason.
- **POS only**: online orders never get it, so the cart's total does not
  change.

**Output:** a breakdown per line and per claimant, plus totals (gross, sale
discount, VAT exemption, SC/PWD discount, voucher, manual discount, net,
service charge, delivery fee, total). It is saved as JSON on the order and
printed on the receipt.

## Roles, staff and PINs

- **Roles:**
  - `owner`: everything.
  - `cashier`: take orders, take payment, discounts within the limit, change
    the delivery fee, remove the service charge.
  - `waiter`: dine-in orders and send to kitchen. No payments, voids or manual
    discounts.
- **The tablet** stays signed in as the admin. Staff tap their name and enter
  a 4–6 digit PIN. The PIN is scrypt-hashed. Five wrong tries lock that staff
  member for 5 minutes, using the existing `login_attempts` table.
- **Unlocking** issues a staff token: a SHA-256-hashed row tied to the admin
  session, sent as `X-Staff-Token`. It locks after `pos_lock_minutes` idle
  (default 5), and the server checks this on every POS call.
- **Manager override:** the request carries `{ override: { staff_id, pin } }`.
  The server checks that the PIN belongs to an active owner and records that
  owner as the approver in the audit log.
- **First owner:** while there are no staff, the Staff page creates the owner.
  This needs the admin session and the admin password typed again.
- **Owner-only** endpoints (reports, exports, audit, staff, tax settings) need
  an owner's staff token. Every check happens on the server.

## Schema changes

All changes are additive or in-place renames inside one transaction, so
existing orders are untouched apart from the ×100.

**Phase 1:**
- `orders`:
  - money columns become `*_cents`;
  - `source` (`'online'` / `'pos'`, default `'online'`, which backfills
    existing rows);
  - `gross_cents`, `sc_pwd_discount_cents`, `vat_exempt_cents`,
    `manual_discount_cents`, `service_charge_cents`;
  - `pricing` (JSON breakdown);
  - `staff_id`, `paid_at`.
- `order_items`: `price` becomes `price_cents`; add `regular_price_cents` and
  `net_cents` (both backfilled).
- `items`: `sc_eligible` (default 1).
- New tables:
  - `staff` (name, role, PIN hash, active);
  - `staff_sessions`;
  - `audit_log` (append-only: triggers refuse UPDATE and DELETE).
- Settings:
  - `vat_registered = 0`;
  - service charge off, 10%, dine-in, after discounts;
  - `cashier_discount_limit = 10`;
  - `pos_lock_minutes = 5`.
- Voucher uses: online orders count unless cancelled, as now. POS orders count
  only once paid.

**Phase 2:**
- `orders`: `kitchen_sent_at` (a POS order with none is held and stays out of
  the queue), `pax`, `idempotency_key` (unique), `updated_by_staff_id`.
- `order_items`: `note`, `voided_qty`, `void_reason`, `sent_qty`.

**Phase 3:**
- New tables: `payments` (method, amount, tendered, change, reference, staff,
  shift), `refunds` and `refund_lines`, `shifts`, `cash_movements`.
- Settings: shop name and address, receipt width (58/80), footer, BIR mode,
  Non-VAT TIN, registered name and address, non-VAT notice.

**Phase 4:** no schema changes; reports read the tables above.

## Phases

1. **`pos-1-pricing`:**
   - money migration, the pricing engine, voucher refactor, staff, PIN and
     override, audit module, settings;
   - online checkout moved onto the engine;
   - tests, including every required fixture (non-VAT primary, VAT
     secondary).
2. **`pos-2-order-taking`:**
   - Staff page;
   - `/admin/pos`: PIN pad, item grid, ticket, order types, open tabs, send
     to kitchen, move and merge tables, void with override;
   - idempotency keys and an offline banner, with the in-progress ticket kept
     in sessionStorage.
3. **`pos-3-payments`:**
   - split payments (cash with change, GCash, Maya, QR Ph, card with a
     reference), and a `methods` registry for PayMongo later;
   - void and refund with override;
   - shifts and cash in/out;
   - X and Z readings;
   - 58/80 mm receipts, reprint and the kitchen ticket.
4. **`pos-4-reports`:**
   - reports by day, item, category, type, source and staff;
   - payments, discounts, the SC/PWD report with CSV;
   - vouchers and manual discounts;
   - the audit log with filters and CSV;
   - the ₱3M year-to-date tracker (warnings at 80% and 95%).

## Personal data

SC/PWD ID numbers are shown in full only to owners and cashiers on the order
itself. In lists they are masked (`****1234`). They appear in full only in the
owner's SC/PWD export.

## Fly deployment

The migrations run on start, as before. Nothing has to be done by hand on Fly.
After deploying, the owner:
1. creates the owner PIN on the Staff page;
2. adds staff;
3. checks the Tax settings (non-VAT is already set);
4. fills in the receipt details once Phase 3 is live.
