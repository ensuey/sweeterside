'use strict';
/* Renders the customer menu from the database into the page template.
   Items stay real markup, so the menu still works with JavaScript disabled. */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./db');
const menu = require('./menu');
const categories = require('./categories');
const orders = require('./orders');
const cakes = require('./cakes');
const seo = require('./seo');
const { BUSINESS } = require('./business');
const delivery = require('./delivery');
const itemOptions = require('./options');
const suggestions = require('./suggestions');
const schedule = require('./schedule');
const gallery = require('./gallery');
const testimonials = require('./testimonials');

const peso = (n) => `₱${Number(n).toLocaleString('en-US')}`;

/** What customers said (switched on in the admin), and the optional rating
    line. Nothing at all when there is neither. Visual only: no review
    structured data (see server/testimonials.js). */
function testimonialsHtml() {
  const list = testimonials.list({ activeOnly: true });
  const rating = testimonials.ratingLine();
  if (!list.length && !rating) return '';
  const items = list.map((t) => `      <li class="reviews__item">
        <figure>
          <blockquote><p>${esc(t.quote)}</p></blockquote>
          <figcaption>${esc(t.name)}${t.source ? ` <span class="reviews__source">· ${esc(t.source)}</span>` : ''}</figcaption>
        </figure>
      </li>`).join('\n');
  return `<section class="reviews" aria-labelledby="reviews-title">
  <div class="wrap">
    <h2 class="reviews__title" id="reviews-title">What customers say</h2>
    ${rating ? `<p class="reviews__rating">${esc(rating)}</p>` : ''}
    ${list.length ? `<ul class="reviews__list">\n${items}\n    </ul>` : ''}
  </div>
</section>`;
}

/** Photos of past cakes, in the owner's order. Plain HTML: no JavaScript needed. */
function galleryHtml() {
  const photos = gallery.list();
  if (!photos.length) return '';
  const items = photos.map((p, i) => {
    const size = imageSize(p.image);
    const dims = size ? ` width="${size.width}" height="${size.height}"` : '';
    return `      <li class="gallery__item"><figure>
        <img src="/${esc(encPath(p.image))}" alt="${esc(p.caption || 'A cake made by Sweeter Side')}"${dims}${i < 2 ? '' : ' loading="lazy"'} decoding="async">
        ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}
      </figure></li>`;
  }).join('\n');
  return `<section class="gallery" aria-labelledby="gallery-title">
    <h2 class="cakes__h2" id="gallery-title">Cakes we have made</h2>
    <ul class="gallery__grid">
${items}
    </ul>
  </section>`;
}

/** Sizes and starting prices, and flavours that cost extra. */
function cakePricesHtml(s) {
  const rows = s.sizes.map((x) => `        <tr><th scope="row">${esc(x.name)}</th><td>from ${esc(peso(x.from_price))}</td></tr>`).join('\n');
  const extras = s.flavours.filter((f) => s.flavour_prices[f])
    .map((f) => `${f} +${peso(s.flavour_prices[f])}`);
  return `<section class="cake-prices" aria-labelledby="prices-title">
    <h2 class="cakes__h2" id="prices-title">Sizes and starting prices</h2>
    <table class="cake-prices__table">
      <thead><tr><th scope="col">Size</th><th scope="col">Price</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    ${extras.length ? `<p class="cake-prices__extra">Some flavours cost a little more: ${esc(extras.join(', '))}.</p>` : ''}
    <p class="cake-prices__note">The final price depends on the design. Dachel confirms it when she calls.</p>
  </section>`;
}

/** Before you book: notice (from the setting), deposit, pick-up and delivery. */
function cakeInfoHtml(s, avail) {
  const notice = avail.lead_days === 0 ? 'Order any time; same-day cakes depend on what we have on.'
    : `Book at least ${avail.lead_days} day${avail.lead_days === 1 ? '' : 's'} ahead. The earliest day you can book now is ${cakes.niceDate(avail.earliest)}.`;
  return `<section class="cake-info" aria-labelledby="info-title">
    <h2 class="cakes__h2" id="info-title">Before you book</h2>
    <dl class="cake-info__list">
      <div><dt>Notice</dt><dd>${esc(notice)}</dd></div>
      <div><dt>Price and deposit</dt><dd>${esc(s.deposit_text)}</dd></div>
      <div><dt>Pick-up or delivery</dt><dd>${esc(s.handover_text)}</dd></div>
    </dl>
  </section>`;
}
const { manilaDate, addDays } = require('./clock');

