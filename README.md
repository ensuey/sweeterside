# sweeterside

Online menu for **Sweeter Side by Dachel**, plus a password-protected admin
dashboard for adding, editing and deleting menu items and categories.

Customers browse a fast page with search and category filters, add items to a
cart and place a cash-on-delivery order. Dachel signs in at `/admin` to see
incoming orders and edit the menu; the customer page updates immediately.

## Requirements

**Node.js 22.5 or newer** — the server uses the built-in `node:sqlite` module.
Check with `node --version`.

There are **no dependencies**. Nothing to `npm install`.

## Running it

```bash
npm run create-admin      # once — creates your sign-in account
npm start                 # http://127.0.0.1:3000
```

- Menu:  <http://127.0.0.1:3000/>
- Custom cake booking: <http://127.0.0.1:3000/cakes>
- Admin, orders: <http://127.0.0.1:3000/admin>
- Admin, items:  <http://127.0.0.1:3000/admin/items>
- Admin, vouchers: <http://127.0.0.1:3000/admin/vouchers>
- Admin, cakes: <http://127.0.0.1:3000/admin/cakes>
- Admin, blocked numbers: <http://127.0.0.1:3000/admin/blocked>

`npm test` runs the test suite (103 tests covering password hashing, CSRF,
validation, path containment, categories, orders, item stock, promotions,
cake bookings, fake-order protection, the pricing engine, staff PINs, the
audit log and the database migrations).

### Changing the admin password

Run `npm run create-admin` again with the same email. It resets the password
and signs out every existing session.

## Project layout

```
server/
  index.js       HTTP server, routing, static files, uploads
  db.js          SQLite schema and the first-run seed
  auth.js        scrypt hashing, sessions, CSRF, login throttling
  menu.js        item validation, CRUD, availability, daily limits, sale prices
  categories.js  category validation, CRUD and ordering
  orders.js      orders, order types and their settings
  pricing.js     the pricing engine (pure): sale, SC/PWD, vouchers, discounts, service charge
  settings.js    the settings table, and the POS and tax settings
  staff.js       staff, roles, PINs, staff sessions and manager overrides
  audit.js       the append-only audit log
  vouchers.js    voucher codes: validation, CRUD and checking a code
  cakes.js       custom cake bookings: settings, open days, photos, requests
  phone.js       PH mobile numbers: checking and normalising to +639XXXXXXXXX
  checkout.js    signed checkout tokens (the minimum fill time)
  blocklist.js   blocked phone numbers
  clock.js       Manila time: pick-up slots, daily limits, voucher and cake dates
  render.js      builds the customer pages (menu, cakes) from the database
  imagesize.js   reads JPEG/PNG/WebP dimensions (also the upload sniffer)
admin/
  common.js      shared by every page: API calls, toasts, sign-in, sign-out
  index.html     Orders page (orders.js): the queue and ordering settings
  items.html     Items page (items.js): items, stock, promotions, categories
  vouchers.html  Vouchers page (vouchers.js): voucher codes
  cakes.html     Cakes page (cakes.js): cake bookings and booking settings
  blocked.html   Blocked numbers page (blocked.js)
  login.html     sign-in page
templates/
  menu.html      customer page shell; the server fills in the items
  cakes.html     custom cake booking page; the server fills in sizes and days
test/            test suite
data/            SQLite database (gitignored, created on first run)
assets/          images, customer CSS and JS; uploads/ is gitignored
index.html       generated — see below
```

## How the data flows

The database is the single source of truth. `templates/menu.html` holds the page
shell with a `<!--SECTIONS-->` placeholder, and the server renders the items into
it on every request.

Items are rendered as **real markup**, not fetched by JavaScript, so the menu
still works with JavaScript disabled. The customer-side script only adds search,
filtering and the detail popup.

**`index.html` is generated.** The server rewrites it after every admin change,
so the repository always holds a current, fully static copy of the menu. Edit
items in the admin, not in `index.html` — your edits there will be overwritten.
Run `npm run build` to regenerate it by hand.

This means you can still deploy the folder as a static site (GitHub Pages and
similar) and get a correct menu; you just will not have the admin there, because
static hosting cannot run the server.

## How ordering works

### Open and closed

The **Shop** switch at the top of the admin Orders page turns ordering on and
off. The top bar of every admin page shows "Shop open" or "Shop closed".

- **Open** (the default): the menu header says "Open now" and customers can
  order.
