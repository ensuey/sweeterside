/* Sweeter Side — tracking, with consent first: the Meta Pixel, Google
   Analytics, Google Ads and Microsoft Clarity. The server adds this file only
   when the owner has saved at least one ID, and lists the IDs on the
   <meta name="ss-tracking"> tag. Nothing loads until the visitor taps Accept,
   and the choice is kept in this browser.
   Events carry item ids, quantities, totals and the order number, never a
   name, phone or address. Clarity is told to mask the cart and the cake form
   (data-clarity-mask in the templates).
   cart.js and cakes.js call window.ssTrack(name, data):
     add_to_cart    { value, items: [{ id, quantity }] }
     begin_checkout { value, count }
     purchase       { id, value, items: [{ id, quantity }] }
     lead           { id } */
(function () {
  'use strict';

  var CONSENT_KEY = 'sweeterside-tracking-consent'; // 'yes' or 'no'
  var OLD_KEY = 'sweeterside-pixel-consent'; // from the Meta-only banner
  var CURRENCY = 'PHP';

  var tag = document.querySelector('meta[name="ss-tracking"]');
  if (!tag) return;
  var ids = {
    meta: valid(tag.dataset.meta, /^\d{10,20}$/),
    ga4: valid(tag.dataset.ga4, /^G-[A-Z0-9]{4,15}$/),
    gads: valid(tag.dataset.gads, /^AW-\d{6,15}$/),
    gadsPurchase: valid(tag.dataset.gadsPurchase, /^[A-Za-z0-9_-]{4,40}$/),
    gadsLead: valid(tag.dataset.gadsLead, /^[A-Za-z0-9_-]{4,40}$/),
    clarity: valid(tag.dataset.clarity, /^[a-z0-9]{6,20}$/),
  };
  if (!ids.meta && !ids.ga4 && !ids.gads && !ids.clarity) return;

  var loaded = false;
  var banner = null;

  function valid(value, re) { return re.test(value || '') ? value : ''; }

  function readConsent() {
    try {
      var v = localStorage.getItem(CONSENT_KEY);
      // Someone who said no to the Meta Pixel is not asked again. A yes was
      // only for Meta, so they are asked about the other tools.
      return v || (localStorage.getItem(OLD_KEY) === 'no' ? 'no' : null);
    } catch (e) { return null; }
  }

  function writeConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch (e) { /* private mode: ask again next visit */ }
  }

  function addScript(src) {
    var script = document.createElement('script');
    script.async = true;
    script.src = src;
    document.head.appendChild(script);
  }

  /* ---------------------------- the tools ---------------------------- */

  /** Meta's standard loader: a queue until fbevents.js arrives. */
  function loadMeta() {
    var fbq = window.fbq = function () {
      if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
      else fbq.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    addScript('https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', ids.meta);
    fbq('track', 'PageView');
  }

  /** gtag.js serves both Analytics and Ads. It needs the arguments object itself. */
  function loadGoogle() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    // Loaded only after Accept, so consent is granted from the start.
    window.gtag('consent', 'default', {
      ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted',
    });
    window.gtag('js', new Date());
    if (ids.ga4) window.gtag('config', ids.ga4);
    if (ids.gads) window.gtag('config', ids.gads);
    addScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ids.ga4 || ids.gads));
  }

  /** Clarity's standard loader: a queue until the tag arrives. */
  function loadClarity() {
    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    addScript('https://www.clarity.ms/tag/' + encodeURIComponent(ids.clarity));
    window.clarity('consent');
  }

  function load() {
    if (loaded) {
      if (window.fbq) window.fbq('consent', 'grant');
      if (window.gtag) window.gtag('consent', 'update', {
        ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted',
      });
      if (window.clarity) window.clarity('consent');
      return;
    }
    loaded = true;
    if (ids.meta) loadMeta();
    if (ids.ga4 || ids.gads) loadGoogle();
    if (ids.clarity) loadClarity();
  }

  function revoke() {
    if (!loaded) return;
    if (window.fbq) window.fbq('consent', 'revoke');
    if (window.gtag) window.gtag('consent', 'update', {
      ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    });
    if (window.clarity) window.clarity('consent', false);
  }

  /* ---------------------------- events ---------------------------- */

  function googleItems(items) {
    return (items || []).map(function (i) { return { item_id: String(i.id), quantity: i.quantity }; });
  }

  function adsConversion(label, data) {
    if (!window.gtag || !ids.gads || !label) return;
    var params = { send_to: ids.gads + '/' + label };
    if (data.value != null) { params.value = data.value; params.currency = CURRENCY; }
    if (data.id) params.transaction_id = data.id;
    window.gtag('event', 'conversion', params);
  }

  var SEND = {
    add_to_cart: function (d) {
      if (window.fbq) window.fbq('track', 'AddToCart', {
        content_ids: (d.items || []).map(function (i) { return String(i.id); }),
        content_type: 'product', value: d.value, currency: CURRENCY,
      });
      if (window.gtag && ids.ga4) window.gtag('event', 'add_to_cart', { currency: CURRENCY, value: d.value, items: googleItems(d.items) });
    },
    begin_checkout: function (d) {
      if (window.fbq) window.fbq('track', 'InitiateCheckout', { value: d.value, currency: CURRENCY, num_items: d.count });
      if (window.gtag && ids.ga4) window.gtag('event', 'begin_checkout', { currency: CURRENCY, value: d.value });
    },
    purchase: function (d) {
      if (window.fbq) window.fbq('track', 'Purchase', {
        value: d.value, currency: CURRENCY, content_type: 'product',
        contents: (d.items || []).map(function (i) { return { id: String(i.id), quantity: i.quantity }; }),
      }, { eventID: d.id });
      if (window.gtag && ids.ga4) window.gtag('event', 'purchase', {
        transaction_id: d.id, currency: CURRENCY, value: d.value, items: googleItems(d.items),
      });
      adsConversion(ids.gadsPurchase, d);
    },
    lead: function (d) {
      if (window.fbq) window.fbq('track', 'Lead', { content_name: 'Custom cake' }, { eventID: d.id });
      if (window.gtag && ids.ga4) window.gtag('event', 'generate_lead', { lead_source: 'custom_cake' });
      adsConversion(ids.gadsLead, { id: d.id });
    },
  };

  /** Send one event to every tool that is on, only after consent. Never pass personal data. */
  window.ssTrack = function (name, data) {
    if (!loaded || readConsent() !== 'yes' || !SEND[name]) return;
    SEND[name](data || {});
    if (window.clarity) window.clarity('event', name);
  };

  /* ---------------------------- the banner ---------------------------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** "A, B and C" */
  function list(names) {
    return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // The one line the bar shows. bannerText() is behind "Details".
  var SHORT_TEXT = 'We use cookies to improve the site and our ads.';

  function bannerText() {
    var tools = [];
    if (ids.ga4) tools.push('Google Analytics');
    if (ids.gads) tools.push('Google Ads');
    if (ids.clarity) tools.push('Microsoft Clarity');
    if (ids.meta) tools.push('the Meta Pixel');
    var text = 'We use ' + list(tools) + ' to see how people use this site and which ads bring them here. ';
    if (ids.clarity) text += 'Clarity records how the pages are used, with the order form hidden. ';
    return text + 'They see the pages you visit and what you order, but never your name, phone or address. Is that okay?';
  }

  function choose(value) {
    writeConsent(value);
    if (value === 'yes') load();
    else revoke();
    if (banner) banner.hidden = true;
  }

  function showBanner() {
    if (!banner) {
      banner = el('div', 'consent');
      banner.setAttribute('role', 'region');
      banner.setAttribute('aria-label', 'Tracking choices');
      var row = el('div', 'consent__row');
      var text = el('p', 'consent__text', SHORT_TEXT + ' ');
      var more = el('button', 'consent__link', 'Details');
      var details = el('p', 'consent__details', bannerText());
      more.type = 'button';
      more.setAttribute('aria-expanded', 'false');
      details.id = 'consent-details';
      details.hidden = true;
      more.setAttribute('aria-controls', details.id);
      more.addEventListener('click', function () {
        details.hidden = !details.hidden;
        more.setAttribute('aria-expanded', String(!details.hidden));
        banner.classList.toggle('consent--open', !details.hidden);
      });
      text.appendChild(more);
      var actions = el('div', 'consent__actions');
      var no = el('button', 'consent__btn consent__btn--quiet', 'No');
      var yes = el('button', 'consent__btn', 'Accept');
      no.type = 'button';
      yes.type = 'button';
      no.addEventListener('click', function () { choose('no'); });
      yes.addEventListener('click', function () { choose('yes'); });
      actions.appendChild(no);
      actions.appendChild(yes);
      // Two columns: the text (and the details) left, the buttons right.
      var copy = el('div', 'consent__copy');
      copy.appendChild(text);
      copy.appendChild(details);
      row.appendChild(copy);
      row.appendChild(actions);
      banner.appendChild(row);
      document.body.appendChild(banner);
    }
    banner.hidden = false;
  }

  /** A link in the footer, so a choice can be changed later. */
  function addFooterLink() {
    var foot = document.querySelector('.foot .wrap');
    if (!foot) return;
    var p = el('p');
    var link = el('button', 'consent__link', 'Tracking choices');
    link.type = 'button';
    link.addEventListener('click', showBanner);
    p.appendChild(link);
    foot.appendChild(p);
  }

  function start() {
    addFooterLink();
    var consent = readConsent();
    if (consent === 'yes') load();
    else if (consent !== 'no') showBanner();
  }

  // After every deferred script: cart.js first takes the GCash return key out
  // of the address bar, so no tool ever records it with the page address.
  var started = false;
  function startOnce() {
    if (started) return;
    started = true;
    start();
  }
  if (document.readyState === 'complete') startOnce();
  else {
    document.addEventListener('DOMContentLoaded', startOnce);
    window.addEventListener('load', startOnce);
  }
})();
