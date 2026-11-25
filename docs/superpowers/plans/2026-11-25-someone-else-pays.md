# Someone Else Pays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer places a Delivery or Pick-up order that someone else pays by GCash or bank transfer through a link; the order reaches the kitchen only after the owner taps Payment received.

**Architecture:** The order is saved as now, with `pay_method = 'someone'` and `pay_status = 'awaiting'`, which already keeps it out of the queue and holds its stock. A new module `server/someone-pays.js` owns the payer token, the payer's reference, the owner's check and the auto-cancel. The payer page is server-rendered (`render.js`) with one small script; admin Orders gets a "Payment" tab.

**Tech Stack:** Node 22 built-ins only (`node:http`, `node:sqlite`, `node:crypto`, `node:test`), vanilla JS, strict CSP.

**Spec:** `docs/superpowers/specs/2026-11-25-someone-else-pays-design.md`

## Global Constraints

- Zero npm dependencies; no build step. Scripts in their own files (`script-src 'self'`).
- Money in integer centavos; the server recomputes everything.
- Manila time via `server/clock.js`; SQLite stores UTC.
- Migrations additive only (`addMissingColumns`), safe on live.
- Public endpoints: rate limit, body size limit, input validation, generic errors, constant-time token compare, no names/phones/addresses in logs. Add each route to the table in `claude/security-audit.md`.
- UI and comments: plain, short sentences in the house style.
- Every commit: `npm test` green, then `git checkout -- index.html`. CRLF files: edit with the Edit tool or a scratchpad script.
- The feature ships off: setting `someone_pays` defaults to `'0'`.

## Review Focus

1. Someone-pays orders never appear in the kitchen queue, the POS online list or the active count until Payment received (`IN_QUEUE`, `pos-online.js`, push alerts). Test in Task 1 and Task 3.
2. `paymongo.expireStale` must not cancel a someone-pays order after 15 minutes. Test in Task 1.
3. The payer page leaks no phone, address, landmark or last name, and the receiver's `/order/<ref>` link cannot open `/pay/` (and the reverse). Test in Task 2.
4. Turning the switch off hides the choice at checkout but a waiting order's pay link still works. Test in Task 2.
5. A double tap on Payment received records once and announces once (transaction + status guard). Test in Task 3.

---

### Task 1: Order model, settings and checkout rules (server)

**Files:**
- Create: `server/someone-pays.js`
- Modify: `server/db.js` (after the PayMongo block, ~line 731), `server/orders.js` (`create` ~703-810, `settings`/`updateSettings` ~407-450, `IN_QUEUE` ~916), `server/paymongo.js` (`expireStale` ~224), `server/payments.js:109`
- Test: `test/someone-pays.test.js` (new)

**Interfaces:**
- Produces (db): `orders` columns `payer_token TEXT`, `payer_method TEXT NOT NULL DEFAULT ''` (`'gcash'|'bank'`), `payer_reference TEXT NOT NULL DEFAULT ''`, `payer_name TEXT NOT NULL DEFAULT ''`, `payer_sent_at TEXT`, `payer_checked INTEGER NOT NULL DEFAULT 0` (1 after Not received: no auto-cancel). Index on `pay_status` already covers `'awaiting'`; add `'checking'` to it (`WHERE pay_status IN ('awaiting','checking')`, new index name `idx_orders_pay_wait`).
- Produces (`server/someone-pays.js`): `LEAD_HOURS = 3`, `CUTOFF_MINUTES = 60`, `MAX_WAIT_HOURS = 24`, `REFERENCE_MAX` (reuse from `payments.js`), `offered(): boolean` (switch on and at least one of GCash number or bank details set), `details(): { gcash_name, gcash_number, bank_details, qr_gcash, qr_bank }`, `newToken(): string` (same shape as `paymongo.newPayToken`).
- Produces (settings keys, in `settings()` and `updateSettings()`): `someone_pays` (switch), `pay_gcash_name` (≤60), `pay_gcash_number` (PH mobile, reuse the phone check), `pay_bank_details` (≤300, may be multi-line), `pay_qr_gcash`, `pay_qr_bank` (upload paths, parsed like `parseShareImage`). `settings()` also returns `someone_pays_ready: offered()`.
- Produces (`orders.create`): accepts `input.pay === 'someone'`.

- [ ] **Step 1: Write failing tests** in `test/someone-pays.test.js` (use the setup of `test/made-to-order.test.js` / `test/server.test.js`):
  - `'someone pays: refused while the switch is off'` → `errors.pay` set.
  - `'someone pays: dine-in refused'`, `'someone pays: Other area refused'` → `errors.pay`.
  - `'someone pays: ASAP and times under 3 hours refused'` → the same error `checkMade` gives for a lead (assert on `errors` key the schedule uses).
  - `'someone pays: saved as awaiting with its own payer token'` → `pay_method === 'someone'`, `pay_status === 'awaiting'`, `payer_token` 32 chars and `!== pay_token`, `cash_cents === 0`.
  - `'someone pays: not in the active list or count'` → `orders.list('active')` excludes it (also with `pay_status = 'checking'`).
  - `'someone pays: stock is held while waiting'` → remaining count drops by the qty.
  - `'someone pays: the 15-minute GCash sweep leaves it alone'` → `await paymongo.expireStale(<now + 60 min>)`, order still `awaiting`.