- **Closed**: the menu header says "Closed" with Dachel's optional note, e.g.
  "Back tomorrow at 10 AM", or a default line. Customers can browse the menu,
  but there are no Add buttons and no cart. Anything already in their cart is
  kept for when the shop opens again. The server refuses orders and voucher
  checks while closed, so a page left open from earlier cannot order either;
  the customer is shown the closed message instead.
- **Custom cake bookings are not affected**: `/cakes` takes requests whether
  the shop is open or closed.

### The cart

Each card has an **Add** button. The cart is kept in the customer's browser,
so it survives a reload. At checkout the customer chooses how they want it,
and only that type's fields are shown. Every field shown is required.

| Type | The customer gives | Pays |
|---|---|---|
| **Delivery** | name, phone, address, landmark / directions, cash they will pay with | cash on arrival, plus the delivery fee |
| **Pick-up** | name, phone, pick-up time today | at the counter, no fee |
| **Dine-in** | name, table number | at the counter, no fee |

Pick-up times are "As soon as possible" or 15-minute slots, at least 15
minutes ahead, within the pick-up hours. Times are always Manila time
(UTC+8), whatever the customer's phone is set to. Once no slot is left today,
pick-up is hidden with "Pick-up is closed for today."

Once the order is placed, the customer sees the order number and total, plus
their cash and change for delivery, the pick-up time, or the table it will
be brought to.

Orders appear at the top of the admin, oldest first, with a badge for the
type (and pick-up time or table). The page checks for new ones every 20
seconds and shows the count in the tab title. Move each order through
**New → Confirmed → Preparing → Out for delivery / Ready for pick-up /
Served → Completed** (or **Cancelled**).

Next to the orders list the admin sets:

- **Taking orders for**: turn Delivery, Pick-up or Dine-in on or off. A type
  that is off disappears from checkout, and the server refuses it. With all
  three off the cart says online ordering is closed.
- **Delivery fee**: charged on delivery orders only.
- **Pick-up from / until**: the pick-up hours, on the quarter hour.

All apply to the menu straight away. Orders placed before order types existed
are kept as delivery orders.

What the server does not trust:

- **Prices.** The browser sends only item ids and quantities. Prices, the fee
  and the total are recomputed from the database.
- **A stale page.** The browser also sends the total the customer saw. If the
  menu or the fee changed since, the order is refused with the new prices, and
  the cart updates so the customer can check before placing it again.
- **Volume.** Each IP address can place 5 orders per 10 minutes. The endpoint
  only accepts JSON, so a form on another site cannot post to it.

### Fake orders

Every check below is made by the server; the cart only repeats some of them
so the customer sees the problem straight away.

- **Phone numbers** must be PH mobiles: `09XXXXXXXXX`, `+639XXXXXXXXX` or
  `639XXXXXXXXX`, with spaces, dashes or brackets. Each is also stored as
  `+639XXXXXXXXX`, so one customer matches however they typed it. The same
  rule applies on `/cakes`. Dine-in takes no phone.
- **Delivery needs a landmark** ("beside 7-Eleven, green gate"), 5 to 200
  characters. It shows under the address on the order.
- **A hidden honeypot field.** People never see it; bots that fill every
  field do, and the order is refused with a generic message.
- **A minimum fill time.** When the cart opens it fetches a signed token
  (HMAC-SHA256 of the time it was issued). An order is refused if the token is
  missing, forged, over 2 hours old or under 3 seconds old. The cart waits out
  the 3 seconds itself and fetches a new token when one expires, so real
  customers never notice.
- **Orders in progress per number**: at most 3 (a setting) orders that are not
  Completed or Cancelled. More get "You already have orders in progress.
  Please wait for them to finish or call us."
- **Blocked numbers** cannot order or book a cake. They are told "We couldn't
  place this order online. Please call or message us.", never that they are
  blocked.

Refused orders and bookings are logged as `[rejected] order <code>` with one
of `honeypot`, `too_fast`, `bad_token`, `invalid_phone`, `too_many_open`
or `blocked`. No names, numbers or addresses are logged.

On the admin Orders page:

- **Confirmed.** New delivery and pick-up orders must be confirmed (call the
  customer, tap **Confirm**) before they can be moved to Preparing. Dine-in
  can go straight to Preparing. The **Call to confirm before preparing**
  switches change this per order type. A New order still waiting after 10
  minutes shows **Waiting N min**, updated with every 20-second check.
