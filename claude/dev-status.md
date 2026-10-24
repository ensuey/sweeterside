# Sweeter Side — dev status

Live at https://sweeterside.fly.dev (Fly.io app `sweeterside`, region `sin`,
volume `sweeterside_data` at `/data`). Node 22, no npm dependencies, SQLite
via `node:sqlite`.

**Tests:** 71 (`npm test`): 57 in `test/server.test.js`, 14 in
`test/anti-fake-orders.test.js`.

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