- [ ] **Step 2: Run** `node --test test/someone-pays.test.js` → FAIL.
- [ ] **Step 3: Implement.**
  - `db.js`: the columns and index above, with a short block comment like the PayMongo one.
  - `orders.create`: `pay` accepts `'someone'`; when chosen, refuse unless `someonePays.offered()`, `type` is delivery or pickup, and the area is not `to_confirm` (`'For "Other area" we call you with the fee first, so someone else cannot pay online.'`). Enforce the lead by calling `schedule.checkMade(type, when, Math.max(q.madeHours || 0, LEAD_HOURS), now)`: the cart already handles a lead the same way. Insert `pay_method 'someone'`, `pay_status 'awaiting'`, `cash 0`, `payer_token newToken()`.
  - `IN_QUEUE`: `pay_status NOT IN ('awaiting','checking')`.
  - `paymongo.expireStale`: add `AND pay_method = 'gcash'` to its query.
  - `payments.js:109`: also refuse `'checking'`; for `pay_method 'someone'` the message is `'Someone else is paying this order. Check the payment in Orders.'`.
- [ ] **Step 4: Run** `npm test` → all PASS.
- [ ] **Step 5: Commit** `Someone else pays: the order waits for payment`.

### Task 2: Payer page and reference (public)

**Files:**
- Modify: `server/someone-pays.js`, `server/render.js` (new `buildPayHtml`), `server/index.js` (routes, limiter), `claude/security-audit.md`
- Create: `assets/js/pay.js`
- Test: `test/someone-pays.test.js`

**Interfaces:**
- Consumes: Task 1 columns and `details()`.
- Produces: `payerRef(id): string` (`"<id>.<payer_token>"` or `''`), `byPayerRef(ref): order|null` (same regex and `timingSafeEqual` as `orders.byRef`, `pay_method = 'someone'`), `submitReference(ref, { method, reference, name }): order` (throws `ValidationError`; sets `pay_status 'checking'`, `payer_*`, `payer_sent_at`; refuses with 409 when already `checking`, `paid` or cancelled), `onReference(fn)` listener (Task 3 hangs the SMS on it).
- Routes: `GET /pay/<ref>` → `render.buildPayHtml(publicPayOrder, details(), state)` with the `/order/` headers (`noindex`, `no-referrer`), own limiter (60 per 10 min per IP). `POST /api/pay/reference` JSON `{ ref, method, reference, name }`, `isJson`, `readJson` with the usual small limit, limiter 10 per 10 min per IP.
- `publicPayOrder`: lines (name, options, qty, line total), totals, `order_type`, Manila date and time, receiver first name only (first word of `customer_name`), `pay_status`, `status`. Nothing else.