/** Items with a daily limit: how many are left on each day that can be
    ordered for, so the cart says "Only N left" for the day chosen.
    { 'YYYY-MM-DD': { item_id: remaining } } */
function stockByDay(now) {
  const today = manilaDate(now);
  const out = {};
  for (let i = 0; i <= schedule.preorderDays(); i++) {
    const date = addDays(today, i);
    const left = {};
    for (const item of menu.list({ now, date })) if (item.remaining !== null) left[item.id] = item.remaining;
    out[date] = left;
  }
  return out;
}

// The options of the items on the page being built: { item_id: { price, sale_type, sale_value, groups } }.
let pageOptions = {};

/** The least an item with options can cost: the cheapest choice in each
    group that must be chosen, at the item's sale. */
function fromPrice(item, opts) {
  let extra = 0;
  for (const g of opts.groups) {
    const prices = g.options.filter((o) => o.available).map((o) => o.price).sort((a, b) => a - b);
    extra += prices.slice(0, g.min).reduce((sum, p) => sum + p, 0);
  }
  return menu.salePrice({ price: item.price + extra, sale_type: item.sale_type, sale_value: item.sale_value });
}

const TEMPLATE = path.join(ROOT, 'templates', 'menu.html');
const CAKES_TEMPLATE = path.join(ROOT, 'templates', 'cakes.html');
const ABOUT_TEMPLATE = path.join(ROOT, 'templates', 'about.html');
const OUTPUT = path.join(ROOT, 'index.html');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Encode a path for use in a URL while leaving the slashes alone. */
function encPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

// The tags an item can have, each with its own badge, in this order.
const TAGS = [
  { key: 'best_seller', label: '★ Best seller', cls: 'best' },
  { key: 'must_try', label: '♥ Must try', cls: 'must' },
  { key: 'trending', label: '↗ Trending', cls: 'trend' },
];

// Below this many left, customers are told how many remain.
const FEW_LEFT = 5;
// The first few photos are on screen at once; the rest load as you scroll.
const EAGER_IMAGES = 4;

/** "1 item" / "3 items" */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** '20% off' or '₱30 off' */
function saleLabel(item) {
  return item.sale_type === 'percent' ? `${item.sale_value}% off` : `₱${item.price - item.sale_price} off`;
}

/** A photo's own width and height, for the img tag (no layout shift).
    Uploaded files never change in place, so the size is kept once read. */
const imageSizes = new Map();
function imageSize(rel) {
  if (!imageSizes.has(rel)) {
    const img = menu.resolveImage(rel);
    imageSizes.set(rel, img ? { width: img.width, height: img.height } : null);
  }
  return imageSizes.get(rel);
}

/** The card photo. The logo stands in for items without a photo of their own:
    it is decoration then, so alt is empty and screen readers skip it. */
function photoHtml(item, { eager }) {
  const size = imageSize(item.image);
  const dims = size ? ` width="${size.width}" height="${size.height}"` : '';
  const alt = item.image === menu.DEFAULT_IMAGE ? '' : item.alt || item.name;
  const load = eager ? '' : ' loading="lazy"';
  return `<img src="${esc(encPath(item.image))}" alt="${esc(alt)}"${dims}${load} decoding="async">`;
}

