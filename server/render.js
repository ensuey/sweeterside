'use strict';
/* Renders the customer menu from the database into the page template.
   Items stay real markup, so the menu still works with JavaScript disabled. */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./db');
const menu = require('./menu');
const categories = require('./categories');

const TEMPLATE = path.join(ROOT, 'templates', 'menu.html');
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

function cardHtml(item, category) {
  const hasCrop = item.crop_w != null && item.crop_h != null;
  const shotAttrs = hasCrop
    ? ` class="shot" style="--x:${item.crop_x}; --y:${item.crop_y}; --w:${item.crop_w}; --h:${item.crop_h}"`
    : ' class="shot shot--plain"';

  return `      <li class="card" data-cat="${esc(category.slug)}" data-tag="${esc(category.label)}" data-name="${esc(item.name)}" data-price="${item.price}">
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

function buildHtml(items = menu.list(), cats = categories.list()) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');

  // Empty categories get neither a section nor a filter chip.
  const groups = cats
    .map((category) => ({ category, items: items.filter((i) => i.category_id === category.id) }))
    .filter((g) => g.items.length > 0);

  const sections = groups.map((g) => sectionHtml(g.category, g.items)).join('\n\n');

  const empty = items.length === 0
    ? '  <p class="no-items">The menu is being updated. Please check back shortly.</p>'
    : '';

  return template
    .replace('<!--CHIPS-->', chipsHtml(groups, items.length))
    .replace('<!--SECTIONS-->', sections + empty);
}

/** Write index.html so plain static hosting keeps serving a current menu. */
function writeStatic() {
  const html = buildHtml();
  fs.writeFileSync(OUTPUT, html, 'utf8');
  return OUTPUT;
}

module.exports = { buildHtml, writeStatic, esc, encPath, OUTPUT, TEMPLATE };