- [ ] **Step 1: Write failing tests:**
  - `'payer page: wrong token, receiver token, or GCash order → 404'`.
  - `'payer page: shows items, total, first name and QR; no phone, address, landmark or last name'` (assert the HTML includes the total string and excludes each of those values).
  - `'payer page: still opens after the switch is turned off'`.
  - `'reference: saved once, method gcash|bank, reference 4..REFERENCE_MAX chars, name ≤60'` and `'reference: a second one while checking → 409'`, `'reference: cancelled order → 409'`.
  - `'receiver /order/ link cannot open with the payer token'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Page content, top to bottom: "Pay for <first name>'s order", items, total (large), Delivery or Pick-up with date and time, then for each method set in Settings: QR image (if any) with a "Save QR" link (`<a href download>`), name and number / bank details, the line "Scan or send exactly ₱<total>.", then the form (method radio, reference, optional "Your name", button "I've paid"). States: `checking` → "Thanks. We're checking your payment and will start the order."; `paid` → "Paid. The order is being prepared."; cancelled → "This order was cancelled. Please contact us." `pay.js` posts the form with `fetch` and swaps in the thank-you text; works without it as no-op (form has no action). Escape every value (`render.js` `esc`).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `Someone else pays: the payer page`. Add both routes to `claude/security-audit.md`.

### Task 3: Owner check, alerts and auto-cancel

**Files:**
- Modify: `server/someone-pays.js`, `server/orders.js` (`list`), `server/index.js` (routes, `announce`, sweep), `server/audit.js` use, `admin/orders.js`, `admin/index.html` (the tab), `admin/pos-online.js` and `admin/orders.js` paid labels
- Test: `test/someone-pays.test.js`

**Interfaces:**
- Consumes: Task 2 `onReference`.
- Produces: `received(id, actor): 'paid'|'already'` (transaction; only from `checking`; sets `pay_status 'paid'`, `online_paid_cents = total_cents`, `online_paid_at`, and `status 'confirmed'` when it is `'new'`; audit `someone_paid` with method and reference), `notReceived(id, actor)` (only from `checking`; back to `awaiting`, clears `payer_reference`/`payer_method`/`payer_sent_at`, `payer_checked = 1`; audit `someone_not_paid`), `expireUnpaid(now = new Date()): number` (cancels `pay_method 'someone' AND pay_status 'awaiting' AND payer_checked = 0` orders that are 24 h old or within 60 min of `scheduled_for`; `cancel_reason 'unpaid'`, `pay_status ''`), `orders.list('payment')` (`pay_method = 'someone' AND pay_status IN ('awaiting','checking') AND status <> 'cancelled'`, oldest first).
- Routes (admin session + CSRF, like the other order actions): `POST /api/orders/<id>/payment-received`, `POST /api/orders/<id>/payment-not-received`; `GET /api/orders?show=payment`.

- [ ] **Step 1: Write failing tests:**
  - `'received: order enters the queue confirmed, paid, once'` (call twice → second `'already'`; `list('active')` includes it once; push stub called once).
  - `'received: refused while awaiting (no reference)'`.
  - `'not received: back to waiting, reference cleared, never auto-cancelled'`.
  - `'auto-cancel: 24 h with no reference; 60 min before its time; not while checking'` (frozen `now`; stock freed).
  - `'alerts: nothing on placing; owner SMS on reference (no name/phone in it); push + receiver text on received, no second owner SMS'` (stub `sms.setTransport` and push).
  - `'routes: payment-received needs the admin session and CSRF'` (401 / 403).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `index.js`: the order POST skips `announce` for `pay_method 'someone'` and returns `status_url` plus `pay_url: siteUrl(req) + '/pay/' + payerRef(id)`; `someonePays.onReference` → `sms.alert({ title: 'Check payment', body: '#<id> P<total> <GCash|Bank> ref <reference>' })`; on received → `push.alert(push.orderMessage(order))` and `sms.confirmCustomer(order, { willCall: false })`; add `someonePays.expireUnpaid()` to the existing one-minute interval. Admin Orders: a "Payment" tab (`data-show="payment"`) listing each order with total, time, method, reference and payer name, and buttons "Payment received" / "Not received" (cancel stays where it is). Paid labels: "Paid by GCash" / "Paid by bank" from `payer_method` for `pay_method 'someone'`, else today's text.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `Someone else pays: the owner's check`. Add the routes to `claude/security-audit.md`.

### Task 4: Checkout, status page and Settings (browser)

**Files:**
- Modify: `templates/menu.html` (pay radios ~220), `assets/js/cart.js` (`payMethod` ~823, `renderPay` ~830, `slotsOn`/`madeMinutes`, done screen ~1069-1110, submit ~1150), `server/render.js` (`customerStatus` ~572 and the menu's `data-` flags), `admin/settings.html`, `admin/settings.js`
- Test: `test/someone-pays.test.js` (source checks, like `test/menu-cart-polish.test.js`)

**Interfaces:**
- Consumes: `someone_pays_ready` (render it as `data-someone="1"` on `#pay`), the order POST's `pay_url`.

- [ ] **Step 1: Write failing tests:**
  - `'checkout offers "Someone else will pay" only when ready, not for dine-in or Other area'` (template has the radio with `value="someone"`; `renderPay` hides it for those).
  - `'someone pays: slots start 3 hours ahead'` (cart's lead uses `Math.max(madeMinutes(), 180)` when chosen; no ASAP).
  - `'done screen shares the pay link'` (cart.js uses `navigator.share` with a Copy fallback and `textContent`).
  - `'status page: waiting for payment, payment being checked'` (`customerStatus` returns `'Waiting for the payment from the person you sent the link to.'` and `'We are checking the payment.'`).
  - `'settings: switch, GCash name and number, bank details, two QR uploads'` (ids `someone-pays-on`, `pay-gcash-name`, `pay-gcash-number`, `pay-bank-details`, `pay-qr-gcash-file`, `pay-qr-bank-file`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Radio label "Someone else will pay"; note under it: "We'll give you a link to send them. Your order starts once their payment is confirmed." The Place order label reads "Send order · ₱X". Done screen: heading "Send this link to the person paying", Share button, Copy button, then the status link as today. Settings: a "Someone else pays" card copying the SMS card's layout and the share-image upload flow (`/api/upload` then PUT the path).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `Someone else pays: checkout and settings`.

### Task 5: Docs, review, staging

- [ ] Update `claude/dev-status.md` (feature section, test counts) and tick nothing in `claude/todo.md` unless listed.
- [ ] Run `/code-review` and `/security-review` on the branch; fix real findings with tests.
- [ ] `gh pr create`; deploy the branch to staging (`--config fly.staging.toml`), check `/healthz`, `flyctl status`, logs.
- [ ] On staging, with the switch on: place a someone-pays pick-up order, open the pay link on a phone width, save the QR, submit a reference, see the SMS, tap Payment received, see it in the queue. Then tell the user what to try. Do not merge until they say "merge".