function cardHtml(item, category, { eager = false } = {}) {
  const hasCrop = item.crop_w != null && item.crop_h != null;
  const shotAttrs = hasCrop
    ? ` class="shot" style="--x:${item.crop_x}; --y:${item.crop_y}; --w:${item.crop_w}; --h:${item.crop_h}"`
    : ' class="shot shot--plain"';

  // Sold out (by hand, today's limit used up, none left in stock or an
  // ingredient out): shown, but cannot be added. Otherwise data-remaining
  // tells the cart how many it may take.
  const stockAttr = item.sold_out ? ' data-soldout'
    : item.remaining !== null ? ` data-remaining="${item.remaining}"` : '';
  const action = item.sold_out
    ? '<span class="card__soldout">Sold out</span>'
    : `<button class="card__add" type="button" data-add>Add<span class="vh"> ${esc(item.name)} to cart</span></button>`;
  const fewLeft = !item.sold_out && item.remaining !== null && item.remaining <= FEW_LEFT
    ? `\n          <p class="card__left">Only ${item.remaining} ${menu.leftText(item)}</p>`
    : '';

  // data-price is what the cart charges, so on sale it is the sale price;
  // data-was keeps the full price for the detail popup.
  const onSale = item.sale_price < item.price;
  // Items with options: Add opens the popup to choose. Prices that change
  // with the choice say "from".
  const opts = pageOptions[item.id];
  const varies = !!opts && opts.groups.some((g) => g.options.some((o) => o.price > 0));
  const from = varies ? '<span class="price__from">from </span>' : '';
  const shown = opts ? fromPrice(item, opts) : item.sale_price;
  const optsAttr = opts ? ` data-options="${esc(JSON.stringify(opts))}"` : '';
  const detailAttrs = (item.description ? ` data-desc="${esc(item.description)}"` : '')
    + (item.size_label ? ` data-size="${esc(item.size_label)}"` : '');
  const desc = item.description ? `\n          <p class="card__desc">${esc(item.description)}</p>` : '';
  const size = item.size_label ? ` <span class="card__size">${esc(item.size_label)}</span>` : '';
  // A ribbon for each tag that is on, stacked on the photo. data-badges carries
  // the same words to the item popup.
  const tags = TAGS.filter((t) => item[t.key]);
  const promoAttrs = (item.best_seller ? ' data-best' : '')
    + (tags.length ? ` data-badges="${esc(tags.map((t) => t.label).join(' · '))}"` : '')
    + (onSale ? ` data-was="${item.price}"` : '');
  const badge = tags.length
    ? `\n        <span class="card__badges">${tags.map((t) => `<span class="card__badge card__badge--${t.cls}">${esc(t.label)}</span>`).join('')}</span>`
    : '';
  const saleTag = onSale
    ? `\n          <p class="card__sale">${saleLabel(item)}</p>`
    : '';
  const price = onSale
    ? `<span class="price">${from}<s class="price__was"><span class="vh">Was </span>₱${opts ? fromPrice({ ...item, sale_type: '' }, opts) : item.price}</s> <small>₱</small>${shown}</span>`
    : `<span class="price">${from}<small>₱</small>${shown}</span>`;

  return `      <li class="card${item.sold_out ? ' card--soldout' : ''}" data-id="${item.id}" data-cat="${esc(category.slug)}" data-tag="${esc(category.label)}" data-name="${esc(item.name)}" data-price="${item.sale_price}"${promoAttrs}${stockAttr}${detailAttrs}${optsAttr}>${badge}
        <div${shotAttrs}>
          ${photoHtml(item, { eager })}
        </div>
        <div class="card__body">
          <h3 class="card__name">${esc(item.name)}${size}</h3>${desc}${saleTag}${fewLeft}
          <div class="card__foot">
            ${price}
            ${action}
            <button class="card__btn" type="button">View ${esc(item.name)}</button>
          </div>
        </div>
      </li>`;
}

function sectionHtml(category, items, eagerLeft = 0) {
  const slug = esc(category.slug);
  return `  <section class="section" id="${slug}" data-cat="${slug}">
    <div class="section__head">
      <h2 class="section__title">${esc(category.name)}</h2>
      <span class="section__rule" aria-hidden="true"></span>
      <span class="section__count" data-count>${plural(items.length, 'item')}</span>
    </div>
    <ul class="grid">
${items.map((item, i) => cardHtml(item, category, { eager: i < eagerLeft })).join('\n\n')}
    </ul>
  </section>`;
}

/** Best sellers, first on the menu: the items with the badge that can be
    ordered today. A scrolling row; menu.js hides it during a search or filter. */
function bestSellersHtml(groups) {
  const best = groups.flatMap((g) => g.items.filter((i) => i.best_seller && !i.sold_out).map((i) => ({ item: i, category: g.category })));
  if (!best.length) return '';
  return `  <section class="best" id="best-sellers" aria-labelledby="best-title" data-best-row>
    <div class="section__head">
      <h2 class="section__title" id="best-title">Best sellers</h2>
      <span class="section__rule" aria-hidden="true"></span>
      <span class="section__count">${plural(best.length, 'item')}</span>
    </div>
    <ul class="best__row">
${best.map(({ item, category }, i) => cardHtml(item, category, { eager: i < EAGER_IMAGES })).join('\n\n')}
    </ul>
  </section>`;
}

