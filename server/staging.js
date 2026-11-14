'use strict';
/* The staging site: a test copy of the shop at staging.sweeterside.ph.
   STAGING=1 turns on these guards, so it is never taken for the real shop:
   - search engines are told to stay away (robots.txt and X-Robots-Tag);
   - tracking (Meta, Google, Clarity) is off, even if the IDs are set;
   - a live PayMongo key is refused, so no real money can move;
   - every page shows a Staging badge. */

const on = () => process.env.STAGING === '1';

const ROBOTS = 'User-agent: *\nDisallow: /\n';

// Inline styles are allowed by the CSP. pointer-events: none, so it never
// covers a button on the POS.
const BADGE = '<div role="note" style="position:fixed;left:8px;bottom:8px;z-index:2147483647;'
  + 'pointer-events:none;background:#b00020;color:#fff;font:700 12px/1 system-ui,sans-serif;'
  + 'letter-spacing:.05em;padding:6px 10px;border-radius:999px;">STAGING · test site, orders are not real</div>';

/** Put the badge just inside <body> on staging; unchanged otherwise. */
function badge(html) {
  if (!on()) return html;
  return String(html).replace(/<body[^>]*>/i, (tag) => tag + BADGE);
}

module.exports = { on, badge, ROBOTS };
