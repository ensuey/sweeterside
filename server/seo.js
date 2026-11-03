'use strict';
/* What search engines and AI assistants read about the shop: structured data
   (JSON-LD), the visible "Visit us" and FAQ sections, robots.txt, sitemap.xml
   and llms.txt. Every fact comes from server/business.js, and prices come
   from the live menu, so the page, the data and the summaries always agree. */

const { BUSINESS, addressLine } = require('./business');
const { manilaDate } = require('./clock');
const orders = require('./orders');

/** The opening hours from Settings, the same every day. */
function hours() {
  const { open, close } = orders.openingHours();
  return { opens: open, closes: close, label: `Open daily, ${orders.clock12(open)} to ${close === '24:00' ? 'midnight' : orders.clock12(close)}` };
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A JSON-LD block. JSON is not run as a script, so the CSP allows it. "<" is
    escaped, so text from the menu cannot close the tag early. */
function jsonLd(data) {
  // A backslash, and the two line separators JSON allows but a script tag does not.
  const bs = String.fromCharCode(92);
  const separators = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
  const json = JSON.stringify(data).replace(/</g, `${bs}u003c`)
    .replace(separators, (c) => `${bs}u${c.charCodeAt(0).toString(16)}`);
  return `<script type="application/ld+json">${json}</script>`;
}

const ID = `${BUSINESS.url}/#business`;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The business itself, as schema.org sees it: a café and a bakery. */
function businessNode() {
  const b = BUSINESS;
  return {
    '@type': ['CafeOrCoffeeShop', 'Bakery'],
    '@id': ID,
    name: b.name,
    description: b.description,
    url: `${b.url}/`,
    logo: `${b.url}/assets/Sweeter%20Side%20-%20PNG.png`,
    image: `${b.url}/assets/Sweeter%20Side%20-%20PNG.png`,
    telephone: b.phone.tel,
    priceRange: b.priceRange,
    servesCuisine: b.serves,
    address: {
      '@type': 'PostalAddress',
      streetAddress: b.address.street,
      addressLocality: b.address.locality,
      addressRegion: b.address.region,
      postalCode: b.address.postalCode,
      addressCountry: b.address.country,
    },
    geo: { '@type': 'GeoCoordinates', latitude: b.geo.latitude, longitude: b.geo.longitude },
    openingHoursSpecification: [{
      '@type': 'OpeningHoursSpecification', dayOfWeek: DAYS, opens: hours().opens, closes: hours().closes,
    }],
    hasMap: b.map,
    sameAs: [b.facebook, b.map],
    areaServed: b.deliveryAreas.map((name) => ({ '@type': 'Place', name: `${name}, ${b.address.locality}, ${b.address.region}` })),
  };
}

/** Questions people (and AI assistants) ask, answered from the facts above.
    The same list is shown on the page and sent as FAQPage data. */
function faqs() {
  const b = BUSINESS;
  const areas = b.deliveryAreas.slice(0, -1).join(', ') + ' and ' + b.deliveryAreas.at(-1);
  return [
    ['Where is Sweeter Side by Dachel?',
      `We are at ${addressLine()}, Philippines, inside the San Isidro Public Market.`],
    ['What are your opening hours?', `${hours().label}.`],
    ['Do you sell cakes and pastries?',
      'Yes. We have slices of cake, whole cakes and brownies at the café, and we bake custom cakes to order for birthdays and celebrations. Book a custom cake on our cakes page.'],
    ['Do you serve coffee?', 'Yes. We serve coffee and frappe-based drinks, along with pasta and sandwiches.'],
    ['Do you deliver?',
      `Yes. We deliver to ${areas}. Farther places are possible for a higher delivery fee. Delivery orders are paid in cash when they arrive.`],
    ['How do I order?',
      `Order on this page for delivery, pick-up or dine-in, call or text ${b.phone.display}, or message us on Facebook.`],
  ];
}

/** The homepage data: the business, its menu with today's prices, the site and the FAQ. */
function homeLd(groups) {
  const b = BUSINESS;
  const menuNode = {
    '@type': 'Menu',
    '@id': `${b.url}/#menu`,
    name: `${b.name} menu`,
    url: `${b.url}/#menu`,
    inLanguage: 'en',
    hasMenuSection: groups.map((g) => ({
      '@type': 'MenuSection',
      name: g.category.name,
      hasMenuItem: g.items.map((i) => ({
        '@type': 'MenuItem',
        name: i.name,
        offers: {
          '@type': 'Offer', price: String(i.sale_price ?? i.price), priceCurrency: 'PHP',
          availability: i.sold_out ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
        },
      })),
    })),
  };
  return jsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      { ...businessNode(), hasMenu: { '@id': menuNode['@id'] } },
      menuNode,
      { '@type': 'WebSite', '@id': `${b.url}/#website`, name: b.name, url: `${b.url}/`, publisher: { '@id': ID } },
      {
        '@type': 'FAQPage', '@id': `${b.url}/#faq`,
        mainEntity: faqs().map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
    ],
  });
}

