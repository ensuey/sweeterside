# Someone else pays: design

## Why

Family abroad, or anyone not in San Isidro, wants to buy for someone they love
here. The person here knows what they want; the person paying is far away.
So the person here builds the order and sends a link; the payer pays by GCash
or bank transfer and gives the reference number. Nothing is made until the
owner has seen the money arrive.

## What it does

1. **Customer (the receiver)** uses the normal menu and cart. At checkout,
   under how to pay, a new choice: **"Someone else will pay"**. Only for
   Delivery and Pick-up (not Dine-in). They fill in their own details as
   usual and send the order.
2. The order is saved but **waits for payment**: out of the kitchen queue,
   like an online GCash order waiting today. Its stock and time slot are held.
   The order-done screen shows the **pay link** with a Share button
   (`navigator.share`, falling back to Copy) and a line: "Send this to the
   person paying. We start your order once their payment is confirmed."
3. **Payer** opens `/pay/<pay_token>`. They see: the items and options, the
   total, Delivery or Pick-up with the date and time, the receiver's first
   name, and the shop's GCash and bank details (from Settings). They choose
   GCash or Bank transfer, enter the reference number, optionally their own
   name, and submit. The page then says "Thank you. We'll confirm your
   payment and start the order."
4. **Owner** gets a text (existing SMS alert, on the same switch): an order is
   waiting for payment check, with the order number, total and method. In
   admin Orders the order shows "Check payment" with the method and reference.
   - **Payment received**: records a payment (method `gcash`, or `other`
     with "Bank transfer" in the reference) with the reference, marks the
     order paid, and it goes into the kitchen queue like any new order.
   - **Not received**: clears the reference so the payer can enter it again
     (the link still works); the order keeps waiting.
   - **Cancel**: the existing cancel.
5. The receiver's order status page says which step it is at: waiting for
   payment, payment being checked, then the usual statuses.

## Waiting time (proposed)

- No ASAP: the earliest time to choose is 3 hours from now (or a later day).
- An order with **no reference yet** cancels itself 1 hour before its
  scheduled time, or 24 hours after it was placed, whichever comes first.
  Its stock and slot are freed.
- An order with a reference entered **never cancels itself**: the owner
  decides, because money may have been sent.

## Settings

- A switch "Let someone else pay" (off by default, so it ships dark). Off
  hides the checkout choice and stops new pay links working for new orders;
  orders already waiting keep their link, so a payer mid-way is not stranded.
- QR codes to scan: the owner uploads the GCash "Receive money" QR and,
  optionally, a bank QR Ph image (JPEG/PNG/WebP, magic bytes checked, size
  limit, EXIF stripped, random filename; public, since payers must see it).
  The payer page shows the QR under the total with a "Save QR" button (pay
  from the same phone: GCash → Scan QR → upload from gallery). The saved QR
  carries no amount, so the exact total sits right above it; the owner's
  check catches a wrong amount.
- Payment details shown to payers: GCash name and number; bank name, account
  name and account number (plain text fields, owner-typed). The choice is
  hidden at checkout while the switch is off or no details are filled in.

## Goals

- A payer anywhere can pay for an order in a few taps, with no account.
- Nothing is cooked or delivered before the owner confirms the money.
- Reuses what exists: the waiting state, `pay_token`, the payments table
  with references, the SMS alert, the order status page.

## Non-goals

- Screenshot upload of the receipt.
- Automatic checking of GCash or bank (PayMongo stays a separate option).
- Dine-in; custom cake bookings; part payments; splitting between payers.
- Emailing or texting the payer.

## Anti-goals (a failure even if it works)

- The kitchen sees or starts an order before the owner taps Payment received.
- The pay link shows the receiver's phone number or full address.
- A guessed or enumerated link reveals someone's order.
- A real "new order" alert fires before payment is confirmed (the owner
  gets one alert to check payment instead).

## Constraints (from CLAUDE.md)

- Zero npm dependencies, strict CSP (payer page script in `assets/js/`),
  money in centavos, Manila time, server is the authority for totals.
- The pay page and reference endpoint are public: unguessable token, rate
  limit, body size limit, reference length limit (reuse `REFERENCE_MAX`),
  generic errors, no personal data in logs. Add routes to
  `claude/security-audit.md`.
- Migration additive only (new `pay_method` value, maybe one column for the
  submitted reference / method / payer name and a settings key or two).
- Tests for each rule above, including a negative test for a wrong token
  and for the kitchen queue excluding these orders.

## Approaches

1. **Save the order now; it waits for payment (picked).** Reuses the
   waiting state, link token, stock holding and payment records. Prices are
   fixed when the receiver orders. Trade-off: an unpaid order holds stock and
   its slot until paid or cancelled.
2. Save only a basket; the order is made when the payer pays. Nothing held,
   but prices or stock can change before the payer opens it, and checkout
   checks would be duplicated. Rejected.
3. Send the payer to online GCash (PayMongo). Automatic, but fees, not on yet,
   and no bank transfer. Rejected for this feature.

Owner check (option A) was picked over letting the reference alone release
the order, because a made-up number would otherwise get food.

## Decided after review (my calls, check these)

- **Where the money is recorded:** like online GCash, on the order
  (`online_paid_cents` plus the method and reference), not in `payments`. The
  money goes to the owner's GCash or bank, never the drawer, so it stays out of
  shift and drawer readings. The owner taps Payment received from admin Orders
  with the admin session and CSRF, no staff PIN, and it is written to the audit
  log. This replaces "records a payment … in payments" in step 4.
- **Alerts:** placing the order sends nothing. A submitted reference sends the
  owner the "check payment" text. Payment received sends the usual new-order
  push (the kitchen device) and the receiver's "we got your order" text, but
  not the owner's SMS again.
- **After Not received:** the order no longer cancels itself; the owner cancels
  it by hand. Money may have been sent, so a clock should not decide.
- **A separate payer token**, not the receiver's `pay_token`. The payer cannot
  open the receiver's status page, and the receiver's link cannot submit
  references. It is one new column.
- **Payment received also confirms the order:** it enters the queue already
  confirmed, with no call needed. The owner has checked the money.
- Not for "Other area" delivery: its fee is agreed by phone, so the total
  isn't final (the same rule as online GCash).
- One reference at a time: while one is being checked, the payer page says so
  and takes no other.
- These orders are excluded from `paymongo.expireStale` and get their own
  cancel rule.

## Left to the builder

- Column and status names (e.g. `pay_method = 'remote'`, a `checking`
  pay status), page layout and wording in the house style.
- How the 3-hour minimum fits the cart's slot code (`slotsOn`) and the
  server's `schedule` checks.
- Where in admin Orders the check sits, following the existing order card.
