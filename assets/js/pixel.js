/* Sweeter Side — Meta (Facebook) Pixel, with consent first.
   The server adds this file only when the owner has saved a Pixel ID. Meta's
   script is loaded only after the visitor taps Accept, and the choice is kept
   in this browser. Events carry item ids, quantities and totals, never a
   name, phone or address. cart.js and cakes.js call window.ssPixel.track(). */
(function () {
  'use strict';

  var CONSENT_KEY = 'sweeterside-pixel-consent'; // 'yes' or 'no'
  var SCRIPT_URL = 'https://connect.facebook.net/en_US/fbevents.js';

  var meta = document.querySelector('meta[name="meta-pixel"]');
  var pixelId = meta ? meta.getAttribute('content') : '';
  if (!/^\d{10,20}$/.test(pixelId || '')) return;

  var loaded = false;
  var banner = null;

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }

  function writeConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch (e) { /* private mode: ask again next visit */ }
  }

  /** Meta's standard loader: a queue until fbevents.js arrives. */
  function load() {
    if (loaded) {
      window.fbq('consent', 'grant');
      return;
    }
    loaded = true;
    var fbq = window.fbq = function () {
      if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
      else fbq.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    var script = document.createElement('script');
    script.async = true;
    script.src = SCRIPT_URL;
    document.head.appendChild(script);
    fbq('init', pixelId);
    fbq('track', 'PageView');
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function choose(value) {
    writeConsent(value);
    if (value === 'yes') load();
    else if (loaded) window.fbq('consent', 'revoke');
    if (banner) banner.hidden = true;
  }

  function showBanner() {
    if (!banner) {
      banner = el('div', 'consent');
      banner.setAttribute('role', 'region');
      banner.setAttribute('aria-label', 'Tracking choices');
      banner.appendChild(el('p', 'consent__text',
        'We use the Meta Pixel to see which Facebook and Instagram ads bring people here. '
        + 'It tells Meta which pages you visit and what you order, but never your name, phone or address. Is that okay?'));
      var actions = el('div', 'consent__actions');
      var no = el('button', 'consent__btn consent__btn--quiet', 'No thanks');
      var yes = el('button', 'consent__btn', 'Accept');
      no.type = 'button';
      yes.type = 'button';
      no.addEventListener('click', function () { choose('no'); });
      yes.addEventListener('click', function () { choose('yes'); });
      actions.appendChild(no);
      actions.appendChild(yes);
      banner.appendChild(actions);
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

  window.ssPixel = {
    /** Send a standard event, only after consent. Never pass personal data. */
    track: function (name, data, eventId) {
      if (!loaded || readConsent() !== 'yes') return;
      if (eventId) window.fbq('track', name, data || {}, { eventID: eventId });
      else window.fbq('track', name, data || {});
    },
  };

  function start() {
    addFooterLink();
    var consent = readConsent();
    if (consent === 'yes') load();
    else if (consent !== 'no') showBanner();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
