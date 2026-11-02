'use strict';
/* Order alerts. Shows a notification for each push and opens the admin when
   it is tapped. It does nothing else: no caching, no offline pages, so the
   admin is always loaded fresh from the server. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = {};
  }
  const title = typeof msg.title === 'string' ? msg.title : 'Sweeter Side';
  // Only our own pages are opened from a notification.
  const url = typeof msg.url === 'string' && msg.url.startsWith('/admin') ? msg.url : '/admin';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof msg.body === 'string' ? msg.body : 'Something new needs you.',
    icon: '/assets/Sweeter%20Side%20-%20PNG.png',
    badge: '/assets/Sweeter%20Side%20-%20PNG.png',
    tag: typeof msg.tag === 'string' ? msg.tag : undefined,
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = open.find((c) => new URL(c.url).pathname === url);
    if (same) {
      await same.focus();
      return same.navigate(url).catch(() => {});
    }
    return self.clients.openWindow(url);
  })());
});
