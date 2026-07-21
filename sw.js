/* Ugly Donuts Franchise Portal service worker.
   NO CACHING on purpose: the site is redeployed often and cached copies
   would keep serving stale builds. Network passthrough only. */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

/* No fetch handler: caching is intentionally disabled, and an empty fetch
   listener only adds per-request overhead (Chrome flags it as no-op). */

/* Push: payload is JSON {title, body, badge} */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || 'Franchise Portal';
  const opts = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: data.tag || 'ugly-portal',
    renotify: true,
    data: { url: (data.data && data.data.url) || '/' }
  };
  const work = [self.registration.showNotification(title, opts)];
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
    work.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  e.waitUntil(Promise.all(work));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) {
          c.focus();
          // Always navigate (even to '/') so a backgrounded window reloads the
          // latest build instead of showing a stale one.
          if ('navigate' in c) return c.navigate(url).catch(()=>{});
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
