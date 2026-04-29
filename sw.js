// ===== SERVICE WORKER - StudyFlow =====
const CACHE_NAME = 'studyflow-v9';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/ia.js',  
  '/firebase.js',
  '/manifest.json',
];

// Install: cache all static assets
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Cacheia item-a-item para não abortar tudo se algum arquivo falhar.
    await Promise.allSettled(
      STATIC_ASSETS
        .filter((u) => !u.startsWith('http'))
        .map((u) => cache.add(new Request(u, { cache: 'reload' })))
    );
  })());
  self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for static, network-first for Firebase
self.addEventListener('fetch', (event) => {
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  // Navegação (app instalado / refresh): network-first com fallback robusto.
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('/index.html', response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match('/index.html');
        if (cached) return cached;
        return new Response(
          `<!doctype html><html lang="pt-BR"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
          <title>StudyFlow</title>
          <body style="margin:0;font-family:system-ui;background:#0d0f14;color:#f0f2f7;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px">
            <div>
              <div style="font-weight:800;font-size:18px;margin-bottom:6px">StudyFlow</div>
              <div style="color:#8b90a0;font-weight:700">Você está offline. Conecte-se e tente novamente.</div>
            </div>
          </body></html>`,
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  // Google Fonts: stale-while-revalidate
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        const networkFetch = fetch(event.request).then(res => {
          cache.put(event.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Firebase/Google APIs: always network, never cache
  if (
    url.hostname === 'firestore.googleapis.com' ||
    url.hostname === 'identitytoolkit.googleapis.com' ||
    url.hostname === 'securetoken.googleapis.com' ||
    url.hostname === 'firebaseinstallations.googleapis.com' ||
    url.hostname.endsWith('.firebaseapp.com') ||
    url.hostname.endsWith('.web.app') ||
    url.hostname.includes('firebase')
  ) {
    return; // Let browser handle normally
  }

  // Static assets: cache-first
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;

      try {
        const response = await fetch(event.request);
        if (response && response.status === 200) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        // Se não tem cache, devolve erro explícito ao invés de undefined (evita ERR_FAILED).
        return Response.error();
      }
    })()
  );
});
