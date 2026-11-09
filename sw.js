// Guarda la app para que abra rápido y sin cobertura. Los precios y las rutas siempre se piden a internet.
const CACHE = 'gasolineras-v4';
const ARCHIVOS = ['./', 'index.html', 'estilo.css', 'app.js', 'manifest.json',
  'iconos/icono-192.png', 'iconos/icono-512.png', 'iconos/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Primero internet; si no hay conexión, lo guardado.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