/** What the cart needs to price delivery: the areas a customer can pick (fee
    and usual time), and the free delivery threshold. The server prices the
    order again; this is only so the cart shows the right total. */
function deliveryData() {
  return {
    areas: delivery.selectable().map((a) => ({ id: a.id, name: a.name, fee: a.fee, eta: delivery.etaLabel(a) })),
    free_min: delivery.freeOver(),
  };
}

/** The area dropdown at checkout: the areas with a fee, then "Other area". */
function areaOptionsHtml() {
  const opts = delivery.selectable().map((a) => {
    const eta = delivery.etaLabel(a);
    const label = `${a.name} · ${a.fee === 0 ? 'free delivery' : `₱${a.fee}`}${eta ? ` · ${eta.charAt(0).toLowerCase()}${eta.slice(1)}` : ''}`;
    return `          <option value="${a.id}">${esc(label)}</option>`;
  });
  return ['          <option value="">Choose your area</option>', ...opts,
    '          <option value="other">Other area (we call you with the fee)</option>'].join('\n');
}

/** The share image (Open Graph) set in Settings, or the logo. A wide share
    image gets the large card on X/Twitter and Messenger. */
function shareTagsHtml() {
  const rel = orders.shareImage();
  if (!rel) {
    return '<meta property="og:image" content="https://sweeterside.ph/assets/Sweeter%20Side%20-%20PNG.png">\n'
      + '<meta property="og:image:alt" content="Sweeter Side by Dachel logo">\n'
      + '<meta name="twitter:card" content="summary">';
  }
  const size = imageSize(rel);
  return `<meta property="og:image" content="https://sweeterside.ph/${esc(encPath(rel))}">\n`
    + (size ? `<meta property="og:image:width" content="${size.width}">\n<meta property="og:image:height" content="${size.height}">\n` : '')
    + '<meta property="og:image:alt" content="Sweeter Side by Dachel: café and cake shop in San Isidro, Davao Oriental">\n'
    + '<meta name="twitter:card" content="summary_large_image">';
}

/** The tracking loader, or nothing when no tracking ID is set. tracking.js
    asks for consent first and loads the tools only after "Accept". */
function trackingHtml() {
  const t = orders.tracking();
  const attrs = [
    ['meta', t.meta_pixel_id], ['ga4', t.ga4_id], ['gads', t.gads_id],
    ['gads-purchase', t.gads_purchase_label], ['gads-lead', t.gads_lead_label], ['clarity', t.clarity_id],
  ].filter(([, v]) => v);
  if (!attrs.some(([k]) => ['meta', 'ga4', 'gads', 'clarity'].includes(k))) return '';
  return `<meta name="ss-tracking"${attrs.map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}>\n`
    + '<script src="/assets/js/tracking.js" defer></script>';
}

function chipsHtml(groups, total) {
  const chip = (filter, label, n, pressed) =>
    `      <button class="chip" type="button" data-filter="${esc(filter)}" aria-pressed="${pressed}">${esc(label)} <span class="chip__n">${n}</span></button>`;
  return [
    chip('all', 'All', total, true),
    ...groups.map((g) => chip(g.category.slug, g.category.label, g.items.length, false)),
  ].join('\n');
}

/** Open, closing soon or closed, shown in the hero. Rendered here so it shows
    without JavaScript; assets/js/hours.js keeps it current while the page is open. */
function shopStatusHtml(state, note) {
  if (state.preorder) {
    return `<p class="status status--closed" id="shop-status"><span class="status__pill">Closed now</span> ${esc(`You can pre-order for ${state.preorder.text}.`)}</p>`;
  }
  const closes = orders.clock12(state.closes_at);
  const opens = orders.clock12(state.opens_at);
  if (state.closing_soon) {
    return `<p class="status status--soon" id="shop-status"><span class="status__pill">Closing soon</span> We take orders until ${esc(closes)} today.</p>`;
  }
  if (state.open) {
    return `<p class="status status--open" id="shop-status"><span class="status__pill">Open now</span> Tap Add on anything you like to order. Orders until ${esc(closes)}.</p>`;
  }
  const text = !state.switch_open
    ? note || "We're closed right now. You can still look through the menu."
    : state.before_opening
      ? `We open at ${opens} today. You can look through the menu.`
      : `We're closed for today. We take orders again from ${opens} tomorrow.`;
  return `<p class="status status--closed" id="shop-status"><span class="status__pill">Closed</span> ${esc(text)}</p>`;
}

