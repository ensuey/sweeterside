'use strict';
/* The shop's public details, in one place: the homepage, the structured data
   for search engines (JSON-LD), llms.txt and the sitemap all read them, so
   they always say exactly the same thing. Keep them identical to the Google
   Business Profile: a different name, address or phone hurts local search.

   Given by the owner on 2026-11-03. */

const BUSINESS = {
  name: 'Sweeter Side by Dachel',
  url: 'https://sweeterside.ph',
  description: 'Café, coffee shop and cake shop at the Public Market in Batobato, San Isidro, '
    + 'Davao Oriental. Coffee, frappes, slices of cake, whole cakes, brownies and custom cakes, '
    + 'plus pasta and sandwiches. Dine in, pick up or delivery.',
  phone: { display: '0932 762 0367', tel: '+639327620367' },
  address: {
    street: 'Unit 5, Lasaca Bldg, Public Market, Batobato',
    locality: 'San Isidro',
    region: 'Davao Oriental',
    postalCode: '8209',
    country: 'PH',
  },
  geo: { latitude: 6.8340817, longitude: 126.0873542 },
  // Opening hours are set on the Settings page (see seo.hours()).
  map: 'https://www.google.com/maps?cid=6144996303293417236',
  facebook: 'https://www.facebook.com/SweeterSideByDachel',
  // Delivery areas, fees and times are set on the Settings page (server/delivery.js).
  serves: ['Coffee', 'Frappes', 'Cakes', 'Cake slices', 'Brownies', 'Pastries', 'Desserts', 'Pasta', 'Sandwiches'],
  priceRange: '₱',
};

/** "Unit 5, …, San Isidro, Davao Oriental 8209" */
function addressLine(b = BUSINESS) {
  return `${b.address.street}, ${b.address.locality}, ${b.address.region} ${b.address.postalCode}`;
}

module.exports = { BUSINESS, addressLine };
