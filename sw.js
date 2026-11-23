// Guarda la app (y los trozos de mapa que ya has visto) para que abra rápido y funcione sin cobertura. Las rutas siempre se piden a internet.
const CACHE = 'gasolineras-v29';
const ARCHIVOS = ['./', 'index.html', 'estilo.css', 'app.js', 'manifest.json',
  'iconos/icono-192.png', 'iconos/icono-512.png', 'iconos/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== CACHE_MAPA).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Trozos (teselas) del mapa de OpenStreetMap: se guardan los que ya has visto para tenerlos sin cobertura.
const CACHE_MAPA = 'mapa-teselas-v1';
const MAX_TESELAS = 3000; // unos 50-60 MB como mucho
async function teselaGuardada(req) {
  const cache = await caches.open(CACHE_MAPA);
  const guardada = await cache.match(req);
  const edad = guardada ? Date.now() - Number(guardada.headers.get('x-guardado') || 0) : Infinity;
  if (guardada && edad < 30 * 864e5) return guardada; // vale 30 días; luego se vuelve a pedir
  let r;
  try { r = await fetch(req); } catch (err) { if (guardada) return guardada; throw err; }
  if (r.ok) {
    const copia = new Response(await r.clone().blob(), {
      headers: { 'Content-Type': r.headers.get('Content-Type') || 'image/png', 'x-guardado': String(Date.now()) },
    });
    cache.put(req, copia).then(async () => {
      const claves = await cache.keys();
      for (let i = 0; i < claves.length - MAX_TESELAS; i++) await cache.delete(claves[i]); // borra las más antiguas
    }).catch(() => {});
  }
  return r;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(teselaGuardada(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Primero internet; si no hay conexión, lo guardado.
  e.respondWith(
    // no-cache: pregunta siempre al servidor si hay versión nueva, para que los cambios lleguen antes.
    fetch(e.request.url, { cache: 'no-cache' })
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
