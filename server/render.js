'use strict';
/* Renders the customer menu from the database into the page template.
   Items stay real markup, so the menu still works with JavaScript disabled. */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./db');
const menu = require('./menu');

const TEMPLATE = path.join(ROOT, 'templates', 'menu.html');
const OUTPUT = path.join(ROOT, 'index.html');

const SECTIONS = [
  { key: 'drinks', title: 'Frappe Based Drinks' },
  { key: 'food', title: 'Food' },
];

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Encode a path for use in a URL while leaving the slashes alone. */
function encPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function cardHtml(item) {
  const hasCrop = item.crop_w != null && item.crop_h != null;
  const shotAttrs = hasCrop
    ? ` class="shot" style="--x:${item.crop_x}; --y:${item.crop_y}; --w:${item.crop_w}; --h:${item.crop_h}"`
    : ' class="shot shot--plain"';

  return `      <li class="card" data-cat="${esc(item.category)}" data-name="${esc(item.name)}" data-price="${item.price}">
        <div${shotAttrs}>
          <img src="${esc(encPath(item.image))}" alt="${esc(item.alt || item.name)}">
        </div>
        <div class="card__body">
          <h3 class="card__name">${esc(item.name)}</h3>
          <div class="card__foot">
            <span class="price"><small>Php</small> ${item.price}</span>
            <button class="card__btn" type="button">View ${esc(item.name)}</button>
          </div>
        </div>
      </li>`;
}

function sectionHtml(section, items) {
  if (items.length === 0) return '';
  return `  <section class="section" id="${section.key}" data-cat="${section.key}">
    <div class="section__head">
      <h2 class="section__title">${esc(section.title)}</h2>
      <span class="section__rule" aria-hidden="true"></span>
      <span class="section__count"><span data-count>${items.length}</span> items</span>
    </div>
    <ul class="grid">
${items.map(cardHtml).join('\n\n')}
    </ul>
  </section>`;
}

function chipsHtml(counts) {
  const total = counts.drinks + counts.food;
  return `      <button class="chip" type="button" data-filter="all" aria-pressed="true">All <span class="chip__n">${total}</span></button>
      <button class="chip" type="button" data-filter="drinks" aria-pressed="false">Frappes <span class="chip__n">${counts.drinks}</span></button>
      <button class="chip" type="button" data-filter="food" aria-pressed="false">Food <span class="chip__n">${counts.food}</span></button>`;
}

function buildHtml(items = menu.list()) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const byCat = {
    drinks: items.filter((i) => i.category === 'drinks'),
    food: items.filter((i) => i.category === 'food'),
  };

  const sections = SECTIONS
    .map((s) => sectionHtml(s, byCat[s.key]))
    .filter(Boolean)
    .join('\n\n');

  const empty = items.length === 0
    ? '  <p class="no-items">The menu is being updated. Please check back shortly.</p>'
    : '';

  return template
    .replace('<!--CHIPS-->', chipsHtml({ drinks: byCat.drinks.length, food: byCat.food.length }))
    .replace('<!--SECTIONS-->', sections + empty);
}

/** Write index.html so plain static hosting keeps serving a current menu. */
function writeStatic() {
  const html = buildHtml();
  fs.writeFileSync(OUTPUT, html, 'utf8');
  return OUTPUT;
}

module.exports = { buildHtml, writeStatic, esc, encPath, OUTPUT, TEMPLATE };
