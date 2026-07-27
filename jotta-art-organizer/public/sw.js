const CACHE_NAME = 'jotta-art-organizer-shell-v1'
const SHELL_URLS = ['/']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  )
  self.clients.claim()
})

// Network-first for navigations/API calls (this app is useless offline —
// it's a thin client over live Jottacloud state), falling back to the
// cached shell only if the network is unreachable.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((res) => res ?? caches.match('/')))
  )
})
