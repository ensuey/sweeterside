# sweeterside

Online menu for **Sweeter Side by Dachel**, plus a password-protected admin
dashboard for adding, editing and deleting menu items.

Customers browse a fast page with search and category filters. Dachel signs in
at `/admin` and edits the menu; the customer page updates immediately.

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
- Admin: <http://127.0.0.1:3000/admin>

`npm test` runs the test suite (13 tests covering password hashing, CSRF,
validation and path containment).

### Changing the admin password

Run `npm run create-admin` again with the same email. It resets the password
and signs out every existing session.

## Project layout

```
server/
  index.js       HTTP server, routing, static files, uploads
  db.js          SQLite schema and the first-run seed
  auth.js        scrypt hashing, sessions, CSRF, login throttling
  menu.js        item validation and CRUD
  render.js      builds the customer page from the database
  imagesize.js   reads JPEG/PNG/WebP dimensions (also the upload sniffer)
admin/           login page and dashboard
templates/
  menu.html      customer page shell; the server fills in the items
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

The SQLite database and uploaded photos live in `/data`. **Mount a volume
there.** Containers get a fresh filesystem on every deploy, so without a volume
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

## Still to fill in

- **No contact details, address, hours or ordering link.** The footer is a stub.
  A menu customers find online usually needs a way to order — add it to the
  `<footer class="foot">` block in `templates/menu.html`.
- **No item descriptions.** Names and prices only, taken from the posters.
  Descriptions were left out rather than invented, since they imply ingredient
  and allergen claims.
