# Sweeter Side — To do

_Planned work not yet started. Shipped work and owner set-up items are in `claude/dev-status.md`. Added 2026-11-17._

_This file in the repo is the master copy. Tick items off here in the same PR that builds them; the copy in the claude.ai Project follows this one._

## 1. Make sweeterside.ph an installable app (PWA) for customers

**Goal:** regulars can add the menu to their Home Screen and open it full screen. A convenience for repeat customers, not a way to win new ones. The admin already works this way (`/admin/manifest.webmanifest`, `/admin/sw.js`); this is the customer side.

**Build**
- [ ] `/manifest.webmanifest` at the root: name, short name, `start_url` and `scope` `/`, `display: standalone`, theme and background colours, 192/512 icons from `scripts/make-icons.js` plus a maskable icon. Its own `id`, so it stays a separate app from the admin one.
- [ ] Link the manifest, `theme-color` and apple-touch-icon on the menu, `/cakes` and `/about`.
- [ ] `/sw.js` at the root, served with no caching, registered from an external script (no inline scripts). Add `worker-src 'self'` and `manifest-src 'self'` to the customer CSP only. Check `/admin/sw.js` still controls `/admin`.
- [ ] Install hint: an "Install app" button on Android (`beforeinstallprompt`); a one-line "Share → Add to Home Screen" tip on iPhone Safari. Hide both when already installed. Note: links opened inside the Facebook or Messenger app can't install.

**Must cover: stale menu risk**
- [ ] Pages (menu, `/cakes`, `/about`) are network first. The cached copy is used only when there is no connection, never to speed up a normal visit.
- [ ] Never cache `/api`, `/admin`, any POST, the checkout token, or the order confirmation.
- [ ] Prices, sold-out state, stock counts, open/closed and opening hours always come from the server. The server already recomputes every price and rejects stale totals; keep that as the last line of defence.
- [ ] Static files (CSS, JS, icons, photos) are cache first under a versioned cache name that changes on each deploy; old caches are deleted when the new worker activates.
- [ ] Test: change a price and mark an item sold out, then reopen the installed app. The change shows on the next load.

**Must cover: offline situation**
- [ ] A small offline page: "You're offline. Ordering needs a connection." with tap-to-call.
- [ ] If the last menu is shown offline, mark it clearly ("Offline — menu may be out of date") and turn off Add to cart and checkout.
- [ ] An order is never queued to send later. If the connection drops at Place order, show a clear error and keep the cart.
- [ ] Test in airplane mode on a real iPhone and Android phone: first visit, repeat visit, and losing the connection mid-checkout.

**Must cover: fixing a buggy service worker**
- [ ] `/sw.js` is always fetched fresh (`Cache-Control: no-cache`), so a fixed version reaches phones on the next visit.
- [ ] The new worker takes over straight away (`skipWaiting` + `clients.claim`), so a customer is not left on the broken one until every tab is closed.
- [ ] Kill switch: a setting or env var that makes `/sw.js` serve a worker which deletes all caches and unregisters itself. Write it and test it before the first live release.
- [ ] Any error inside the worker falls back to a plain network request, so a worker bug never blocks ordering.
- [ ] Keep the worker small and free of business logic.

**Release**
- [ ] Staging first (`staging.sweeterside.ph`), then live.
- [ ] Add the new routes to `claude/security-audit.md`; add tests for the manifest, worker headers, CSP and the kill switch.
- [ ] Later, if people do install it: push "Your order is ready" to customers.

## 2. Remind the owner when the POS shift is still open after closing

**Problem:** the owner sometimes forgets to close the POS shift.

**Wanted:** a push notification 10 minutes after the set closing time (Settings → Opening hours) saying the shift is still open and needs to be closed.

**Decided (owner, 2026-11-17)**
- Goes to **all devices set in the admin settings** (Settings → Order alerts device list), the same devices that get order alerts.
- **Repeats every 30 minutes** while the shift stays open.
- **Capped at 4 reminders** per shift: closing + 10, + 40, + 70 and + 100 minutes, then it stops.

**Build**
- [ ] At closing time + 10 minutes (Manila time via `server/clock.js`), check for an open shift. If there is one, send a Web Push through `server/push.js` to every device on the Order alerts list: "Shift still open — please close it." Tapping opens the POS shift screen.
- [ ] While the shift stays open, send it again every 30 minutes, up to 4 reminders in total (closing + 10, + 40, + 70, + 100). Stop as soon as the shift is closed, and after the fourth. Never send twice for the same slot.
- [ ] Nothing is sent if no shift is open.
- [ ] No customer details in the message. Decide whether it carries anything beyond the reminder (for example when the shift was opened).
- [ ] The Fly machine stops when idle, so a timer inside the app will not fire on a quiet evening. Something must wake it at each reminder time: a scheduled request to a small protected endpoint, or a Fly scheduled machine. Decide which.
- [ ] If the closing time is changed in Settings, the reminder times follow it.
- [ ] Days the shop is switched to Closed by hand: still remind if a shift was left open.
- [ ] Add any new route to `claude/security-audit.md`; add tests (shift open → push to every device; no shift → none; repeats at 30 minutes; stops once closed; stops after 4; closing time changed).

**Still to decide**
- An on/off switch and the timings (10 minutes, 30 minutes, cap of 4) on the Settings page?
