# Sweeter Side — dev status

Live at https://sweeterside.ph (Fly.io app `sweeterside`, region `sin`,
volume `sweeterside_data` at `/data`). `www.sweeterside.ph` and
`sweeterside.fly.dev` redirect there (`CANONICAL_HOST` secret). Node 22, no
npm dependencies, SQLite via `node:sqlite`.

**Tests:** 301 (`npm test`):
- 61 in `test/server.test.js`
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
- 9 in `test/seo.test.js`
- 6 in `test/hours.test.js`
- 12 in `test/cro.test.js`
- 9 in `test/delivery.test.js`
- 11 in `test/options.test.js`
- 5 in `test/suggestions.test.js`
- 8 in `test/preorders.test.js`
- 6 in `test/cakes-page.test.js`
- 9 in `test/tracking.test.js`
- 12 in `test/inventory.test.js`
- 6 in `test/admin-common.test.js`
- 6 in `test/orders-delete.test.js`
- 11 in `test/paymongo.test.js`
- 7 in `test/corrections.test.js`
- 10 in `test/credit.test.js`
- 6 in `test/staging.test.js`

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

## Since 2026-11-01: online orders at the POS, the domain, security, order alerts, phones, SEO, hours (#21–#38)

All merged and deployed (Fly v15–v28).

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
- **#36 (v27): opening hours.**
  - **Settings → Opening hours:** one pair of times, the same every day,
    Manila time. Ordering follows them by itself:
    - before opening: "Closed — we open at 10:00 AM today";
    - open: "Open now — orders until 8:00 PM";
    - last 30 minutes: **Closing soon** in the status line and a bar at the
      top of the menu;
    - after closing: "We're closed for today. We take orders again from
      10:00 AM tomorrow".
  - The server refuses orders and voucher checks outside the hours (409
    `closed`), so a wrong phone clock changes nothing.
  - An open menu page switches by itself (`assets/js/hours.js`, every 30 s).
    At closing the Add buttons go, and the cart keeps its items and says why.
    Before opening, the page reloads when ordering opens.
  - **Pick-up follows the opening hours.** The separate pick-up hours on
    Orders are gone. The saved values carried over: they are still stored
    under `pickup_open`/`pickup_close`, shown in the API as
    `open_at`/`close_at`.
  - **The Open/Closed switch on Orders is an override** (holiday, closing
    early). The top-bar pill and the Orders panel show what customers see:
    open, closing soon or closed.
  - The hours shown on the site, in the JSON-LD and in `llms.txt` come from
    the setting. Closing can be `24:00` (open until midnight); the admin time
    field cannot hold that.
  - **Tests:** ordering follows the clock, so every test file that places
    orders sets the hours to all day. The suite also passes with the default
    hours forced to a closed window.
- **#37 (v27): favicon and app icons**, cropped from the logo by
  `scripts/make-icons.js` (Node built-ins only: PNG via `node:zlib`).
  - The logo has a wide empty margin, so it was a pale speck in a tab.
  - **Tab (16–48 px, `favicon.ico` at `/favicon.ico`):** the ice cream cup on
    the logo's cream colour.
  - **Home Screen, manifest and alerts (180/192/512 px):** the whole round
    logo, on white.
  - Run the script again only if the logo changes. Re-adding the Home
    Screen app shows the new icon, and then needs order alerts turned on
    again on that device.
- **#38 (v28): About us page** (`/about`), from the shop's facts only.
  - **Sections:** who we are, what we serve (today's menu with prices, up
    to 8 per category), custom cakes (sizes "from" prices and days of
    notice), how to order, quick facts, and visit us.
  - **SEO:** a keyword title and description, canonical, one h1 and a
    breadcrumb. JSON-LD: the business, an `AboutPage` and a
    `BreadcrumbList`.
  - **Indexable:** in `sitemap.xml` and `llms.txt`, and linked from the
    menu and cakes footers.
  - Waiting on the owner's own story: the year opened, Dachel, best sellers,
    photos.

## CRO and usability (six PRs, from the brief of 2026-11-03; #40–#46)

One PR at a time, each from `main` after the last was merged. All merged and
deployed (Fly v29–v35).

