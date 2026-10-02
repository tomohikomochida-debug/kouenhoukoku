/* 倒木リスク推定：電波のない現場でも開けるように、ページを端末に保存しておく。
   ネットにつながるときは最新版を取りに行き（4秒で諦める）、つながらないときは保存しておいた版を出す。
   ほかのアプリのページには手を出さない。 */
const CACHE = 'touboku-risk-v1';
const FILES = ['touboku_risk.html', 'apple-touch-icon.png', 'icon-192.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('touboku-risk-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  const name = u.pathname.split('/').pop();
  if (!FILES.includes(name)) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await Promise.race([fetch(e.request), new Promise((_, ng) => setTimeout(() => ng(new Error('timeout')), 4000))]);
      if (r.ok) await c.put(name, r.clone());
      return r;
    } catch (err) {
      return (await c.match(name)) || (await c.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
