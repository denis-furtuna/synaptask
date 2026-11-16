// Service worker: offline app shell, push notifications.
// Bump VERSION when you deploy so old caches are dropped.
const VERSION = 'synaptask-v1';
const SHELL = [
  './', 'index.html', 'consent.html', 'manifest.webmanifest',
  'css/themes.css', 'css/app.css', 'vendor/supabase.js',
  'js/app.js', 'js/auth.js', 'js/backend.js', 'js/config.js', 'js/consent.js', 'js/ideas.js', 'js/main.js',
  'js/recurrence.js', 'js/settings.js', 'js/store.js', 'js/tasks.js', 'js/theme-boot.js', 'js/util.js',
  'js/vault.js', 'js/work.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Same-origin files: network first (always fresh when online), cache when offline or slow.
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const net = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
  try {
    const res = await Promise.race([net, timeout]);
    if (res) return res;
  } catch { /* offline */ }
  const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (hit) return hit;
  if (req.mode === 'navigate') {
    const shell = await cache.match('index.html');
    if (shell) return shell;
  }
  return net; // nothing cached: wait for the network after all
}

// Fonts never change: cache first.
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  else if (FONT_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(req));
  // everything else (the Supabase API) goes straight to the network, never cached
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(String(d.title || 'Synaptask').slice(0, 120), {
    body: String(d.body || '').slice(0, 300),
    tag: d.tag ? String(d.tag).slice(0, 100) : undefined,
    icon: 'icons/icon-192.png',
    data: { url: typeof d.url === 'string' ? d.url : './#/today' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let target = new URL('./#/today', self.registration.scope);
  try {
    const u = new URL(e.notification.data?.url || './#/today', self.registration.scope);
    if (u.origin === self.location.origin) target = u; // never open other sites from a notification
  } catch { /* keep default */ }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === target.origin && 'focus' in w) {
        await w.focus();
        if ('navigate' in w) await w.navigate(target.href).catch(() => null);
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
