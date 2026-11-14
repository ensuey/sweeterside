'use strict';
/* The staging site: a test copy of the shop at staging.sweeterside.ph.
   STAGING=1 turns on these guards, so it is never taken for the real shop:
   - search engines are told not to list it: X-Robots-Tag on every response
     and a robots meta tag on every page;
   - there is no sitemap or llms.txt to point anyone at it;
   - tracking (Meta, Google, Clarity) is off, even if the IDs are set;
   - a live PayMongo key is refused, so no real money can move;
   - every page shows a Staging badge. */

const on = () => process.env.STAGING === '1';

// Crawling is allowed on purpose. A search engine only sees "noindex" on a
// page it may fetch; a page blocked in robots.txt can still be listed as a
// bare address if someone links to it.
const ROBOTS = 'User-agent: *\nAllow: /\n';

const NOINDEX = '<meta name="robots" content="noindex, nofollow">';

// Inline styles are allowed by the CSP. pointer-events: none, so it never
// covers a button on the POS.
const BADGE = '<div role="note" style="position:fixed;left:8px;bottom:8px;z-index:2147483647;'
  + 'pointer-events:none;background:#b00020;color:#fff;font:700 12px/1 system-ui,sans-serif;'
  + 'letter-spacing:.05em;padding:6px 10px;border-radius:999px;">STAGING · test site, orders are not real</div>';

/** On staging: a noindex tag in <head> (if the page has none) and the badge
    just inside <body>. Unchanged otherwise. */
function badge(html) {
  if (!on()) return html;
  let out = String(html);
  if (!/<meta name="robots"/i.test(out)) out = out.replace(/<head[^>]*>/i, (tag) => tag + NOINDEX);
  return out.replace(/<body[^>]*>/i, (tag) => tag + BADGE);
}

module.exports = { on, badge, ROBOTS };
