// Gasolineras en ruta: busca las gasolineras y cargadores a lo largo de un recorrido
// y calcula cuáles compensan teniendo en cuenta el desvío.
'use strict';

const $ = (s) => document.querySelector(s);
const NOMBRES = { g95: 'Gasolina 95', g98: 'Gasolina 98', diesel: 'Diésel', dieselp: 'Diésel Premium', glp: 'GLP' };
const AJUSTES_DEF = { combustible: 'g95', consumo: 6.5, litros: 40, desvio: 3, precioRef: '' };
const FACTOR_CARRETERA = 1.3;   // la distancia por carretera suele ser ~30 % mayor que en línea recta
const TRAMO_KM = 100;           // tamaño de los tramos de la pestaña "Por tramos"

let datos = null;               // { fecha, campos, e: [[lat, lon, rotulo, ...], ...] }
let mapa = null, capaRuta = null, capaEstaciones = null, capaCargadores = null;
let viaje = null;               // { origen, destino, puntos, km, min }

// ---------- Utilidades ----------

function estado(texto, error = false) {
  const el = $('#estado');
  el.textContent = texto;
  el.classList.toggle('error', error);
}

function euros(n) {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
}

function precioTxt(n) {
  return n.toLocaleString('es-ES', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' €/L';
}

function km1(n) {
  return n.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function escapar(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function mediana(lista) {
  const v = [...lista].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function leerAjustes() {
  try { return { ...AJUSTES_DEF, ...JSON.parse(localStorage.getItem('ajustes') || '{}') }; }
  catch { return { ...AJUSTES_DEF }; }
}

function guardarAjustes(a) {
  try { localStorage.setItem('ajustes', JSON.stringify(a)); } catch { /* sin almacenamiento */ }
}

function ajustesDelFormulario() {
  return {
    combustible: $('#combustible').value,
    consumo: parseFloat($('#consumo').value) || AJUSTES_DEF.consumo,
    litros: parseFloat($('#litros').value) || AJUSTES_DEF.litros,
    desvio: parseFloat($('#desvio').value) || AJUSTES_DEF.desvio,
    precioRef: $('#precioRef').value,
  };
}

// ---------- Datos externos ----------

async function cargarPrecios() {
  if (datos) return datos;
  const r = await fetch('data/estaciones.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('No encuentro los precios (data/estaciones.json). Ejecuta el script de actualizar precios.');
  datos = await r.json();
  $('#fechaDatos').textContent = `Precios actualizados: ${datos.fecha}`;
  return datos;
}

async function geocodificar(texto) {
  const coord = texto.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coord) return { lat: +coord[1], lon: +coord[2], nombre: 'Mi ubicación' };
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=es'
    + '&countrycodes=es,pt,fr,ad&q=' + encodeURIComponent(texto);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No he podido buscar "${texto}"`);
  const j = await r.json();
  if (!j.length) throw new Error(`No encuentro "${texto}". Prueba a escribirlo de otra forma.`);
  return { lat: +j[0].lat, lon: +j[0].lon, nombre: j[0].display_name.split(',').slice(0, 2).join(',') };
}

async function calcularRuta(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}`
    + '?overview=full&geometries=geojson';
  const r = await fetch(url);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error('No he podido calcular la ruta entre esos dos sitios.');
  const ruta = j.routes[0];
  return {
    coords: ruta.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    km: ruta.distance / 1000,
    min: ruta.duration / 60,
  };
}

// ---------- Geometría de la ruta ----------

// Convierte la línea de la ruta en puntos cada ~0,5 km, con el km acumulado de cada uno.
function muestrear(coords, paso = 0.5) {
  const pts = [{ lat: coords[0][0], lon: coords[0][1], km: 0 }];
  let acumulado = 0;
  for (let i = 1; i < coords.length; i++) {
    const [la1, lo1] = coords[i - 1], [la2, lo2] = coords[i];
    const d = distKm(la1, lo1, la2, lo2);
    const n = Math.max(1, Math.ceil(d / paso));
    for (let k = 1; k <= n; k++) {
      const t = k / n, km = acumulado + d * t;
      const ultimo = i === coords.length - 1 && k === n;
      if (km - pts[pts.length - 1].km >= paso || ultimo) {
        pts.push({ lat: la1 + (la2 - la1) * t, lon: lo1 + (lo2 - lo1) * t, km });
      }
    }
    acumulado += d;
  }
  return pts;
}

// Índice en rejilla para encontrar rápido el punto de la ruta más cercano a un sitio.
function crearBuscadorCercano(pts) {
  const CELDA = 0.05; // ~5 km
  const rejilla = new Map();
  pts.forEach((p, i) => {
    const k = Math.floor(p.lat / CELDA) + ',' + Math.floor(p.lon / CELDA);
    if (!rejilla.has(k)) rejilla.set(k, []);
    rejilla.get(k).push(i);
  });
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  return function cercano(lat, lon, maxKm) {
    const margen = maxKm / 70 + 0.01;
    if (lat < minLat - margen || lat > maxLat + margen || lon < minLon - margen * 1.5 || lon > maxLon + margen * 1.5) return null;
    const radio = Math.ceil(maxKm / 4) + 1;
    const ci = Math.floor(lat / CELDA), cj = Math.floor(lon / CELDA);
    let mejor = Infinity, idx = -1;
    for (let di = -radio; di <= radio; di++) {
      for (let dj = -radio; dj <= radio; dj++) {
        const lista = rejilla.get((ci + di) + ',' + (cj + dj));
        if (!lista) continue;
        for (const i of lista) {
          const d = distKm(lat, lon, pts[i].lat, pts[i].lon);
          if (d < mejor) { mejor = d; idx = i; }
        }
      }
    }
    return mejor <= maxKm ? { dist: mejor, km: pts[idx].km } : null;
  };
}

// ---------- Cálculo de qué compensa ----------

function analizarGasolineras(aj) {
  const col = datos.campos.indexOf(aj.combustible);
  const cercano = crearBuscadorCercano(viaje.puntos);
  const lista = [];
  for (const e of datos.e) {
    const precio = e[col];
    if (precio == null) continue;
    const c = cercano(e[0], e[1], aj.desvio);
    if (!c) continue;
    lista.push({
      lat: e[0], lon: e[1], rotulo: e[2], localidad: e[3], direccion: e[4], horario: e[5],
      precio, dist: c.dist, km: c.km,
      desvioKm: 2 * c.dist * FACTOR_CARRETERA, // ida y vuelta desde la ruta
    });
  }
  if (!lista.length) return { lista, ref: null };

  const refManual = parseFloat(aj.precioRef);
  const ref = refManual > 0 ? refManual : mediana(lista.map((g) => g.precio));
  for (const g of lista) {
    g.costeDesvio = g.desvioKm * (aj.consumo / 100) * g.precio;
    g.ahorro = aj.litros * (ref - g.precio) - g.costeDesvio;
  }
  return { lista, ref, refManual: refManual > 0 };
}

// ---------- Pintar resultados ----------

function iniciarMapa() {
  if (mapa) return;
  mapa = L.map('mapa', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(mapa);
}

function enlacesNavegacion(lat, lon) {
  const o = viaje.origen, d = viaje.destino;
  const google = 'https://www.google.com/maps/dir/?api=1&travelmode=driving'
    + `&origin=${o.lat},${o.lon}&destination=${d.lat},${d.lon}&waypoints=${lat},${lon}`;
  const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
  const apple = `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d`;
  return `<div class="enlaces">
    <a href="${google}" target="_blank" rel="noopener">Google Maps (como parada)</a>
    <a href="${waze}" target="_blank" rel="noopener">Waze</a>
    <a href="${apple}" target="_blank" rel="noopener">Apple Maps</a>
  </div>`;
}

function tarjetaGasolinera(g, ref) {
  const signo = g.ahorro >= 0 ? 'bien' : 'mal';
  const textoAhorro = g.ahorro >= 0 ? `Ahorras ${euros(g.ahorro)}` : `Pierdes ${euros(-g.ahorro)}`;
  return `<article class="tarjeta">
    <div class="cabeza">
      <span class="nombre">${escapar(g.rotulo)}</span>
      <span class="precio">${precioTxt(g.precio)}</span>
    </div>
    <div class="datos">${escapar(g.localidad)} · ${escapar(g.direccion)}</div>
    <div class="datos">Km ${Math.round(g.km)} de la ruta · a ${km1(g.dist)} km de la carretera
      (desvío aprox. ${km1(g.desvioKm)} km, ${euros(g.costeDesvio)})</div>
    <div class="datos">Horario: ${escapar(g.horario) || 'sin datos'}</div>
    <div class="ahorro ${signo}">${textoAhorro} frente a ${precioTxt(ref)}</div>
    ${enlacesNavegacion(g.lat, g.lon)}
  </article>`;
}

function pintarGasolineras(res, aj) {
  const { lista, ref } = res;
  capaEstaciones.clearLayers();
  if (!lista.length) {
    $('#p-compensan').innerHTML = '<p class="nota">No hay gasolineras con ese combustible cerca de la ruta. Prueba a subir el desvío máximo.</p>';
    $('#p-tramos').innerHTML = '';
    return;
  }

  const ordenadas = [...lista].sort((a, b) => b.ahorro - a.ahorro);
  const top = ordenadas.slice(0, 15);
  const textoRef = res.refManual ? 'tu precio habitual' : 'el precio medio de la ruta';
  $('#p-compensan').innerHTML =
    `<p class="nota">Comparado con ${textoRef} (${precioTxt(ref)}), echando ${aj.litros} L y descontando lo que gastas en el desvío.</p>`
    + top.map((g) => tarjetaGasolinera(g, ref)).join('');

  // Por tramos: la que más compensa en cada tramo de 100 km
  const tramos = new Map();
  for (const g of lista) {
    const t = Math.floor(g.km / TRAMO_KM);
    if (!tramos.has(t) || g.ahorro > tramos.get(t).ahorro) tramos.set(t, g);
  }
  $('#p-tramos').innerHTML =
    '<p class="nota">La mejor opción de cada tramo, por si necesitas repostar en una zona concreta del viaje.</p>'
    + [...tramos.keys()].sort((a, b) => a - b).map((t) =>
      `<p class="tramo-titulo">Km ${t * TRAMO_KM} a ${Math.min((t + 1) * TRAMO_KM, Math.round(viaje.km))}</p>`
      + tarjetaGasolinera(tramos.get(t), ref)).join('');

  // Mapa: verde si compensa, rojo si no; las 15 mejores más grandes
  const mejores = new Set(top);
  for (const g of lista) {
    L.circleMarker([g.lat, g.lon], {
      radius: mejores.has(g) ? 8 : 4,
      color: g.ahorro >= 0 ? '#15803d' : '#b91c1c',
      fillOpacity: mejores.has(g) ? 0.9 : 0.5,
      weight: 1,
    }).bindPopup(`<b>${escapar(g.rotulo)}</b><br>${precioTxt(g.precio)}<br>${escapar(g.localidad)}<br>`
      + (g.ahorro >= 0 ? `Ahorras ${euros(g.ahorro)}` : `Pierdes ${euros(-g.ahorro)}`))
      .addTo(capaEstaciones);
  }
}

function pintarResumen(res, aj) {
  const h = Math.floor(viaje.min / 60), m = Math.round(viaje.min % 60);
  const mejor = res.lista.length ? [...res.lista].sort((a, b) => b.ahorro - a.ahorro)[0] : null;
  $('#resumen').innerHTML = `
    <div><b>${Math.round(viaje.km)} km</b><span>${h} h ${m} min</span></div>
    <div><b>${res.lista.length}</b><span>gasolineras a ≤ ${aj.desvio} km</span></div>
    <div><b>${res.ref ? precioTxt(res.ref) : '–'}</b><span>${res.refManual ? 'tu precio' : 'precio medio'} ${NOMBRES[aj.combustible]}</span></div>
    <div><b>${mejor ? euros(Math.max(0, mejor.ahorro)) : '–'}</b><span>ahorro máximo</span></div>`;
}

// ---------- Cargadores eléctricos (OpenStreetMap) ----------

function potenciaMaxKw(tags) {
  let max = 0;
  for (const [k, v] of Object.entries(tags)) {
    if (!/output$|maxpower$/.test(k)) continue;
    for (const trozo of String(v).split(/[;,]/)) {
      const m = trozo.match(/([\d.]+)\s*(kw|w)?/i);
      if (!m) continue;
      let n = parseFloat(m[1]);
      if (m[2] && m[2].toLowerCase() === 'w') n /= 1000;
      if (n > max) max = n;
    }
  }
  return max;
}

function conectores(tags) {
  const nombres = {
    type2: 'Tipo 2', type2_combo: 'CCS2', chademo: 'CHAdeMO', schuko: 'Schuko',
    type2_cable: 'Tipo 2 (cable)', tesla_supercharger: 'Tesla', type1: 'Tipo 1', type1_combo: 'CCS1',
  };
  const lista = [];
  for (const [k, v] of Object.entries(tags)) {
    const m = k.match(/^socket:([a-z0-9_]+)$/);
    if (m && v !== 'no' && v !== '0') lista.push(`${nombres[m[1]] || m[1]}${/^\d+$/.test(v) ? ' ×' + v : ''}`);
  }
  return lista;
}

async function buscarCargadores() {
  if (!viaje) return;
  const aj = ajustesDelFormulario();
  const boton = $('#btnCargadores');
  boton.disabled = true;
  $('#listaCargadores').innerHTML = '<p class="nota">Buscando cargadores… puede tardar unos segundos.</p>';
  try {
    const pts = viaje.puntos;
    const salto = Math.max(1, Math.ceil(pts.length / 150));
    const linea = [];
    for (let i = 0; i < pts.length; i += salto) linea.push(pts[i].lat.toFixed(4), pts[i].lon.toFixed(4));
    const ult = pts[pts.length - 1];
    linea.push(ult.lat.toFixed(4), ult.lon.toFixed(4));
    const consulta = `[out:json][timeout:90];nwr["amenity"="charging_station"](around:${Math.round(aj.desvio * 1000)},${linea.join(',')});out center tags;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(consulta),
    });
    if (!r.ok) throw new Error('El servicio de cargadores está saturado. Prueba otra vez en un minuto.');
    const j = await r.json();

    const cercano = crearBuscadorCercano(pts);
    const soloRapidos = $('#soloRapidos').checked;
    let lista = j.elements.map((el) => {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      const t = el.tags || {};
      const c = lat != null ? cercano(lat, lon, aj.desvio + 1) : null;
      return c && {
        lat, lon, dist: c.dist, km: c.km,
        nombre: t.name || t.operator || t.network || t.brand || 'Punto de carga',
        operador: t.operator || t.network || '',
        kw: potenciaMaxKw(t),
        conectores: conectores(t),
        precio: t.charge || (t.fee === 'no' ? 'Gratis' : ''),
        plazas: t.capacity || '',
      };
    }).filter(Boolean);
    if (soloRapidos) lista = lista.filter((c) => c.kw >= 50);
    lista.sort((a, b) => a.km - b.km);

    capaCargadores.clearLayers();
    for (const c of lista) {
      L.circleMarker([c.lat, c.lon], { radius: 6, color: '#2563eb', fillOpacity: 0.8, weight: 1 })
        .bindPopup(`<b>⚡ ${escapar(c.nombre)}</b><br>${c.kw ? c.kw + ' kW' : 'potencia sin datos'}`)
        .addTo(capaCargadores);
    }

    $('#listaCargadores').innerHTML = lista.length
      ? `<p class="nota">${lista.length} cargadores a ≤ ${aj.desvio} km de la ruta, ordenados por kilómetro. Los datos vienen de OpenStreetMap y casi nunca incluyen el precio: confírmalo en la app del operador.</p>`
        + lista.map((c) => `<article class="tarjeta">
          <div class="cabeza"><span class="nombre">⚡ ${escapar(c.nombre)}</span>
            <span class="precio">${c.kw ? c.kw + ' kW' : ''}</span></div>
          <div class="datos">Km ${Math.round(c.km)} de la ruta · a ${km1(c.dist)} km de la carretera</div>
          <div class="datos">${c.conectores.length ? 'Conectores: ' + escapar(c.conectores.join(', ')) : 'Conectores sin datos'}${c.plazas ? ' · ' + escapar(c.plazas) + ' plazas' : ''}</div>
          ${c.precio ? `<div class="datos">Precio: ${escapar(c.precio)}</div>` : ''}
          ${c.operador && c.operador !== c.nombre ? `<div class="datos">Operador: ${escapar(c.operador)}</div>` : ''}
          ${enlacesNavegacion(c.lat, c.lon)}
        </article>`).join('')
      : '<p class="nota">No he encontrado cargadores con esos filtros cerca de la ruta.</p>';
  } catch (err) {
    $('#listaCargadores').innerHTML = `<p class="nota">${escapar(err.message || 'No he podido buscar cargadores.')}</p>`;
  } finally {
    boton.disabled = false;
  }
}

// ---------- Flujo principal ----------

async function buscar(ev) {
  ev.preventDefault();
  const aj = ajustesDelFormulario();
  guardarAjustes(aj);
  const boton = $('#btnBuscar');
  boton.disabled = true;
  try {
    estado('Cargando precios…');
    await cargarPrecios();
    estado('Buscando origen y destino…');
    const [origen, destino] = await Promise.all([geocodificar($('#origen').value), geocodificar($('#destino').value)]);
    estado('Calculando la ruta…');
    const ruta = await calcularRuta(origen, destino);
    viaje = { origen, destino, puntos: muestrear(ruta.coords), km: ruta.km, min: ruta.min };

    estado('Buscando gasolineras en la ruta…');
    const res = analizarGasolineras(aj);

    $('#resultados').hidden = false;
    iniciarMapa();
    if (capaRuta) capaRuta.remove();
    capaRuta = L.polyline(ruta.coords, { color: '#0f766e', weight: 5, opacity: 0.8 }).addTo(mapa);
    if (!capaEstaciones) capaEstaciones = L.layerGroup().addTo(mapa);
    if (!capaCargadores) capaCargadores = L.layerGroup().addTo(mapa);
    capaCargadores.clearLayers();
    $('#listaCargadores').innerHTML = '';
    mapa.invalidateSize();
    mapa.fitBounds(capaRuta.getBounds(), { padding: [20, 20] });

    pintarResumen(res, aj);
    pintarGasolineras(res, aj);
    estado(`${origen.nombre} → ${destino.nombre}`);
  } catch (err) {
    console.error(err);
    estado(err.message || 'Algo ha fallado. Inténtalo otra vez.', true);
  } finally {
    boton.disabled = false;
  }
}

function usarUbicacion() {
  if (!navigator.geolocation) { estado('Tu navegador no permite usar la ubicación.', true); return; }
  estado('Buscando tu ubicación…');
  navigator.geolocation.getCurrentPosition(
    (p) => { $('#origen').value = `${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`; estado(''); },
    () => estado('No he podido obtener tu ubicación. Revisa los permisos.', true),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}

function cambiarPestana(nombre) {
  document.querySelectorAll('.pestana').forEach((b) => b.classList.toggle('activa', b.dataset.pestana === nombre));
  for (const p of ['compensan', 'tramos', 'cargadores']) $('#p-' + p).hidden = p !== nombre;
}

function iniciar() {
  const aj = leerAjustes();
  $('#combustible').value = aj.combustible;
  $('#consumo').value = aj.consumo;
  $('#litros').value = aj.litros;
  $('#desvio').value = aj.desvio;
  $('#precioRef').value = aj.precioRef;

  $('#formulario').addEventListener('submit', buscar);
  $('#btnUbicacion').addEventListener('click', usarUbicacion);
  $('#btnCargadores').addEventListener('click', buscarCargadores);
  document.querySelectorAll('.pestana').forEach((b) => b.addEventListener('click', () => cambiarPestana(b.dataset.pestana)));

  cargarPrecios().catch(() => { /* se avisa al buscar */ });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

iniciar();