- **Cancel reasons.** Cancelling asks why: Customer cancelled, No-show /
  unreachable, Fake order or Other.
- **Customer history.** Each order shows the number's other orders: "First
  order", or e.g. "5 completed · 1 no-show" (no-shows and fakes are counted
  from the cancel reasons).
- **Trusted customers** (off by default): with **Confirm their orders
  automatically** on, a number with at least 3 completed orders and no
  no-shows or fakes (both settings) skips straight to Confirmed.
- **Block this number** on an order asks for a reason and can cancel that
  order as a fake at the same time. The **Blocked** page lists blocked
  numbers, adds one by hand and unblocks.

Ordering needs the server running. On static hosting the menu still shows,
but placing an order fails with a connection message.

## In-store POS

The cashier and waiter POS is being built in four phases; the plan is in
`claude/pos-plan.md`. Phase 1 (the money, the pricing engine, staff and the
audit log) is server-side only and changes nothing on screen.

### Money

- **Centavos.** Every order amount is stored as whole centavos (`*_cents`
  columns); the migration multiplied the older peso amounts by 100.
- **Pesos where they are typed.** Menu prices, sale values and voucher values
  are still whole pesos.
- **The checkout is unchanged.** It still receives and shows pesos, and an
  order read back still has its peso fields (`total` etc.).

### The pricing engine

The checkout and the POS share one engine, `server/pricing.js`. It works in
this order:

1. the line price (regular, sale, or a manager-approved override);
2. SC/PWD;
3. a voucher **or** a manual discount;
4. the service charge;
5. the delivery fee.

The full breakdown is saved with each order. Rounding is half-up and happens
only at the points listed at the top of `server/pricing.js`.

**SC/PWD:**
- 20% off the claimant's portion. The shop is **non-VAT registered**, so there
  is no VAT exemption line.
- A claimant's portion is either the items that are theirs, or their share of
  a shared order (shared items ÷ diners).
- There can be several claimants on one order.
- **No stacking:** the portion gets either SC/PWD on the regular price, or the
  sale price and voucher, whichever is cheaper for the customer. The receipt
  says which (`SC_PWD_POLICY`).
- Items can be excluded with **Eligible for SC/PWD** (on by default).

**Discounts and charges:**
- **Manual discounts** need a reason. Above the cashier limit (10% by default)
  they need the owner's PIN. They cannot be used with a voucher.
- **Service charge** is off by default. When on, it is 10% for dine-in,
  charged on the amount after discounts, at the counter only (online orders
  never get it). It is reported apart from sales.
- **The delivery fee** can be changed for one order, with a reason.

### Tax status

Sweeter Side is **non-VAT registered** (8% income tax option), and the
migration sets `vat_registered` to off.
- The VAT-registered SC/PWD maths is kept and tested, so switching later is a
  setting, not a code change. Confirm with your accountant before changing it.
- If the setting is ever missing, the POS refuses SC/PWD discounts.
- The 8% is income tax. It is never added to an order or a receipt.

### Staff, PINs and overrides

**Roles:**
- **Owner:** everything.
- **Cashier:** takes orders and payments, and gives discounts up to the limit.
- **Waiter:** dine-in orders and sending to the kitchen only.

**PINs and the tablet:**
- The counter tablet stays signed in as the admin. Each person taps their name
  and types their 4–6 digit PIN.
- PINs are scrypt-hashed. Easy ones like 1111 or 1234 are refused.
- Five wrong PINs lock that person out for 5 minutes.
- The POS locks itself after 5 minutes idle (a setting).

**Overrides:** anything above a role's limit (voids, refunds, price changes,
larger discounts) needs an owner to type their PIN on the screen.

**Audit log:** every void, refund, override, discount, drawer movement, shift
and staff change is written to it. The log is append-only: the database
refuses edits and deletions.

SC/PWD ID numbers are personal data. Lists mask them (`****1234`); only the
owner and cashier screens show them in full.

## Items page: availability and daily limits

The admin has two pages, **Orders** and **Items**, linked from the top bar.
On the Items page each item row has two controls that save as soon as they
change:

| Availability | On the customer menu |
|---|---|
| **Available** | shown and can be ordered |
| **Not available** | hidden, e.g. seasonal or off the menu for now |
| **Sold out** | shown greyed with a "Sold out" badge, cannot be added |

