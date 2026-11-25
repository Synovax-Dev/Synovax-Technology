// The vault's service worker has one job. Something shared to SYNOVAX from a
// phone's share menu arrives as /vault/share?title=…&text=…&url=…; it is turned
// into a #fragment right here, in the browser, so the shared text never reaches
// the server, not even its logs. Nothing is cached; every other request goes to
// the network as usual.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin || u.pathname !== '/vault/share') return;
  const q = new URLSearchParams();
  for (const k of ['title', 'text', 'url']) { const v = u.searchParams.get(k); if (v) q.set(k, v.slice(0, 100_000)); }
  e.respondWith(Response.redirect(`/vault/#share=${encodeURIComponent(q.toString())}`, 303));
});