/** The cakes page data: custom cakes from this bakery, with the lowest starting price. */
function cakesLd(sizes) {
  const b = BUSINESS;
  const prices = sizes.map((s) => s.from_price).filter((p) => Number.isFinite(p) && p > 0);
  const service = {
    '@type': 'Service',
    '@id': `${b.url}/cakes#custom-cakes`,
    name: 'Custom cakes',
    serviceType: 'Custom cake baking',
    description: `Custom cakes for birthdays and celebrations from ${b.name} in ${b.address.locality}, ${b.address.region}. Choose a size and flavour, describe your design and pick the day.`,
    url: `${b.url}/cakes`,
    provider: { '@id': ID },
    areaServed: { '@type': 'Place', name: `${b.address.locality}, ${b.address.region}` },
  };
  if (prices.length) {
    service.offers = { '@type': 'AggregateOffer', priceCurrency: 'PHP', lowPrice: String(Math.min(...prices)), offerCount: String(prices.length) };
  }
  return jsonLd({ '@context': 'https://schema.org', '@graph': [businessNode(), service] });
}

/* ---------------------------- visible sections ---------------------------- */

/** "Visit us": address, hours, phone, map, Facebook and delivery areas, as real text. */
function visitHtml() {
  const b = BUSINESS;
  return `  <section class="visit" id="visit" aria-labelledby="visit-title">
    <div class="wrap">
      <h2 id="visit-title">Visit our café and cake shop in San Isidro</h2>
      <p class="visit__lead">${esc(b.description)}</p>
      <div class="visit__grid">
        <div>
          <h3>Find us</h3>
          <address>${esc(b.address.street)}<br>${esc(b.address.locality)}, ${esc(b.address.region)} ${esc(b.address.postalCode)}</address>
          <p><a href="${esc(b.map)}" target="_blank" rel="noopener">Open in Google Maps</a></p>
        </div>
        <div>
          <h3>Opening hours</h3>
          <p>${esc(hours().label)}</p>
        </div>
        <div>
          <h3>Call or text</h3>
          <p><a href="tel:${esc(b.phone.tel)}">${esc(b.phone.display)}</a></p>
          <p><a href="${esc(b.facebook)}" target="_blank" rel="noopener">Message us on Facebook</a></p>
        </div>
        <div>
          <h3>Delivery</h3>
          <p>We deliver to ${esc(b.deliveryAreas.join(', '))}. Farther is possible for a higher delivery fee.</p>
        </div>
      </div>
    </div>
  </section>`;
}

/** Name, address and phone in the footer, the same everywhere they appear. */
function footHtml() {
  const b = BUSINESS;
  return `    <p>${esc(addressLine())} · <a href="tel:${esc(b.phone.tel)}">${esc(b.phone.display)}</a> · ${esc(hours().label)}</p>`;
}

function faqHtml() {
  return `  <section class="faq" id="faq" aria-labelledby="faq-title">
    <div class="wrap">
      <h2 id="faq-title">Questions</h2>
${faqs().map(([q, a]) => `      <div class="faq__item">\n        <h3>${esc(q)}</h3>\n        <p>${esc(a)}</p>\n      </div>`).join('\n')}
    </div>
  </section>`;
}