A manual **Sold out** stays until it is changed back.

**Max per day** is how many of the item can be ordered in a day, for
capacity or stock. Leave it blank for no limit. The count is the quantity on
today's orders, in Manila time, not counting cancelled ones, so cancelling an
order gives its quantity back. When the limit is used up the item reads as
sold out for the rest of the day, and comes back by itself at midnight. Each
row shows today's count, e.g. "7 / 20 sold today".

Customers see "Only 3 left today" once 5 or fewer are left. The cart will not
go past what is left, and the server checks again when the order is placed,
so two customers cannot both take the last one: the second is told how many
are left and their cart is cut down to that.

## Promotions: best sellers, sale prices and vouchers

**Best seller and sale price** are set in the item editor on the Items page,
under *Promotion*:

- **Best seller** puts a "★ Best seller" badge on the menu card and in the
  item popup.
- **Sale** is a % off (1 to 90) or a Php amount off (less than the full
  price). The menu shows the full price struck through next to the sale
  price, and the cart and the order charge the sale price. The full price is
  kept, so ending the sale is just choosing *No sale*.

**Vouchers** are codes customers type in the cart, managed on the Vouchers
page. In the cart the code box sits just above **Place order** and only opens
when the customer ticks *I have a voucher code*.


- Each code takes either a **% of the items** (optionally capped at a Php
  amount) or a **Php amount** off. A voucher never takes anything off the
  delivery fee, and never more than the items cost.
- Optional **first and last days**, in Manila time, both days included. The
  page shows each code as Active, Scheduled, Expired or Off.
- An **On** switch turns a code off without deleting it. Deleting a code that
  was used is fine: past orders keep the code and their discount.
- Codes ignore case. The page counts how many orders used each code, not
  counting cancelled ones.

The server works out every discount itself. The cart asks it what a code
takes off (`/api/vouchers/check`, limited to 20 checks per IP address every
10 minutes so codes cannot be guessed), and checks again when the order is
placed. If the code stopped working in between, for example it was turned off,
the order is refused, the code is dropped and the customer sees the new total.
Order cards in the admin show the code used and the discount.

## Custom cake bookings

Customers book a custom cake at **`/cakes`**, linked from the menu's header
and footer. They choose:

- a **size**, shown with its starting price ("from Php 1,200")
- a **flavour**, or "Other" and say which in the notes
- an optional occasion, message on the cake, design notes and one
  **reference photo** (JPEG, PNG or WebP, up to 5 MB)
- the **day** they need it, and **pick-up or delivery** (with an address)
- their name and phone

Nothing is charged online. The request lands on the admin **Cakes** page, and
the nav shows how many are new on every admin page. Dachel calls the
customer, then records on the booking:

- the **status**: New request → Price quoted → Confirmed → Completed, or Declined
- the **price quoted**, needed before Quoted, Confirmed or Completed
- **deposit received** and its amount, which can't be more than the price
- a private **note**

**Which days can be booked** is set under *Booking settings* on the same page:

- **Days of notice**, e.g. 3: the earliest day is today plus 3, in Manila time.
  Bookings are taken up to 90 days after that.
- **Cakes per day**, e.g. 2: once a day has that many bookings (not counting
  declined ones) it can't be picked. Blank means no limit. The server checks
  again when the request is sent, so two people can't take the last slot.
- **Sizes and starting prices**, one per line as `Name | price`, and
  **flavours**, one per line.

**Reference photos are private.** They are stored in `/data/cake-photos` on
the volume, never under `/assets`, and only a signed-in admin can open them.
Photos uploaded for a request that was never sent are deleted after a day.
The public endpoints are rate-limited: 5 photos and 3 requests per IP address
every 10 minutes.

## How the photos work

The original two menu posters (1021×1434) double as sprite sheets. An item can
either show a **crop window** onto a poster:

```html
<div class="shot" style="--x:113; --y:530; --w:184; --h:245">
```

…or show a **whole photo** (`.shot--plain`, `object-fit: cover`) when no crop is
set. Uploading a new photo through the admin gives you the second kind; leave
the crop fields blank.

The admin's crop fields show the photo's pixel dimensions and render a live card
preview, and the server rejects any crop that falls outside the image.

## Security

The login is real, not decorative:

- **Passwords** hashed with scrypt (N=16384), unique 16-byte salt each,
  compared in constant time. Never stored or logged in plain text.