| PR | What | Branch | GitHub | Fly |
|---|---|---|---|---|
| A | Quick fixes | `cro-quick-fixes` | #40 | v29 |
| B | Delivery areas, fees, times, free delivery | `delivery-areas` | #41 | v30 |
| C | Descriptions, sizes and options | `item-options` | #42 | v31 |
| D | Cart suggestions | `cart-suggestions` | #43 | v32 |
| fix | Cart + and − buttons (broken by D) | `fix-cart-stepper` | #44 | v33 |
| E | Pre-orders and scheduled orders | `pre-orders` | #45 | v34 |
| F | Cakes page and testimonials | `cakes-social` | #46 | v35 |

- **PR A (#40, v29): quick fixes.**
  - **Photos:** an item showing the logo has `alt=""`. Every photo has its
    own width and height and `decoding="async"`; all but the first four are
    `loading="lazy"`. Sizes are read once per path (`render.imageSize`).
  - **Wording:** "1 item / N items" in the category counts. Prices show
    **₱** on the customer pages and in the admin.
  - **Receipts:** **Currency on receipts** (Staff → Receipts, ₱ or PHP,
    default ₱) drives the printed receipts and readings. Logs and CSV column
    headers keep "Php".
  - **Honeypot:** already hidden from sight and from screen readers; a test
    now pins it.
  - **Delivery cash is optional:** blank, or the **Exact amount** button,
    means no change, and the server stores cash = total. The admin card says
    "Exact / no change needed".
  - **Phone:** a hint line tied to the field (`aria-describedby`).
  - **Confirmation screen:** order number, the lines, type and time, total,
    cash and change, "We'll call you within about N minutes to confirm"
    (Settings → Order confirmation, default 5), tap to call and "Message us
    on Facebook". The Facebook link is now a setting (`facebook_url`, https
    Facebook/Messenger only) and the SEO pages use it too.
  - **Share image:** Settings upload through the usual pipeline (metadata
    stripped). It sets `og:image` with width, height and alt, and
    `twitter:card summary_large_image`; without one, the logo and `summary`.
  - **Best sellers row:** at the top of the menu; best sellers that can be
    ordered today; scrolls sideways. menu.js hides it during a search or
    filter. It is also in the static `index.html`.
  - **Menu health** on the Items page: items with no photo of their own,
    each with an edit link. The description and size-label checks come with
    PR C.
  - **Phone fixes:** the card Add buttons and the phone, map and footer links
    are 44 px touch targets. Checked at 360 px: no sideways scroll, 16 px
    inputs, and a real order placed with blank cash.
  - **Tests:** `test/cro.test.js` (12).