/** The bar at the top of the menu in the last 30 minutes before closing. */
function soonBarHtml(state) {
  const text = `Closing soon: we take online orders until ${orders.clock12(state.closes_at)} today.`;
  return `<p class="soonbar" id="soonbar" role="status"${state.closing_soon ? '' : ' hidden'}>${esc(text)}</p>`;
}

/** The menu as customers see it: items marked not available are left off,
    and empty categories get neither a section nor a filter chip. In each
    category what can be ordered comes first, in the usual order, and sold
    out items last. */
function menuGroups(allItems = menu.list(), cats = categories.list()) {
  const items = allItems.filter((i) => i.availability !== 'unavailable');
  const groups = cats
    .map((category) => ({ category, items: soldOutLast(items.filter((i) => i.category_id === category.id)) }))
    .filter((g) => g.items.length > 0);
  return { items, groups };
}

/** Sold out items moved to the end; otherwise the order is kept. */
function soldOutLast(items) {
  return [...items.filter((i) => !i.sold_out), ...items.filter((i) => i.sold_out)];
}

/** The menu page. now is the current time, for tests. viewer.admin: the
    visitor is signed in to the admin (GCash with test keys shows only then;
    the static index.html never has it). */
function buildHtml(allItems = null, cats = categories.list(), now = new Date(), viewer = {}) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  // Closed now, switch on: a pre-order for the first time there is.
  const state = orders.shopState(now);
  state.preorder = !state.open && state.switch_open ? orders.nextOrderTime(now) : null;
  if (!allItems) allItems = menu.list({ now, date: state.preorder ? state.preorder.date : undefined });
  const { items, groups } = menuGroups(allItems, cats);
  pageOptions = itemOptions.menuOptions(items);

  // The best sellers row comes first, so its photos are the ones loaded at once.
  const best = bestSellersHtml(groups);
  let eagerLeft = best ? 0 : EAGER_IMAGES;
  const sections = groups.map((g) => {
    const html = sectionHtml(g.category, g.items, eagerLeft);
    eagerLeft = Math.max(0, eagerLeft - g.items.length);
    return html;
  }).join('\n\n');

  const empty = items.length === 0
    ? '  <p class="no-items">The menu is being updated. Please check back shortly.</p>'
    : '';

  const hours = orders.openingHours();
  return template
    .replace('<!--SHOP_OPEN-->', state.open ? '1' : '0')
    .replace('<!--SWITCH_OPEN-->', state.switch_open ? '1' : '0')
    .replace('<!--PREORDER-->', state.preorder ? '1' : '0')
    .replace('<!--PREORDER_DAYS-->', String(schedule.preorderDays()))
    .replace('<!--STOCK-->', () => esc(JSON.stringify(stockByDay(now))))
    .replace('<!--SOON_MINUTES-->', String(orders.CLOSING_SOON_MINUTES))
    .replace('<!--SOON_BAR-->', () => soonBarHtml(state))
    .replace('<!--SHOP_STATUS-->', () => shopStatusHtml(state, orders.closedNote()))
    .replace('<!--DELIVERY_AREAS-->', () => esc(JSON.stringify(deliveryData())))
    .replace('<!--AREA_OPTIONS-->', () => areaOptionsHtml())
    .replace('<!--SUGGEST-->', () => esc(JSON.stringify(suggestions.forMenu())))
    .replace('<!--ORDER_TYPES-->', orders.enabledTypes().join(' '))
    .replace('<!--GCASH-->', require('./paymongo').offeredTo({ admin: !!viewer.admin }) || '0')
    .replace('<!--PICKUP_OPEN-->', esc(hours.open))
    .replace('<!--PICKUP_CLOSE-->', esc(hours.close))
    .replace('<!--CHIPS-->', chipsHtml(groups, items.length))
    .replace('<!--BEST-->', () => best)
    .replace('<!--SECTIONS-->', () => sections + empty)
    .replace('<!--SHARE_TAGS-->', () => shareTagsHtml())
    .replace('<!--TRACKING-->', () => trackingHtml())
    .replace('<!--CALL_MINUTES-->', String(orders.callMinutes()))
    .replaceAll('<!--SHOP_TEL-->', () => esc(BUSINESS.phone.tel))
    .replaceAll('<!--SHOP_PHONE-->', () => esc(BUSINESS.phone.display))
    .replaceAll('<!--FACEBOOK_URL-->', () => esc(orders.facebookUrl()))
    .replace('<!--LD_JSON-->', () => seo.homeLd(groups))
    .replace('<!--TESTIMONIALS-->', () => testimonialsHtml())
    .replace('<!--VISIT-->', () => seo.visitHtml())
    .replace('<!--FAQ-->', () => seo.faqHtml())
    .replace('<!--FOOT_NAP-->', () => seo.footHtml())
    .replace('<!--META_HOURS-->', () => esc(seo.hours().label));
}

