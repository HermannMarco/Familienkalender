const CACHE = 'familienkalender-v36';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/firebase-config.js',
  './js/app.js',
  './icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('firestore.googleapis.com') ||
      e.request.url.includes('firebase') ||
      e.request.url.includes('gstatic.com')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
      return cached || network;
    })
  );
});

// Push-Erinnerungen
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try { payload = event.data.json(); }
    catch { payload = { title: 'Familienkalender', body: event.data.text() }; }
  }
  const title = payload.title || 'Familienkalender';
  const options = {
    body: payload.body || '',
    icon: './icons/icon.svg',
    badge: './icons/icon.svg',
    tag: payload.tag || `event-${Date.now()}`,
    data: payload.data || {},
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const params = new URLSearchParams();
  if (data.eventId) params.set('openEvent', data.eventId);
  if (data.date) params.set('date', data.date);
  const targetUrl = `./${params.toString() ? '?' + params.toString() : ''}`;

  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.includes(self.registration.scope) || c.url.includes('/Familienkalender/') || c.url.includes('localhost')) {
        await c.focus();
        c.postMessage({ type: 'open-event', eventId: data.eventId, date: data.date });
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
