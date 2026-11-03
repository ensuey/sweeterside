'use strict';
/* Local SEO and AI search: the homepage and cakes page say who, where and
   when, the structured data matches the visible facts and today's menu, and
   robots.txt, sitemap.xml and llms.txt are right. Own throwaway database. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeterside-seo-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.CAKE_PHOTO_DIR = path.join(TEST_DIR, 'cake-photos');

const { seedIfEmpty } = require('../server/db');
const menu = require('../server/menu');
const render = require('../server/render');
const { BUSINESS } = require('../server/business');
seedIfEmpty();
// Ordering follows the opening hours. Open all day, so no test depends on the clock.
require('../server/orders').updateSettings({ open_at: '00:00', close_at: '24:00' });
const { server } = require('../server/index');

const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the homepage names the place and the keywords, and shows the facts as text', () => {
  const html = render.buildHtml();
  const title = html.match(/<title>(.*?)<\/title>/)[1];
  for (const word of ['Café', 'Coffee Shop', 'Cake Shop', 'San Isidro', 'Davao Oriental']) assert.ok(title.includes(word), word);
  const description = html.match(/<meta name="description" content="([^"]*)"/)[1];
  for (const word of ['Café', 'cake shop', 'Coffee', 'brownies', 'San Isidro']) assert.ok(description.includes(word), word);
  assert.ok(html.includes('<link rel="canonical" href="https://sweeterside.ph/">'));
  assert.ok(html.includes('<meta property="og:image" content="https://sweeterside.ph/'), 'an absolute share image');

  // Visible name, address, phone and hours, the same as the structured data.
  assert.ok(html.includes(BUSINESS.address.street) && html.includes(BUSINESS.address.postalCode));
  assert.ok(html.includes(`href="tel:${BUSINESS.phone.tel}"`) && html.includes(BUSINESS.phone.display));
  assert.ok(html.includes(require('../server/seo').hours().label), 'the opening hours from Settings');
  for (const area of BUSINESS.deliveryAreas) assert.ok(html.includes(area), area);
  assert.ok(html.includes('id="visit"') && html.includes('id="faq"'));
  assert.ok(!/<!--[A-Z_]+-->/.test(html), 'every placeholder is filled');
});

test('the structured data is a café and bakery with the address, hours, map and today\'s menu', () => {
  const html = render.buildHtml();
  const [ld] = ldBlocks(html);
  const graph = ld['@graph'];
  const biz = graph.find((n) => n['@id'] === 'https://sweeterside.ph/#business');
  assert.deepStrictEqual(biz['@type'], ['CafeOrCoffeeShop', 'Bakery']);
  assert.deepStrictEqual(biz.address, {
    '@type': 'PostalAddress', streetAddress: 'Unit 5, Lasaca Bldg, Public Market, Batobato',
    addressLocality: 'San Isidro', addressRegion: 'Davao Oriental', postalCode: '8209', addressCountry: 'PH',
  });
  assert.deepStrictEqual([biz.geo.latitude, biz.geo.longitude], [6.8340817, 126.0873542]);
  assert.strictEqual(biz.telephone, '+639327620367');
  const [hours] = biz.openingHoursSpecification;
  const set = require('../server/orders').openingHours();
  assert.deepStrictEqual([hours.opens, hours.closes, hours.dayOfWeek.length], [set.open, set.close, 7], 'the hours from Settings');
  assert.ok(biz.sameAs.includes('https://www.facebook.com/SweeterSideByDachel'));
  assert.ok(biz.hasMap.startsWith('https://www.google.com/maps'));

  const menuNode = graph.find((n) => n['@type'] === 'Menu');
  const listed = menuNode.hasMenuSection.flatMap((s) => s.hasMenuItem);
  const shown = menu.list().filter((i) => i.availability !== 'unavailable');
  assert.strictEqual(listed.length, shown.length, 'every item on the menu, and nothing hidden');
  const matcha = listed.find((i) => i.name === 'Matcha Frappe');
  assert.deepStrictEqual([matcha.offers.price, matcha.offers.priceCurrency], ['129', 'PHP']);

  const faq = graph.find((n) => n['@type'] === 'FAQPage');
  const visible = (html.match(/<div class="faq__item">/g) || []).length;
  assert.strictEqual(faq.mainEntity.length, visible, 'the same questions as on the page');
});

test('text from the menu cannot break out of the structured data', () => {
  const cat = menu.list()[0].category_id;
  const evil = menu.create({ name: 'Cake</script><script>alert(1)</script>', price: 99, category_id: cat, image: '', alt: '' });
  try {
    const html = render.buildHtml();
    const blocks = ldBlocks(html);
    assert.strictEqual(blocks.length, 1, 'still exactly one data block');
    const names = blocks[0]['@graph'].find((n) => n['@type'] === 'Menu').hasMenuSection.flatMap((s) => s.hasMenuItem.map((i) => i.name));
    assert.ok(names.includes('Cake</script><script>alert(1)</script>'), 'the name survives as data');
    assert.ok(!html.includes('<script>alert(1)'), 'never as a live script tag');
  } finally {
    menu.remove(evil.id);
  }
});

test('the cakes page is a custom cake service from the bakery, from the lowest size price', () => {
  const html = render.buildCakesHtml();
  assert.ok(html.match(/<title>(.*?)<\/title>/)[1].includes('Custom Cakes in San Isidro'));
  assert.ok(html.includes('<link rel="canonical" href="https://sweeterside.ph/cakes">'));
  const [ld] = ldBlocks(html);
  const service = ld['@graph'].find((n) => n['@type'] === 'Service');
  assert.strictEqual(service.provider['@id'], 'https://sweeterside.ph/#business');
  assert.strictEqual(service.offers.priceCurrency, 'PHP');
  assert.ok(Number(service.offers.lowPrice) > 0);
});

test('robots.txt, sitemap.xml and llms.txt: public pages in, admin and POS out', async () => {
  await withServer(async (url) => {
    const robots = await fetch(`${url}/robots.txt`);
    assert.match(robots.headers.get('content-type'), /text\/plain/);
    const r = await robots.text();
    assert.match(r, /^User-agent: \*$/m);
    assert.match(r, /^Disallow: \/admin$/m);
    assert.match(r, /^Disallow: \/api\/$/m);
    assert.match(r, /^Sitemap: https:\/\/sweeterside\.ph\/sitemap\.xml$/m);

    const sitemap = await fetch(`${url}/sitemap.xml`);
    assert.match(sitemap.headers.get('content-type'), /application\/xml/);
    const s = await sitemap.text();
    assert.ok(s.includes('<loc>https://sweeterside.ph/</loc>') && s.includes('<loc>https://sweeterside.ph/cakes</loc>'));
    assert.ok(!s.includes('/admin'));

    const llms = await (await fetch(`${url}/llms.txt`)).text();
    assert.ok(llms.startsWith('# Sweeter Side by Dachel'));
    for (const fact of ['San Isidro, Davao Oriental 8209', '0932 762 0367', 'Open daily', 'Matcha Frappe: Php 129', '/cakes']) {
      assert.ok(llms.includes(fact), fact);
    }
    assert.ok(!llms.includes('/admin'), 'no admin links');

    const home = await fetch(`${url}/`);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'(;|$)/, 'the CSP stays strict');
  });
});

test('changing the opening hours in Settings changes the page, the data and llms.txt', () => {
  const orders = require('../server/orders');
  const seo = require('../server/seo');
  orders.updateSettings({ open_at: '09:30', close_at: '21:00' });
  try {
    const html = render.buildHtml();
    assert.ok(html.includes('Open daily, 9:30 AM to 9:00 PM'), 'visible hours');
    const biz = ldBlocks(html)[0]['@graph'][0];
    assert.deepStrictEqual([biz.openingHoursSpecification[0].opens, biz.openingHoursSpecification[0].closes], ['09:30', '21:00']);
    assert.ok(seo.llmsTxt([]).includes('Open daily, 9:30 AM to 9:00 PM'));
    assert.match(html, /<meta name="description" content="[^"]*Open daily, 9:30 AM to 9:00 PM\.">/);
  } finally {
    orders.updateSettings({ open_at: '00:00', close_at: '24:00' });
  }
});

test('the favicon and app icons: a real .ico at /favicon.ico, and every page links them', async () => {
  const iconsDir = path.join(__dirname, '..', 'assets', 'icons');
  for (const [name, size] of [['favicon-16.png', 16], ['favicon-32.png', 32], ['favicon-48.png', 48],
    ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    const png = fs.readFileSync(path.join(iconsDir, name));
    assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `${name} is ${size}x${size}`);
  }
  await withServer(async (url) => {
    const ico = await fetch(`${url}/favicon.ico`);
    assert.strictEqual(ico.status, 200);
    assert.strictEqual(ico.headers.get('content-type'), 'image/x-icon');
    const buf = Buffer.from(await ico.arrayBuffer());
    assert.deepStrictEqual([buf.readUInt16LE(0), buf.readUInt16LE(2), buf.readUInt16LE(4)], [0, 1, 3], 'an icon file with 16, 32 and 48 px');
  });
  const home = render.buildHtml();
  assert.ok(home.includes('<link rel="icon" href="favicon.ico" sizes="48x48">'));
  assert.ok(home.includes('href="assets/icons/apple-touch-icon.png"'));
  assert.ok(render.buildCakesHtml().includes('<link rel="icon" href="/favicon.ico" sizes="48x48">'));
  for (const page of fs.readdirSync(path.join(__dirname, '..', 'admin')).filter((n) => n.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', page), 'utf8');
    assert.ok(html.includes('href="/favicon.ico"') && !html.includes('rel="icon" href="/assets/Sweeter'), page);
  }
});

test('the About us page is indexable, linked, in the sitemap, and says only the shop\'s facts', async () => {
  const seo = require('../server/seo');
  const cakes = require('../server/cakes');
  await withServer(async (url) => {
    const res = await fetch(`${url}/about`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.ok(!/noindex/i.test(res.headers.get('x-robots-tag') || ''), 'no noindex header');
    const html = await res.text();
    assert.ok(!/<meta name="robots"[^>]*noindex/i.test(html), 'no noindex meta');
    assert.ok(html.includes('<link rel="canonical" href="https://sweeterside.ph/about">'));
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    for (const word of ['About', 'Café', 'Coffee Shop', 'Cake Shop', 'San Isidro']) assert.ok(title.includes(word), word);
    assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1, 'one h1');

    // The facts, the same as everywhere else.
    assert.ok(html.includes(BUSINESS.address.street) && html.includes(BUSINESS.phone.display));
    assert.ok(html.includes(seo.hours().label));
    for (const area of BUSINESS.deliveryAreas) assert.ok(html.includes(area), area);
    // Today's menu with prices, and the cake sizes and notice.
    assert.ok(html.includes('Matcha Frappe <span class="about__price">Php 129</span>'));
    const s = cakes.settings();
    assert.ok(html.includes(`${render.esc(s.sizes[0].name)}: from Php ${s.sizes[0].from_price.toLocaleString('en-US')}`),
      'sizes like 6" are escaped');
    assert.ok(html.includes(`at least ${s.lead_days} days ahead`));

    const graph = ldBlocks(html)[0]['@graph'];
    const page = graph.find((n) => n['@type'] === 'AboutPage');
    assert.strictEqual(page.mainEntity['@id'], 'https://sweeterside.ph/#business');
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList');
    assert.deepStrictEqual(crumbs.itemListElement.map((i) => i.item), ['https://sweeterside.ph/', 'https://sweeterside.ph/about']);

    const robots = await (await fetch(`${url}/robots.txt`)).text();
    assert.ok(!/^Disallow: \/about/m.test(robots) && !/^Disallow: \/$/m.test(robots), 'robots.txt allows /about');
    assert.ok((await (await fetch(`${url}/sitemap.xml`)).text()).includes('<loc>https://sweeterside.ph/about</loc>'));
    assert.ok((await (await fetch(`${url}/llms.txt`)).text()).includes('https://sweeterside.ph/about'));
  });
  assert.ok(render.buildHtml().includes('<a href="/about">About us</a>'), 'linked from the menu');
  assert.ok(render.buildCakesHtml().includes('<a href="/about">About us</a>'), 'linked from the cakes page');
});

test('menu text on the About page is escaped', () => {
  const cat = menu.list()[0].category_id;
  const evil = menu.create({ name: '<img src=x onerror=alert(1)>', price: 99, category_id: cat, image: '', alt: '' });
  try {
    const html = render.buildAboutHtml();
    assert.ok(!html.includes('<img src=x onerror'), 'never live markup');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.strictEqual(ldBlocks(html).length, 1);
  } finally {
    menu.remove(evil.id);
  }
});