/** Write index.html so plain static hosting keeps serving a current menu. */
function writeStatic() {
  const html = buildHtml();
  fs.writeFileSync(OUTPUT, html, 'utf8');
  return OUTPUT;
}

/* ---------------------------- cake booking page ---------------------------- */

/** The custom cake page: sizes with their starting prices, flavours, and the
    days that can be booked. Rendered on every request, like the menu. */
function buildCakesHtml(now = new Date()) {
  const template = fs.readFileSync(CAKES_TEMPLATE, 'utf8');
  const s = cakes.settings();
  const avail = cakes.availability(now);

  const sizes = s.sizes.map((size, i) => `        <label class="size">
          <input type="radio" name="size" value="${esc(size.name)}" data-price="${size.from_price}"${i === 0 ? ' checked' : ''}>
          <span class="size__body">
            <span class="size__name">${esc(size.name)}</span>
            <span class="size__price">from <strong>₱${size.from_price.toLocaleString('en-US')}</strong></span>
          </span>
        </label>`).join('\n');

  const flavours = [...s.flavours, cakes.OTHER_FLAVOUR]
    .map((f) => {
      const extra = s.flavour_prices[f] || 0;
      return `          <option value="${esc(f)}" data-extra="${extra}">${esc(f)}${extra ? ` (+${peso(extra)})` : ''}</option>`;
    }).join('\n');

  return template
    .replace('<!--EARLIEST-->', avail.earliest)
    .replace('<!--LATEST-->', avail.latest)
    .replace('<!--FULL_DATES-->', avail.full_dates.join(' '))
    .replace('<!--EARLIEST_TEXT-->', esc(cakes.niceDate(avail.earliest)))
    .replace('<!--LEAD_DAYS-->', `${avail.lead_days} day${avail.lead_days === 1 ? '' : 's'}`)
    .replace('<!--SIZES-->', sizes)
    .replace('<!--FLAVOURS-->', flavours)
    .replace('<!--LD_JSON-->', () => seo.cakesLd(s.sizes))
    .replace('<!--GALLERY-->', () => galleryHtml())
    .replace('<!--PRICES-->', () => cakePricesHtml(s))
    .replace('<!--INFO-->', () => cakeInfoHtml(s, avail))
    .replace('<!--TESTIMONIALS-->', () => testimonialsHtml())
    .replace('<!--TRACKING-->', () => trackingHtml())
    .replaceAll('<!--SHOP_TEL-->', esc(BUSINESS.phone.tel))
    .replaceAll('<!--SHOP_PHONE-->', esc(BUSINESS.phone.display))
    .replaceAll('<!--FACEBOOK_URL-->', esc(orders.facebookUrl()));
}

/* ---------------------------- about us ---------------------------- */

/** The About us page: the shop's facts, today's menu and the cake sizes,
    rendered on every request like the menu, so it is always current. */
function buildAboutHtml() {
  const s = cakes.settings();
  return fs.readFileSync(ABOUT_TEMPLATE, 'utf8')
    .replace('<!--META_HOURS-->', () => esc(seo.hours().label))
    .replace('<!--LD_JSON-->', () => seo.aboutLd())
    .replace('<!--ABOUT-->', () => seo.aboutHtml({
      groups: menuGroups().groups, cakeSizes: s.sizes, leadDays: s.lead_days, orderTypes: orders.enabledTypes(),
    }))
    .replace('<!--VISIT-->', () => seo.visitHtml())
    .replace('<!--FOOT_NAP-->', () => seo.footHtml())
    .replace('<!--TRACKING-->', () => trackingHtml());
}

module.exports = { buildHtml, buildCakesHtml, buildAboutHtml, writeStatic, menuGroups, esc, encPath, OUTPUT, TEMPLATE };