- **Sessions** are 32 bytes of CSPRNG randomness in an `HttpOnly`,
  `SameSite=Strict` cookie, expiring after 8 hours. Only the SHA-256 of the
  token is stored, so a database leak does not yield usable cookies.
- **CSRF**: every write requires an `X-CSRF-Token` header matching the session.
- **Throttling**: 6 failed attempts per email+IP triggers a 15-minute lockout.
  Wrong password and unknown account return the same message and take
  comparable time, so the form does not reveal which emails exist.
- **Uploads** are accepted only if their *bytes* parse as JPEG, PNG or WebP —
  the filename and declared type are ignored. Files are saved under a
  server-generated random name, capped at 5MB.
- **Paths**: item images must resolve inside `assets/`; static serving is
  containment-checked, and the admin HTML cannot be fetched as a static file.
- **Headers**: CSP (no inline scripts), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.

Cookies are marked `Secure` automatically behind an HTTPS proxy
(`X-Forwarded-Proto: https`), or set `FORCE_SECURE_COOKIES=1`.

## Deploying

The admin needs a host that **runs Node and gives you a persistent disk**.
Static hosting (GitHub Pages, Netlify drop) can serve the customer menu but
cannot run the admin at all.

A `Dockerfile` is included and works on Fly.io, Railway, Render or any VPS.

### The one thing that will bite you

The SQLite database, uploaded photos and cake reference photos live in
`/data`. **Mount a volume there.** Containers get a fresh filesystem on every deploy, so without a volume
the menu silently resets to the nine seeded items and uploaded photos vanish.

Also keep it to **exactly one machine**. SQLite allows one writer; two
instances sharing a volume will corrupt it.

### Fly.io (cheapest with a real volume)

`fly.toml` is already configured — the volume mount, HTTPS, the `/healthz`
check and secure cookies. You need a Fly account with a card on file (the
volume is roughly $0.15/GB/month; a 1GB volume is plenty).

```bash
# 1. Install flyctl, then sign in
fly auth login

# 2. Create the app. Pick your own name and put it in fly.toml.
fly apps create sweeterside

# 3. Create the volume — same region as primary_region in fly.toml
fly volumes create sweeterside_data --size 1 --region sin

# 4. Deploy
fly deploy

# 5. Create your admin account on the running machine
fly ssh console -C "node scripts/create-admin.js --email you@example.com"
```

Your menu is then at `https://<app>.fly.dev/` and the admin at
`https://<app>.fly.dev/admin`.

### Other hosts

- **Railway** — add a volume mounted at `/data`, set the same env vars as
  `fly.toml`, deploy from the Dockerfile.
- **Render** — a persistent disk requires a paid instance. The free tier has an
  ephemeral filesystem and will lose the database on every restart.
- **VPS** — run the container behind Caddy or nginx for TLS, and bind-mount a
  host directory to `/data`.

### Before putting this on the internet

1. **Serve it over HTTPS.** The server speaks plain HTTP; the host or proxy
   terminates TLS. Without HTTPS the session cookie crosses the network in the
   clear. Fly does this for you and `fly.toml` sets `FORCE_SECURE_COOKIES=1`.
2. It binds to `127.0.0.1` by default. `HOST=0.0.0.0` (set in the Dockerfile)
   exposes it — only do that behind the proxy above.
3. **Back up the volume.** `/data/app.db` holds the menu and the admin account.
   `fly ssh sftp get /data/app.db` pulls a copy down.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to bind |
| `DB_PATH` | `data/app.db` | SQLite file location |
| `DATA_DIR` | `data/` | Directory holding the database |
| `UPLOAD_DIR` | `assets/uploads/` | Where uploaded photos are written |
| `FORCE_SECURE_COOKIES` | unset | Set to `1` to always mark cookies `Secure` |
| `ADMIN_PASSWORD` | unset | Skips the prompt in `create-admin` |
| `CHECKOUT_SECRET` | generated | Key that signs checkout tokens. If unset, one is generated on first use and kept in the database |

## Still to fill in

- **No contact details, address, hours or ordering link.** The footer is a stub.
  A menu customers find online usually needs a way to order — add it to the
  `<footer class="foot">` block in `templates/menu.html`.
- **No item descriptions.** Names and prices only, taken from the posters.
  Descriptions were left out rather than invented, since they imply ingredient
  and allergen claims.
