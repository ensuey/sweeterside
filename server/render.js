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

const TEMPLATE = path.join(ROOT, 'templates', 'menu.html');
const CAKES_TEMPLATE = path.join(ROOT, 'templates', 'cakes.html');
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

// Below this many left today, customers are told how many remain.
const FEW_LEFT = 5;

/** '20% off' or 'Php 30 off' */
function saleLabel(item) {
  return item.sale_type === 'percent' ? `${item.sale_value}% off` : `Php ${item.price - item.sale_price} off`;
}

function cardHtml(item, category) {
  const hasCrop = item.crop_w != null && item.crop_h != null;
  const shotAttrs = hasCrop
    ? ` class="shot" style="--x:${item.crop_x}; --y:${item.crop_y}; --w:${item.crop_w}; --h:${item.crop_h}"`
    : ' class="shot shot--plain"';

  // Sold out (by hand, or today's limit is used up): shown, but cannot be added.
  // Otherwise data-remaining tells the cart how many it may take today.
  const stockAttr = item.sold_out ? ' data-soldout'
    : item.remaining !== null ? ` data-remaining="${item.remaining}"` : '';
  const action = item.sold_out
    ? '<span class="card__soldout">Sold out</span>'
    : `<button class="card__add" type="button" data-add>Add<span class="vh"> ${esc(item.name)} to cart</span></button>`;
  const fewLeft = !item.sold_out && item.remaining !== null && item.remaining <= FEW_LEFT
    ? `\n          <p class="card__left">Only ${item.remaining} left today</p>`
    : '';

  // data-price is what the cart charges, so on sale it is the sale price;
  // data-was keeps the full price for the detail popup.
  const onSale = item.sale_price < item.price;
  const promoAttrs = (item.best_seller ? ' data-best' : '') + (onSale ? ` data-was="${item.price}"` : '');
  const badge = item.best_seller ? '\n        <span class="card__badge">★ Best seller</span>' : '';
  const saleTag = onSale
    ? `\n          <p class="card__sale">${saleLabel(item)}</p>`
    : '';
  const price = onSale
    ? `<span class="price"><s class="price__was"><span class="vh">Was </span>Php ${item.price}</s> <small>Php</small> ${item.sale_price}</span>`
    : `<span class="price"><small>Php</small> ${item.price}</span>`;

  return `      <li class="card${item.sold_out ? ' card--soldout' : ''}" data-id="${item.id}" data-cat="${esc(category.slug)}" data-tag="${esc(category.label)}" data-name="${esc(item.name)}" data-price="${item.sale_price}"${promoAttrs}${stockAttr}>${badge}
        <div${shotAttrs}>
          <img src="${esc(encPath(item.image))}" alt="${esc(item.alt || item.name)}">
        </div>
        <div class="card__body">
          <h3 class="card__name">${esc(item.name)}</h3>${saleTag}${fewLeft}
          <div class="card__foot">
            ${price}
            ${action}
            <button class="card__btn" type="button">View ${esc(item.name)}</button>
          </div>
        </div>
      </li>`;
}

function sectionHtml(category, items) {
  const slug = esc(category.slug);
  return `  <section class="section" id="${slug}" data-cat="${slug}">
    <div class="section__head">
      <h2 class="section__title">${esc(category.name)}</h2>
      <span class="section__rule" aria-hidden="true"></span>
      <span class="section__count"><span data-count>${items.length}</span> items</span>
    </div>
    <ul class="grid">
${items.map((item) => cardHtml(item, category)).join('\n\n')}
    </ul>
  </section>`;
}

function chipsHtml(groups, total) {
  const chip = (filter, label, n, pressed) =>
    `      <button class="chip" type="button" data-filter="${esc(filter)}" aria-pressed="${pressed}">${esc(label)} <span class="chip__n">${n}</span></button>`;
  return [
    chip('all', 'All', total, true),
    ...groups.map((g) => chip(g.category.slug, g.category.label, g.items.length, false)),
  ].join('\n');
}

function buildHtml(allItems = menu.list(), cats = categories.list()) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  // Items marked not available are left off the menu entirely.
  const items = allItems.filter((i) => i.availability !== 'unavailable');

  // Empty categories get neither a section nor a filter chip.
  const groups = cats
    .map((category) => ({ category, items: items.filter((i) => i.category_id === category.id) }))
    .filter((g) => g.items.length > 0);

  const sections = groups.map((g) => sectionHtml(g.category, g.items)).join('\n\n');

  const empty = items.length === 0
    ? '  <p class="no-items">The menu is being updated. Please check back shortly.</p>'
    : '';

  const hours = orders.pickupHours();
  return template
    .replace('<!--DELIVERY_FEE-->', String(orders.getDeliveryFee()))
    .replace('<!--ORDER_TYPES-->', orders.enabledTypes().join(' '))
    .replace('<!--PICKUP_OPEN-->', esc(hours.open))
    .replace('<!--PICKUP_CLOSE-->', esc(hours.close))
    .replace('<!--CHIPS-->', chipsHtml(groups, items.length))
    .replace('<!--SECTIONS-->', sections + empty);
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
          <input type="radio" name="size" value="${esc(size.name)}"${i === 0 ? ' checked' : ''}>
          <span class="size__body">
            <span class="size__name">${esc(size.name)}</span>
            <span class="size__price">from <strong>Php ${size.from_price.toLocaleString('en-US')}</strong></span>
          </span>
        </label>`).join('\n');

  const flavours = [...s.flavours, cakes.OTHER_FLAVOUR]
    .map((f) => `          <option value="${esc(f)}">${esc(f)}</option>`).join('\n');

  return template
    .replace('<!--EARLIEST-->', avail.earliest)
    .replace('<!--LATEST-->', avail.latest)
    .replace('<!--FULL_DATES-->', avail.full_dates.join(' '))
    .replace('<!--EARLIEST_TEXT-->', esc(cakes.niceDate(avail.earliest)))
    .replace('<!--LEAD_DAYS-->', `${avail.lead_days} day${avail.lead_days === 1 ? '' : 's'}`)
    .replace('<!--SIZES-->', sizes)
    .replace('<!--FLAVOURS-->', flavours);
}

module.exports = { buildHtml, buildCakesHtml, writeStatic, esc, encPath, OUTPUT, TEMPLATE };