/* ---------------------------- crawler files ---------------------------- */

/** Search engines and AI crawlers are welcome on the public pages; the admin,
    the POS and the API are left out. */
function robotsTxt() {
  return `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${BUSINESS.url}/sitemap.xml\n`;
}

function sitemapXml(now = new Date()) {
  const day = manilaDate(now);
  const url = (loc, freq, priority) => `  <url><loc>${BUSINESS.url}${loc}</loc><lastmod>${day}</lastmod><changefreq>${freq}</changefreq><priority>${priority}</priority></url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${url('/', 'daily', '1.0')}\n${url('/cakes', 'weekly', '0.8')}\n${url('/about', 'monthly', '0.7')}\n</urlset>\n`;
}

/* ---------------------------- about us ---------------------------- */

const PAGE_TYPES = { delivery: 'delivery', pickup: 'pick-up', dinein: 'dine-in' };

/** "a, b and c" */
function listOf(words) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * The About us page body: who we are, what we serve (from today's menu),
 * custom cakes (from the cake settings), how to order (from the order types
 * that are on) and quick facts. Only facts the shop has given us; nothing is
 * made up.
 */
function aboutHtml({ groups, cakeSizes, leadDays, orderTypes }) {
  const b = BUSINESS;
  const h = hours();
  const types = orderTypes.map((t) => PAGE_TYPES[t]).filter(Boolean);
  const menuList = groups.map((g) => {
    const items = g.items.slice(0, 8).map((i) => `<li>${esc(i.name)} <span class="about__price">Php ${esc(i.sale_price ?? i.price)}</span></li>`).join('');
    const more = g.items.length > 8 ? `<li><a href="/#menu">and ${g.items.length - 8} more on the menu</a></li>` : '';
    return `        <div class="about__group">\n          <h3>${esc(g.category.name)}</h3>\n          <ul>${items}${more}</ul>\n        </div>`;
  }).join('\n');
  const sizes = cakeSizes.filter((s) => s.from_price > 0)
    .map((s) => `<li>${esc(s.name)}: from Php ${esc(s.from_price.toLocaleString('en-US'))}</li>`).join('');
  const facts = [
    ['Name', esc(b.name)],
    ['What we are', 'Café, coffee shop and cake shop'],
    ['Address', `${esc(addressLine())}, Philippines`],
    ['Opening hours', esc(h.label)],
    ['Phone', `<a href="tel:${esc(b.phone.tel)}">${esc(b.phone.display)}</a>`],
    ['We serve', esc(listOf(b.serves.map((s) => s.toLowerCase())))],
    ['Order', esc(types.length ? `Online for ${listOf(types)}` : 'Call or message us')],
    ['Delivery areas', `${esc(listOf(b.deliveryAreas))}; farther for a higher fee`],
    ['Custom cakes', `<a href="/cakes">Book online</a>, at least ${esc(leadDays)} days ahead`],
    ['Map', `<a href="${esc(b.map)}" target="_blank" rel="noopener">Google Maps</a>`],
    ['Facebook', `<a href="${esc(b.facebook)}" target="_blank" rel="noopener">Sweeter Side by Dachel</a>`],
  ].map(([k, v]) => `          <div><dt>${k}</dt><dd>${v}</dd></div>`).join('\n');

  return `  <section class="about__section" aria-labelledby="who-title">
    <h2 id="who-title">Who we are</h2>
    <p><strong>${esc(b.name)}</strong> is a café, coffee shop and cake shop run by Dachel, at the Public Market in Batobato, San Isidro, Davao Oriental. We serve coffee and frappe-based drinks, slices of cake, whole cakes and brownies, along with pasta and sandwiches, made fresh by Dachel.</p>
    <p>Come in and eat at the café, pick up your order, or have it delivered around San Isidro. For birthdays and celebrations, Dachel bakes custom cakes to order.</p>
  </section>

  <section class="about__section" aria-labelledby="serve-title">
    <h2 id="serve-title">What we serve</h2>
    <p>Coffee and frappes, cakes by the slice or whole, and brownies, plus pasta and sandwiches. Here is today's menu with prices; see the <a href="/#menu">full menu</a> to order.</p>
    <div class="about__menu">
${menuList || '        <p>The menu is being updated.</p>'}
    </div>
  </section>

  <section class="about__section" aria-labelledby="cakes-title">
    <h2 id="cakes-title">Custom cakes</h2>
    <p>Dachel bakes custom cakes for birthdays and celebrations. Choose a size and flavour, describe your design and pick the day; Dachel calls you to confirm the price. Book at least ${esc(leadDays)} days ahead.</p>
    ${sizes ? `<ul class="about__sizes">${sizes}</ul>` : ''}
    <p><a class="about__cta" href="/cakes">Book a custom cake</a></p>
  </section>

  <section class="about__section" aria-labelledby="order-title">
    <h2 id="order-title">How to order</h2>
    <ul>
      <li><strong>Online:</strong> ${types.length ? `order on <a href="/">our menu</a> for ${esc(listOf(types))}.` : 'online ordering is closed right now.'} Online ordering is open ${esc(h.label.replace(/^Open daily, /, 'every day, '))}.</li>
      <li><strong>Delivery:</strong> to ${esc(listOf(b.deliveryAreas))}, and farther for a higher delivery fee. Delivery orders are paid in cash when they arrive.</li>
      <li><strong>By phone:</strong> call or text <a href="tel:${esc(b.phone.tel)}">${esc(b.phone.display)}</a>, or message us on <a href="${esc(b.facebook)}" target="_blank" rel="noopener">Facebook</a>.</li>
    </ul>
  </section>

  <section class="about__section" aria-labelledby="facts-title">
    <h2 id="facts-title">Quick facts</h2>
    <dl class="about__facts">
${facts}
    </dl>
  </section>`;
}

/** The About us page data: an AboutPage about the business, with breadcrumbs. */
function aboutLd() {
  const b = BUSINESS;
  return jsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      businessNode(),
      {
        '@type': 'AboutPage',
        '@id': `${b.url}/about#page`,
        url: `${b.url}/about`,
        name: `About ${b.name}`,
        description: b.description,
        inLanguage: 'en',
        about: { '@id': ID },
        mainEntity: { '@id': ID },
        isPartOf: { '@type': 'WebSite', '@id': `${b.url}/#website`, name: b.name, url: `${b.url}/` },
        breadcrumb: { '@id': `${b.url}/about#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${b.url}/about#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Menu', item: `${b.url}/` },
          { '@type': 'ListItem', position: 2, name: 'About us', item: `${b.url}/about` },
        ],
      },
    ],
  });
}

/** A plain summary for AI assistants (llmstxt.org): who we are, where, when,
    and the menu with today's prices. Public facts only. */
function llmsTxt(groups) {
  const b = BUSINESS;
  const menuLines = groups.map((g) => `### ${g.category.name}\n${g.items
    .map((i) => `- ${i.name}: Php ${i.sale_price ?? i.price}${i.sold_out ? ' (sold out today)' : ''}`).join('\n')}`).join('\n\n');
  return `# ${b.name}

> ${b.description}

- Address: ${addressLine()}, Philippines
- Map: ${b.map}
- Hours: ${hours().label}
- Phone: ${b.phone.display}
- Facebook: ${b.facebook}
- Delivery: ${b.deliveryAreas.join(', ')}; farther for a higher fee. Delivery is cash on delivery.
- Order online: ${b.url}/ (delivery, pick-up or dine-in)
- Custom cakes: ${b.url}/cakes
- About us: ${b.url}/about

## Menu (prices in Philippine pesos)

${menuLines || 'The menu is being updated.'}

## Questions

${faqs().map(([q, a]) => `**${q}** ${a}`).join('\n\n')}
`;
}

module.exports = {
  hours, jsonLd, homeLd, cakesLd, aboutLd, aboutHtml, visitHtml, faqHtml, footHtml, faqs, robotsTxt, sitemapXml, llmsTxt,
};