- **PR B (#41, v30): delivery areas.**
  - **Areas** (`server/delivery.js`, table `delivery_areas`): name, fee
    (blank = not set, so not offered), usual time from–to in minutes, on/off,
    order. Seeded once with Batobato, Manikling, Baon and Bitaogan, no fees.
    Managed under Settings → **Delivery areas** (`/api/delivery-areas`).
  - **Pricing:** the fee comes from the area on the server
    (`delivery.resolve`); the browser's fee is never used. The pricing engine
    takes `delivery.free_over_cents`: items after every discount at or over
    the threshold pay no fee. The checkout and the POS share it.
  - **Other area:** ₱0 at order time, `fee_to_confirm = 1`, a "Fee to
    confirm" flag on the Orders card and in the POS; the customer reads
    "Delivery fee: to be confirmed".
  - **Orders** gain `delivery_area_id`, `delivery_area` (name snapshot) and
    `fee_to_confirm` (additive columns). The single `delivery_fee` setting
    and the Orders-page fee field are gone (the old row stays, unread).
  - **Cart:** area dropdown with fee and time, the time under it, "Add ₱X
    more for free delivery", and the area and time on the confirmation.
  - **Site text:** Delivery section, FAQ, About, `llms.txt` and `areaServed`
    come from the areas that are on (`BUSINESS.deliveryAreas` removed).
  - Checked in the browser: fees, times, Other area, free delivery at the
    threshold, a placed order, the Settings section and the POS dropdown.
  - **Tests:** `test/delivery.test.js` (9).
- **PR C (#42, v31): descriptions, sizes and options.**
  - **Items** gain `description` (≤120) and `size_label` (≤20), on the card
    (one line, clamped) and in the popup. Menu health adds "No description"
    and "No size".
  - **Option groups** (`server/options.js`; tables `option_groups`,
    `options`, `item_option_groups`): pick one or several, required or not,
    least/most, options with a price (whole pesos) and on/off. Reusable
    across items. Managed on the Items page (`/api/option-groups`).
  - **Pricing:** line = item + options; sale and SC/PWD on the whole line;
    vouchers unchanged; today's limit by item. Rules in `pos-plan.md`.
  - **Customer:** Add on an item with options opens the popup (radios,
    boxes, live price, errors per group). Cart lines keyed by item +
    options. Options ship as an escaped `data-options` attribute on the
    card, so the CSP is unchanged. Without JavaScript there is no cart
    at all, so nothing else was needed for the static menu.
  - **POS:** the same picker; lines show their options.
  - **Orders** keep a copy (`order_items.options`, `options_cents`),
    shown on the Orders card, the POS online detail, kitchen tickets and
    receipts. Reports add **Options chosen**. Order alerts now say how many
    items (no options, no customer data).
  - Migration: additive columns and new tables only; no item or order changed.
  - Checked in the browser (and at about 360 px): picker, refusals, cart
    lines, a placed order, the Orders card, the Items page editor and the POS.
  - **Tests:** `test/options.test.js` (11).
- **PR D (#43, v32): cart suggestions.**
  - **Settings → Cart suggestions:** up to three items per category and three
    for any order (`server/suggestions.js`, one setting, `/api/suggestions`).
    Items removed from the menu drop out by themselves.
  - **Cart:** a "Goes well with" strip under the lines (hidden when the cart
    is empty): categories in the cart first, then any order; never what is in
    the cart, sold out or off the menu; at most three. One-tap Add; items with
    options say Choose and open the popup over the cart. Data ships in the
    page (`data-suggest`), no extra request.
  - **Tracking:** lines carry `source: 'suggested'` (`order_items.source`,
    additive column; anything else the browser sends counts as the menu).
    Reports → **Added from suggestions**: units and net for the dates.
  - Checked in the browser (and at about 360 px): strip, one-tap add, Choose
    with options, a placed order with the flags saved, the Settings section.
  - **Tests:** `test/suggestions.test.js` (4).
  - **Fixed in #44 (v33):** from v32 the cart's + and − did nothing, because
    `<body>` carries `data-suggest` and the click handler matched it. Only the
    strip's buttons match now; a test pins it. Found while testing PR E;
    PR D's own checks only clicked the strip.
- **PR E (#45, v34): pre-orders and scheduled orders.**
  - **Rules** in `server/schedule.js` (Manila time): pick-up on a day and a
    15-minute slot; delivery ASAP or a 30-minute window; dine-in now only.
    ASAP and dine-in need the shop open now; up to N days ahead (Settings →
    Opening hours → **Pre-orders up to**, default 3, 0 = today only).
  - **Outside the hours** (switch on) the menu takes pre-orders: "Closed
    now · You can pre-order for …", the cart starts at the next slot. At
    closing time an open page switches over by itself (`shop:preorder`).
    The Closed switch still blocks everything.
  - **Orders** gain `scheduled_for` (UTC) and `scheduled_date` (Manila day),
    additive columns. **Daily limits count by that day** (or the day placed),
    and the page ships each day's stock (`data-stock`) for the cart.
  - **Admin and POS:** "Scheduled — Tue 4 Nov, 10:30 AM" badge, sorted by
    the time, "Waiting" from 30 minutes before it. Alerts say "Scheduled" +
    time (no customer details). The confirmation shows the time.
  - Checked in the browser outside the hours: pre-order menu, days and
    times, per-day stock, two scheduled orders, the Orders page and the POS.
  - **Tests:** `test/preorders.test.js` (8).
- **PR F (#46, v35): cakes page and social proof.**
  - **Gallery** (`server/gallery.js`, table `cake_gallery`): photos uploaded
    through `/api/images` (metadata stripped), caption, order; on `/cakes`.
  - **Prices:** size table on `/cakes`; flavour extras (`Ube | 100`,
    `cake_flavour_prices`); a live estimate in the form, the same worked out
    on the server (`cakes.estimate`) and kept on the booking (`estimate_from`).
  - **Booking info:** notice from the setting; deposit and pick-up/delivery
    text editable on the Cakes page, neutral defaults (no amounts promised).
  - **No-JS:** gallery, prices and info are plain HTML; the fallback adds
    tap-to-call and Facebook links.
  - **Testimonials** (`server/testimonials.js`, table `testimonials`): quote,
    name, source, on/off; optional rating line. Menu (above Visit us) and
    `/cakes`. Nothing seeded; no review structured data (Google does not
    show snippets for reviews a business hosts about itself).
  - Also fixed: the hidden photo input on `/cakes` was 1,500 px wide (a
    field rule beat `.vh`), so the page scrolled sideways; `.vh` sizes are
    `!important` now.
  - Checked in the browser (and at about 360 px): gallery upload and
    caption, flavour extras, the estimate, testimonials on/off, rating line.
  - **Tests:** `test/cakes-page.test.js` (6).

After deploying (owner, once):
1. Staff → create the owner PIN (needs the admin password), then add the
   cashiers and waiters.
2. Staff → Tax settings: confirm **non-VAT** (already set by the migration).
3. Staff → Receipts: address, contact, paper width. Leave BIR mode off until
   the accountant confirms the TIN and PTU.
4. Staff → POS settings: service charge (off by default), cashier discount
   limit (10%), idle lock (5 min).
5. POS → Shift → open with the starting cash before taking cash.

## Tracking: Meta Pixel (#51), Google Analytics, Google Ads, Clarity (2026-11-08)

- Settings → Tracking: one field per tool. Each tool is off while its ID is
  blank; with no IDs nothing changes on the site. Formats are strict:
  `G-…`, `AW-…`, labels `[A-Za-z0-9_-]`, Clarity lowercase letters and
  numbers, Pixel digits. Ads labels are used only with the Ads ID.
- Meta Pixel `300448864172496` is saved on the live site. The Google and
  Clarity IDs are still to be pasted in by the owner.
- With any ID, the menu, cakes and about pages load `assets/js/tracking.js`
  (it replaced `pixel.js`). It shows a slim one-line consent bar ("We use
  cookies…", Details · No · Accept; Details names the tools that are on), and
  loads nothing until Accept. The bar sits above the cart bar when that shows. The choice is kept in the browser
  (`sweeterside-tracking-consent`; a "no" to the old Meta-only banner is
  kept). A "Tracking choices" link in the footer changes it, and No revokes
  consent in every tool (Consent Mode for Google).
- Google Analytics and Google Ads share one `gtag.js`. No Tag Manager: its
  custom tags need `unsafe-eval`.
- Events: `add_to_cart`, `begin_checkout`, `purchase` (the server's order
  total, item ids and quantities, id `order-<id>`), `lead` for a cake
  request (`cake-<id>`). Each goes to Meta (standard names), Analytics
  (standard names), Ads (a conversion with the purchase or lead label) and
  Clarity (a custom event name only). No personal data, no Meta advanced
  matching, no Google enhanced conversions.
- Clarity: the cart dialog (checkout and order-done screen), the cake form
  and the cake request number carry `data-clarity-mask="true"`. The owner
  should also set masking to Strict in Clarity.
- The CSP adds only the origins of the tools that are on (`TRACKING_ORIGINS`
  in `server/index.js`), on those pages only. Admin and POS pages never load
  any of them.

## Staging site (2026-11-14)

- **Where:** `https://staging.sweeterside.ph`, Fly app `sweeterside-staging`,
  config `fly.staging.toml`, its own volume `sweeterside_staging_data`.
- **Guards (`STAGING=1`):** `X-Robots-Tag: noindex` on every response and
  a robots noindex tag on every page. `robots.txt` allows crawling, so
  search engines can see the noindex. No sitemap or llms.txt (404). Tracking
  off, a live PayMongo key refused, a STAGING badge on every page. Code in
  `server/staging.js`.
- **Data:** `scripts/staging-seed.js` copies the menu and set-up from live,
  and nothing about people. Staging has its own admin and staff PINs.
- **Tests:** `test/staging.test.js` (6).

## Utang: customers who pay later (2026-11-13)

Decided with the owner: utang is a sale on the day of the order; a cashier
can give it to customers on the owner's list, up to their limit (over it,
or adding someone new, needs the owner's PIN); they pay it back in any
amount, by any method.

- **The list** (`server/credit.js`, table `credit_accounts`): name,
  optional phone, optional limit, note, on/off. POS → **Utang**. Phones are
  masked in lists; the owner sees them in full on the account.
- **Charging:** payment method **Utang** on the pay screen, with a customer
  picker (`payments.credit_account_id`). The order is paid: in the sales,
  the shift sales and the ₱3M tracker that day. Not drawer cash. Can be
  split with cash. One customer per order.
- **Paying back** (`credit_collections`): from the customer's page in the
  Utang panel, any amount up to what they owe, any method. Cash goes into
  the drawer: the X/Z reading shows "Utang paid back (not sales)" and adds
  the cash to what is expected. A slip prints ("not a sales receipt"), and a
  statement on request.
- **The balance is never stored:** utang payments − utang refunds −
  collections. Deleting an order or a payment fixes it by itself. Refunds
  can go back to utang. A payment cannot be fixed to or from utang (delete
  it and take it again). Nothing may leave someone owing less than nothing.
- **Receipts** say who the utang is for and what they owe now in all.
- **Reports → Utang:** owed now, charged and paid back in the dates, who
  owes what, CSV (no phones).
- **Permissions:** `give_credit`, `collect_credit` (owner, cashier);
  `manage_credit`, `credit_over_limit` (owner). Audit actions
  `credit_account`, `credit_collect`, `credit_collection_delete` (ids only).
- Migration: new tables and two nullable columns; nothing existing changed.
- Also fixed: the pay screen showed the last order's payments on the next
  order's screen.
- **Owner to do after deploy:** POS → Utang → **+ Add customer** for each
  regular allowed utang, with a limit. Ask the accountant whether counting
  utang as a sale on the day suits the books.

## Custom items, Other payments, fixing entries (2026-11-11)

- POS **+ Custom item**: a line named and priced at the counter
  (`order_items.custom`, no item id, no stock); `custom_item` owner/cashier.
- Payment method **Other** (note required). The drawer already counted cash
  only.
- **Fix entries** (`server/corrections.js`): owner (`correct_entries`) or the
  owner's PIN fixes or deletes a payment or a cash in / out, with a reason,
  audited before/after. The order's paid state follows. A closed shift is
  recounted; `shifts.z_original` keeps the printed Z. Refunded orders are
  refused.

## Finished orders: today as cards, earlier as rows (2026-11-11)

- Orders → Finished: today's orders (Manila day they were placed) as cards;
  each earlier day under a heading, one line per order (number, name, time,
  type, total, Completed / Cancelled). A line opens into the full card, and
  stays open across the 20-second refresh. The To do queue is unchanged.

## GCash through PayMongo (2026-11-11)

- Optional GCash at online checkout (`server/paymongo.js`, hosted Checkout).
  Decisions: online checkout only, optional, GCash only; unpaid cancelled
  after 15 min; Other area cash only; refunds in the PayMongo dashboard.
- New order columns (additive): `pay_method`, `pay_status` (awaiting / paid /
  late), `pay_token`, `paymongo_session`, `paymongo_payment`,
  `online_paid_cents`, `online_paid_at`. Not in `payments` (not drawer cash).
- Off until `PAYMONGO_SECRET_KEY` is set and Settings switches it on. With
  test keys only a signed-in admin sees and can use it (`paymongo.offeredTo`);
  customers only with live keys.
  Webhook: `scripts/paymongo-webhook.js`, then `PAYMONGO_WEBHOOK_SECRET`.
- Owner to do: test keys → register webhook → switch on → a test GCash order
  with PayMongo's test flow; live keys after activation.
- Coming back from GCash after closing: the cart starts as closed (no Add
  buttons, no checkout) only for that return, so the customer still sees
  Paid with GCash, or that the order was not placed and the cart is kept.

## Sold out last (2026-11-11)

- Customer menu (`render.menuGroups`): in each category, sold out items come
  after the rest; otherwise the order is kept. Also the About page and
  llms.txt, which use the same groups. POS grid (`pos.posMenu`): sold out last.
  The admin Items page keeps the manual order.

## Tags: Must try and Trending (2026-11-11)

- Two more item tags beside Best seller, each its own tick box (`items.must_try`,
  `items.trending`, additive columns). Any mix; a badge each on the card,
  stacked; the popup lists them (`data-badges`). Only Best seller fills the
  top row. A save without the field keeps the tag.

## Delete test orders (2026-11-10)

- Orders page → **Delete…** on any order, owner name + PIN every time.
  Erases the order, its lines, payments and refunds (`orders.remove`), so
  reports, the open shift and customer history no longer see it. One
  `order_delete` audit line stays. Closed shifts keep their stored Z report.
  Counted items keep their count (`stock.keepCountsOnDelete`).
- Held POS tabs (saved, never sent) are left off the Orders page, so the
  POS ticket has its own **Delete…** on a held tab: the same route
  (`/api/orders/:id/delete`), the owner's PIN every time (2026-11-13).
- Fix (2026-11-13): a POS order paid at the counter without being sent to
  the kitchen was on no screen (the Orders page hid every never-sent POS
  order, the POS tabs hide paid ones), yet counted in the reports. Live
  #12 was one, with an SC/PWD discount. Such orders, and discarded tabs,
  now show under Finished (`HELD_DONE` in `server/orders.js`) and count as
  completed / cancelled; open tabs and merged-away tabs stay off.
- Live test order #12 was deleted by the owner on 2026-11-13 (v54), so it
  is out of the sales and SC/PWD reports.

## Inventory: stock counts and ingredients (2026-11-10)

- Counted items (baked goods): a stock take sets the count, batches add to
  it, orders take from it. At 0 the item is sold out online and at the POS.
  The count is derived (`server/stock.js`): last stock take + batches since
  − units handed over since − units on open orders. Handed over = completed
  or paid. A stock take stores how many units had been handed over in all
  (`stock_moves.handed`), so "since" is a difference, not a clock (a
  same-second payment was double-counted when comparing timestamps).
- Pre-orders for a later day hold units from the same count. A daily limit
  and a count together: the lower applies; "left" vs "left today".
- Ingredients (frappes): in stock or out, ticked per item. Any out = sold out.
  No quantities.
- Items page: In stock button per row (dialog: add a batch, stock take, stop
  counting); Ingredients section; ingredient tick boxes in the item editor.
- POS: Stock button (owner, cashier: `manage_stock`); sold-out tiles that
  the counter can fix are tappable. Waiters unchanged.
- New tables `stock_moves`, `ingredients`, `item_ingredients` (additive).
  Audit actions `stock_count`, `stock_add`, `stock_off`,
  `ingredient_change`.
- Owner to do after deploy: start counting the baked goods (Items → In
  stock), add the frappe ingredients and tick them on each frappe.

## Menu regroup (2026-11-04, live data, no PR)

Agreed with the owner, applied to the live database by a script run on the
Fly machine (`node /tmp/regroup-menu.js --apply`, through the app's own
modules and validation). Rehearsed first on a local copy of the live menu,
then a dry run on the live site. The owner ran the apply step.

- **Backup first:** `/data/app-backup-20261104-111345-before-menu-regroup.db`
  (`VACUUM INTO`). Restore it to undo the whole regroup.
- **Categories**, in this order (filter button in brackets):
  - Frappes (Frappes): was Frappe Based Drinks; 7 items.
  - Coffee & Matcha Lattes (Lattes): was Coffee Based Drinks; 7 items, with
    Matcha Latte moved in.
  - Whole Cakes (Whole Cakes): 1 item. Was Cakes; the owner renamed it after
    the regroup.
  - Pastries & Sweets (Pastries): was Breads and Pastries; 5 items.
  - Meals (Meals): was Foods; 5 items, with Burger moved in.
  - Sides (Sides): was Burger; Fries and Chicken Nuggets.
  - Matcha Drinks was emptied and removed. Slugs are unchanged.
- **One item with options instead of several** (option groups from PR C).
  The item kept is the original, so its photo, flags and sales history stay;
  prices give the same totals as before:
  - Matcha Latte (was Matcha Latte (Regular)), ₱139 + **Matcha grade**:
    Regular +0 / Premium +60.
  - Cinnamon Rolls Duo (was Cinnamon Rolls Double (Blueberr…), ₱165 +
    **Cinnamon roll pair**: Blueberry & Classic / Biscoff & Classic.
  - Chicken Franks Sandwich with fries, ₱130 + **Franks sandwich size**:
    Single +0 / Double +100.
  - Burger, ₱100 + **Make it a meal** (optional): Fries & nuggets +60.
- **Set Not available** (not deleted; past orders and reports keep them):
  Matcha Latte Premium, Cinnamon Rolls Double (Biscoff…), Chicken Franks
  Sandwich Double with Fries, Burger Only, Burger with fries and nuggets.
- **Renamed:** Caramel Machiatto → Caramel Macchiato.
- **Cart suggestions:** any order → Matcha Frappe; with Frappes or Lattes →
  Cinnamon Rolls Duo, Brownies, Macaroons; with Meals → Fries, Chicken
  Nuggets, Matcha Frappe.
- Checked on the live page: the six sections and filter buttons, the four
  items open their choices at the old prices, the hidden items are gone,
  the suggestions are set.
- **Left for the owner:**
  - The right names for "Korean Garlic" (Bread? Cream Cheese Bun?) and
    "Macaroons Small box (10pcs)" (macaroons or macarons?).
  - Three old empty categories, never shown to customers: Soda Drinks,
    Drinks and "Matcha Latte (Premium)". Delete them on Items →
    Categories (Claude Code was not allowed to write to the server).
- Note: the Fly machine suspends when idle (`auto_stop` in `fly.toml`), and
  `flyctl ssh console` then says "no started VMs". Any request wakes it in
  about a second; the site is not down.

## Features shipped

- Customer menu rendered from the database (works without JavaScript), with
  search, category filters and an item popup with photos.
- Admin with scrypt passwords, hashed session tokens, CSRF, login throttling
  and a strict CSP (no inline scripts).
- Cart and checkout: Delivery (cash on delivery, optional exact cash), Pick-up
  and Dine-in (table number). Prices recomputed by the server, stale totals
  refused, 5 orders per IP per 10 minutes. Confirmation screen with the
  lines, the time, tap to call and Facebook.
- Delivery areas with a fee and a usual time each, "Other area" with the fee
  to confirm, and an optional free-delivery threshold (#41).
- Item descriptions and sizes; option groups (sizes, add-ons) in the cart
  and the POS, priced on the server and kept on each order line (#42).
- "Goes well with" suggestions in the cart, counted on Reports (#43).
- Pre-orders: pick-up on a day and time, delivery ASAP or in a window, up to
  N days ahead; outside the hours the menu takes orders for later; daily
  limits by the scheduled day (#45).
- `/cakes`: gallery, size and price table, flavour extras with a live
  estimate, booking info; testimonials and a rating line on the menu and
  `/cakes` (#46).
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
- Dachel to name "Korean Garlic" and "Macaroons" properly, and delete the
  empty categories Soda Drinks, Drinks and "Matcha Latte (Premium)" (menu
  regroup above).
- Dachel to set the real opening hours on Settings (still 10:00–20:00).
- Owner notifications (Messenger / WhatsApp) were discussed and put on hold.
- Check the POS item photos on the counter iPad.
- SEO after #34 (owner):
  - **Google Business Profile:** primary category Café, plus Coffee shop,
    Cake shop and Bakery; website `https://sweeterside.ph`; the same hours,
    phone and address as the site; photos; reviews.
  - **Google Search Console:** add `sweeterside.ph`, submit
    `https://sweeterside.ph/sitemap.xml`, and request indexing of `/`,
    `/cakes` and `/about`.
  - Check `https://sweeterside.ph` and `/about` in Google's Rich Results
    Test.
  - Update the Facebook page website link.
  - Confirm the hours are the same every day, or say which days differ (the
    opening hours setting is one pair of times for every day).
  - For `/about`: the year the shop opened, a few lines about Dachel, best
    sellers, and shop and cake photos.
- After PR F (owner): Cakes → **Cake gallery** (photos of past cakes, with
  captions); check the **sizes and starting prices** and add flavour extras;
  read the **Price and deposit** and **Pick-up or delivery** wording; Settings
  → **Testimonials** (real quotes, with the customer's OK) and the optional
  **rating line**.
- After PR E (owner): Settings → Opening hours → **Pre-orders up to** (days
  ahead, default 3). Expect orders for tomorrow to arrive overnight.
- After PR D (owner): Settings → **Cart suggestions**: e.g. with drinks →
  brownies, cinnamon rolls; with pasta → fries; any order → a best-selling
  frappe.
- After PR C (owner): add descriptions and sizes (Menu health lists the
  items without). Make option groups (e.g. Size, Add-ons, Sugar level) and
  tick them on the items; rebuild "X only / X with Y" items as one item
  with an option, then turn the old ones off.
- After PR B (owner): Settings → **Delivery areas**: enter each area's fee
  and usual time. Until then delivery customers can only pick "Other area".
  Optionally set **Free delivery from**.
- After PR A (owner): Settings → **Order confirmation** (minutes, Facebook
  link) and **Share image** (1200 × 630); Staff → Receipts → **Currency on
  receipts** if the printer shows a box for ₱; add photos for the items listed
  under **Menu health**.
- Re-add the Home Screen app on the iPhone for the new icon (#37), then
  turn order alerts on again under Settings → Order alerts.
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
