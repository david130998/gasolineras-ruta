// Gasolineras en ruta: busca las gasolineras y cargadores a lo largo de un recorrido
// y calcula cuáles compensan teniendo en cuenta el desvío.
'use strict';

const $ = (s) => document.querySelector(s);
const NOMBRES = { g95: 'Gasolina 95', g98: 'Gasolina 98', diesel: 'Diésel', dieselp: 'Diésel Premium', glp: 'GLP' };
const AJUSTES_DEF = { combustible: 'g95', consumo: 6.5, litros: 40, desvio: 3, precioRef: '', valorHora: 10, destino: '' };
const MAX_AFINAR = 60;          // gasolineras cuyo desvío se calcula por carretera de verdad
const FACTOR_CARRETERA = 1.3;   // la distancia por carretera suele ser ~30 % mayor que en línea recta
const TRAMO_KM = 100;           // tamaño de los tramos de la pestaña "Por tramos"

let datos = null;               // { fecha, campos, e: [[lat, lon, rotulo, ...], ...] }
let mapa = null, capaRuta = null, capaEstaciones = null, capaCargadores = null;
let mapaCargar = null, capaCargar = null;
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

// Etiqueta fija con el precio encima del punto del mapa ("1,299").
// Las secundarias solo se ven al acercar el mapa, para que no se amontonen.
// Escala de colores por precio: entre la más barata y la más cara de lo que se ve en el mapa,
// partida en hasta 6 tramos con cortes redondos (medio céntimo, 1, 2, 3, 5, 6, 10 céntimos… según la diferencia).
// Los colores siempre van de verde oscuro (barata) a granate (cara).
const PALETA_PRECIO = ['#166534', '#22c55e', '#eab308', '#f97316', '#dc2626', '#7f1d1d'];
const PASOS_MILESIMAS = [5, 10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 500];
const MAX_TRAMOS = 6;
let escala = { base: 0, paso: 50, tramos: 1 }; // base y paso en milésimas de euro
const mil = (precio) => Math.round(precio * 1000);
function nivelPrecio(precio) {
  return Math.min(escala.tramos - 1, Math.max(0, Math.floor((mil(precio) - escala.base) / escala.paso)));
}
function calcularEscala(minimo, maximo) {
  const lo = mil(minimo), hi = mil(maximo);
  for (const paso of PASOS_MILESIMAS) {
    const base = Math.floor(lo / paso) * paso;
    const tramos = Math.floor((hi - base) / paso) + 1;
    if (tramos <= MAX_TRAMOS) return { base, paso, tramos };
  }
  const paso = PASOS_MILESIMAS[PASOS_MILESIMAS.length - 1];
  return { base: Math.floor(lo / paso) * paso, paso, tramos: MAX_TRAMOS };
}
function colorNivel(i) {
  const n = escala.tramos;
  if (n <= 1) return PALETA_PRECIO[0];
  const t = (i / (n - 1)) * (PALETA_PRECIO.length - 1);
  const a = Math.floor(t), b = Math.min(a + 1, PALETA_PRECIO.length - 1), f = t - a;
  const rgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const [ca, cb] = [rgb(PALETA_PRECIO[a]), rgb(PALETA_PRECIO[b])];
  return '#' + ca.map((v, k) => Math.round(v + (cb[k] - v) * f).toString(16).padStart(2, '0')).join('');
}
function textoNivel(i) {
  const [r, g, b] = [1, 3, 5].map((k) => parseInt(colorNivel(i).slice(k, k + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1c1917' : '#fff';
}
function pintarLeyenda(minimo, maximo) {
  escala = calcularEscala(minimo, maximo);
  const dec = escala.paso % 10 ? 3 : 2;
  const fmt = (m) => (m / 1000).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const css = [];
  const trozos = [];
  for (let i = 0; i < escala.tramos; i++) {
    const desde = escala.base + i * escala.paso;
    css.push(`.etiqueta-precio.nivel-${i}{background:${colorNivel(i)};color:${textoNivel(i)}}`);
    trozos.push(`<span style="background:${colorNivel(i)};color:${textoNivel(i)}">${fmt(desde)}–${fmt(desde + escala.paso)}</span>`);
  }
  let estilo = document.getElementById('estiloNiveles');
  if (!estilo) { estilo = document.createElement('style'); estilo.id = 'estiloNiveles'; document.head.appendChild(estilo); }
  estilo.textContent = css.join('\n');
  const el = $('#leyenda');
  if (!el) return;
  el.innerHTML = trozos.join('');
  el.hidden = false;
}

// "prioridad": 0 = la que más compensa. Si dos etiquetas se pisan, se queda la de menor prioridad.
function etiquetaPrecio(marcador, precio, principal, prioridad = 999, nivel = 0) {
  const txt = precio.toLocaleString('es-ES', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  marcador.options.prioridad = prioridad;
  marcador.options.precio = precio;
  marcador.options.principal = principal;
  marcador.bindTooltip(txt, {
    permanent: true, direction: 'top', offset: [0, -6],
    className: `etiqueta-precio nivel-${nivel}` + (principal ? ' principal' : ''),
  });
  return marcador;
}

// Ajusta la escala de colores (mínimo y máximo) a las gasolineras que se ven ahora en el mapa.
function recolorear() {
  if (!mapa || !capaEstaciones) return;
  const zona = mapa.getBounds();
  const marcas = capaEstaciones.getLayers().filter((m) => m.options.precio != null);
  let vistas = marcas.filter((m) => zona.contains(m.getLatLng()));
  if (!vistas.length) vistas = marcas;
  if (!vistas.length) return;
  const precios = vistas.map((m) => m.options.precio);
  pintarLeyenda(Math.min(...precios), Math.max(...precios));
  for (const m of marcas) {
    const nivel = nivelPrecio(m.options.precio);
    const color = colorNivel(nivel);
    m.setStyle({ fillColor: color, color: m.options.principal ? '#111827' : color });
    const t = m.getTooltip();
    if (!t) continue;
    t.options.className = `etiqueta-precio nivel-${nivel}` + (m.options.principal ? ' principal' : '');
    const el = t.getElement();
    if (el) el.className = el.className.replace(/\bnivel-\d+\b/, `nivel-${nivel}`);
  }
}
function actualizarMapa() {
  recolorear();
  evitarSolapes();
}

// Oculta las etiquetas que se solapan con otra más importante. Se repite al mover o hacer zoom.
function evitarSolapes() {
  if (!mapa || !capaEstaciones) return;
  const marcas = [];
  capaEstaciones.eachLayer((m) => { const t = m.getTooltip && m.getTooltip(); if (t && t.getElement()) marcas.push(m); });
  marcas.sort((a, b) => a.options.prioridad - b.options.prioridad);
  const ocupadas = [];
  for (const m of marcas) {
    const el = m.getTooltip().getElement();
    el.style.visibility = 'visible';
    const r = el.getBoundingClientRect();
    const pisa = ocupadas.some((o) => r.left < o.right + 2 && r.right > o.left - 2 && r.top < o.bottom + 2 && r.bottom > o.top - 2);
    if (pisa) el.style.visibility = 'hidden';
    else ocupadas.push(r);
  }
}

function precioTxt(n) {
  return n.toLocaleString('es-ES', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' €/L';
}

function kwTxt(n) {
  return n.toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' kW';
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
    valorHora: parseFloat($('#valorHora').value) >= 0 ? parseFloat($('#valorHora').value) : AJUSTES_DEF.valorHora,
    destino: $('#destino').value,
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
    // Estimación inicial (luego se afina por carretera con OSRM para las mejores)
    g.extraKm = g.desvioKm;
    g.extraMin = (g.desvioKm / 40) * 60 + (g.dist > 0.3 ? 2 : 0); // ~40 km/h fuera de la autovía + salir y volver a entrar
    g.real = false;
    puntuar(g, ref, aj);
  }
  return { lista, ref, refManual: refManual > 0 };
}

// El algoritmo: lo que ahorras en el depósito menos lo que te cuesta desviarte (combustible + tiempo).
// El tiempo de repostar no cuenta, porque vas a repostar igual en una u otra gasolinera.
function puntuar(g, ref, aj) {
  g.ahorroBruto = aj.litros * (ref - g.precio);
  g.costeDesvio = g.extraKm * (aj.consumo / 100) * g.precio;
  g.costeTiempo = (g.extraMin / 60) * aj.valorHora;
  g.ahorro = g.ahorroBruto - g.costeDesvio - g.costeTiempo;
}

// Calcula por carretera cuánto más largo es el viaje Origen → Gasolinera → Destino que Origen → Destino.
// Una sola petición a OSRM (matriz de distancias) para las gasolineras más prometedoras.
async function afinarDesvios(res, aj) {
  const candidatas = [...res.lista].sort((a, b) => b.ahorro - a.ahorro).slice(0, MAX_AFINAR);
  const ok = await desviosPorCarretera(candidatas);
  if (ok) candidatas.forEach((g) => { if (g.real) puntuar(g, res.ref, aj); });
  return ok;
}

// Calcula por carretera cuánto más largo es Origen → Parada → Destino que Origen → Destino.
// Una sola petición a OSRM (matriz de distancias). Rellena extraKm, extraMin y real en cada sitio.
async function desviosPorCarretera(sitios) {
  if (!sitios.length) return false;
  const o = viaje.origen, d = viaje.destino, n = sitios.length;
  const coords = [[o.lon, o.lat], ...sitios.map((g) => [g.lon, g.lat]), [d.lon, d.lat]]
    .map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';');
  const fuentes = Array.from({ length: n + 1 }, (_, i) => i).join(';');           // origen + paradas
  const destinos = Array.from({ length: n + 1 }, (_, i) => i + 1).join(';');      // paradas + destino
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}`
    + `?sources=${fuentes}&destinations=${destinos}&annotations=duration,distance`;
  const r = await fetch(url);
  if (!r.ok) return false;
  const j = await r.json();
  if (j.code !== 'Ok') return false;
  const dur = j.durations, dis = j.distances;
  const directoS = dur[0][n], directoM = dis[0][n];
  if (directoS == null || directoM == null) return false;
  sitios.forEach((g, i) => {
    const s1 = dur[0][i], s2 = dur[i + 1][n], m1 = dis[0][i], m2 = dis[i + 1][n];
    if ([s1, s2, m1, m2].some((v) => v == null)) return;
    g.extraKm = Math.max(0, (m1 + m2 - directoM) / 1000);
    g.extraMin = Math.max(0, (s1 + s2 - directoS) / 60);
    g.real = true;
  });
  return true;
}

// ---------- Pintar resultados ----------

function iniciarMapa() {
  if (mapa) return;
  mapa = L.map('mapa', { zoomControl: true });
  mapa.on('zoomend moveend', () => requestAnimationFrame(actualizarMapa));
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(mapa);
}

function enlacesNavegacion(lat, lon) {
  const d = viaje.destino;
  // Sin "origin": Google Maps sale desde donde estés y mantiene el destino final, con la gasolinera como parada.
  const google = 'https://www.google.com/maps/dir/?api=1&travelmode=driving'
    + `&destination=${d.lat},${d.lon}&waypoints=${lat},${lon}`;
  const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
  return `<div class="enlaces">
    <a class="boton-nav" href="${google}" target="_blank" rel="noopener">🛣️ Parada en Google Maps</a>
    <a class="boton-nav" href="${waze}" target="_blank" rel="noopener" data-continuar="1">🚗 Ir con Waze</a>
  </div>`;
}

// Waze no permite añadir una parada a un viaje desde un enlace. Por eso, al ir con Waze a la gasolinera,
// la app guarda el destino final y muestra abajo "Seguir a ..." para volver a la ruta con un toque.
function guardarContinuar() {
  if (!viaje) return;
  const d = viaje.destino;
  try { localStorage.setItem('continuar', JSON.stringify({ lat: d.lat, lon: d.lon, nombre: d.nombre })); } catch { /* sin almacenamiento */ }
  mostrarContinuar();
}

function mostrarContinuar() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem('continuar') || 'null'); } catch { /* sin almacenamiento */ }
  const barra = $('#barraContinuar');
  if (!c) { barra.hidden = true; return; }
  $('#enlaceContinuar').href = `https://waze.com/ul?ll=${c.lat},${c.lon}&navigate=yes`;
  $('#textoContinuar').textContent = `Seguir a ${c.nombre.split(',')[0]} con Waze`;
  barra.hidden = false;
}

function cerrarContinuar() {
  try { localStorage.removeItem('continuar'); } catch { /* sin almacenamiento */ }
  mostrarContinuar();
}

function tarjetaGasolinera(g, ref) {
  const signo = g.ahorro >= 0 ? 'bien' : 'mal';
  const textoAhorro = g.ahorro >= 0 ? `Ganas ${euros(g.ahorro)}` : `Pierdes ${euros(-g.ahorro)}`;
  const aprox = g.real ? '' : ' (aprox.)';
  return `<article class="tarjeta">
    <div class="cabeza">
      <span class="nombre">${escapar(g.rotulo)}</span>
      <span class="precio">${precioTxt(g.precio)}</span>
    </div>
    <div class="ahorro ${signo}">${textoAhorro}</div>
    <div class="cuentas">
      <span>Ahorro en el depósito</span><span>${euros(g.ahorroBruto)}</span>
      <span>Desvío +${km1(g.extraKm)} km${aprox}</span><span>−${euros(g.costeDesvio)}</span>
      <span>Tiempo +${Math.round(g.extraMin)} min${aprox}</span><span>−${euros(g.costeTiempo)}</span>
    </div>
    <div class="datos">Km ${Math.round(g.km)} del viaje · ${escapar(g.localidad)} · ${escapar(g.direccion)}</div>
    <div class="datos">Horario: ${escapar(g.horario) || 'sin datos'}</div>
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
    `<p class="nota">Comparado con ${textoRef} (${precioTxt(ref)}), echando ${aj.litros} L. Se descuenta el combustible del desvío y tu tiempo a ${euros(aj.valorHora)}/hora.${res.afinado ? '' : ' Los desvíos son aproximados: no he podido calcularlos por carretera.'}</p>`
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
  const minimo = Math.min(...lista.map((g) => g.precio));
  pintarLeyenda(minimo, Math.max(...lista.map((g) => g.precio)));
  for (const g of lista) {
    const nivel = nivelPrecio(g.precio);
    const m = L.circleMarker([g.lat, g.lon], {
      radius: mejores.has(g) ? 8 : 5,
      color: mejores.has(g) ? '#111827' : colorNivel(nivel),
      fillColor: colorNivel(nivel),
      fillOpacity: 0.9,
      weight: mejores.has(g) ? 2 : 1,
    }).bindPopup(`<b>${escapar(g.rotulo)}</b><br>${precioTxt(g.precio)}<br>${escapar(g.localidad)}<br>`
      + (g.ahorro >= 0 ? `Ganas ${euros(g.ahorro)}` : `Pierdes ${euros(-g.ahorro)}`)
      + `<br>+${Math.round(g.extraMin)} min · +${km1(g.extraKm)} km`);
    etiquetaPrecio(m, g.precio, mejores.has(g), ordenadas.indexOf(g), nivel).addTo(capaEstaciones);
  }
}

function pintarResumen(res, aj) {
  const h = Math.floor(viaje.min / 60), m = Math.round(viaje.min % 60);
  const mejor = res.lista.length ? [...res.lista].sort((a, b) => b.ahorro - a.ahorro)[0] : null;
  $('#resumen').innerHTML = `
    <div><b>${Math.round(viaje.km)} km</b><span>${h} h ${m} min</span></div>
    <div><b>${res.lista.length}</b><span>gasolineras a ≤ ${aj.desvio} km</span></div>
    <div><b>${res.ref ? precioTxt(res.ref) : '–'}</b><span>${res.refManual ? 'tu precio' : 'precio medio'} ${NOMBRES[aj.combustible]}</span></div>
    <div><b>${mejor ? euros(Math.max(0, mejor.ahorro)) : '–'}</b><span>lo máximo que ganas</span></div>`;
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
    if (m && v !== 'no' && v !== '0') lista.push(nombres[m[1]] || m[1]);
  }
  return [...new Set(lista)];
}

let datosCargadores = null;

async function cargarCargadoresDGT() {
  if (datosCargadores) return datosCargadores;
  const r = await fetch('data/cargadores.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('sin datos DGT');
  datosCargadores = await r.json();
  return datosCargadores;
}

// Cargadores oficiales (DGT / MITERD) a menos de "desvío máximo" de la ruta.
function cargadoresDGT(datosC, aj) {
  const cercano = crearBuscadorCercano(viaje.puntos);
  const lista = [];
  for (const e of datosC.e) {
    const c = cercano(e[0], e[1], aj.desvio);
    if (!c) continue;
    lista.push({
      lat: e[0], lon: e[1], nombre: e[2], operador: e[3], municipio: e[4], direccion: e[5],
      puntos: e[6], kw: e[7], conectores: e[8], horario: e[9],
      dist: c.dist, km: c.km, fuente: 'DGT',
    });
  }
  return lista;
}

// Reserva por si no hay datos de la DGT: OpenStreetMap.
async function cargadoresOSM(aj) {
  const pts = viaje.puntos;
  const salto = Math.max(1, Math.ceil(pts.length / 150));
  const linea = [];
  for (let i = 0; i < pts.length; i += salto) linea.push(pts[i].lat.toFixed(4), pts[i].lon.toFixed(4));
  const ult = pts[pts.length - 1];
  linea.push(ult.lat.toFixed(4), ult.lon.toFixed(4));
  const consulta = `[out:json][timeout:90];nwr["amenity"="charging_station"](around:${Math.round(aj.desvio * 1000)},${linea.join(',')});out center tags;`;
  const j = await overpass(consulta);
  const cercano = crearBuscadorCercano(pts);
  return j.elements.map((el) => {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    const t = el.tags || {};
    const c = lat != null ? cercano(lat, lon, aj.desvio + 1) : null;
    return c && {
      lat, lon, dist: c.dist, km: c.km,
      nombre: t.name || t.operator || t.network || t.brand || 'Punto de carga',
      operador: t.operator || t.network || '',
      municipio: '', direccion: '',
      puntos: parseInt(t.capacity, 10) || 0,
      kw: potenciaMaxKw(t),
      conectores: conectores(t),
      horario: t.opening_hours || '',
      fuente: 'OpenStreetMap',
    };
  }).filter(Boolean);
}

async function buscarCargadores() {
  if (!viaje) return;
  const aj = ajustesDelFormulario();
  const boton = $('#btnCargadores');
  boton.disabled = true;
  $('#listaCargadores').innerHTML = '<p class="nota">Buscando cargadores…</p>';
  try {
    let lista, fuente, fecha = '';
    try {
      const datosC = await cargarCargadoresDGT();
      lista = cargadoresDGT(datosC, aj);
      fuente = 'DGT (datos oficiales del Ministerio)';
      fecha = datosC.fecha ? new Date(datosC.fecha).toLocaleDateString('es-ES') : '';
    } catch {
      lista = await cargadoresOSM(aj);
      fuente = 'OpenStreetMap';
    }

    if ($('#soloRapidos').checked) lista = lista.filter((c) => c.kw >= 50);
    const conector = $('#conectorCarga').value;
    if (conector) lista = lista.filter((c) => c.conectores.includes(conector));

    // Desvío real por carretera para los más cercanos a la ruta
    lista.forEach((c) => { c.extraKm = 2 * c.dist * FACTOR_CARRETERA; c.extraMin = (c.extraKm / 40) * 60 + (c.dist > 0.3 ? 2 : 0); c.real = false; });
    $('#listaCargadores').innerHTML = '<p class="nota">Calculando desvíos por carretera…</p>';
    // Elige a quién calcular el desvío real: el más cercano de cada tramo de 10 km y, si sobra hueco, los más cercanos.
    const porCercania = [...lista].sort((a, b) => a.dist - b.dist);
    const elegidos = new Map();
    for (const c of porCercania) { const t = Math.floor(c.km / 10); if (!elegidos.has(t)) elegidos.set(t, c); }
    const afinar = [...elegidos.values()].slice(0, MAX_AFINAR);
    for (const c of porCercania) { if (afinar.length >= MAX_AFINAR) break; if (!afinar.includes(c)) afinar.push(c); }
    try { await desviosPorCarretera(afinar); } catch { /* se quedan los aproximados */ }
    lista.sort((a, b) => a.km - b.km);

    capaCargadores.clearLayers();
    for (const c of lista) {
      L.circleMarker([c.lat, c.lon], { radius: c.kw >= 50 ? 7 : 5, color: '#2563eb', fillOpacity: 0.8, weight: 1 })
        .bindPopup(`<b>⚡ ${escapar(c.nombre)}</b><br>${c.kw ? kwTxt(c.kw) : 'potencia sin datos'}`
          + `<br>+${Math.round(c.extraMin)} min · +${km1(c.extraKm)} km`)
        .addTo(capaCargadores);
    }

    $('#listaCargadores').innerHTML = lista.length
      ? `<p class="nota">${lista.length} cargadores a ≤ ${aj.desvio} km de la ruta, ordenados por kilómetro del viaje. Fuente: ${fuente}${fecha ? ' (' + fecha + ')' : ''}. Los datos oficiales no incluyen precio ni si están libres: míralo en la app del operador.</p>`
        + lista.map((c) => {
          const aprox = c.real ? '' : ' (aprox.)';
          return `<article class="tarjeta">
          <div class="cabeza"><span class="nombre">⚡ ${escapar(c.nombre)}</span>
            <span class="precio">${c.kw ? kwTxt(c.kw) : ''}</span></div>
          <div class="cuentas">
            <span>Desvío</span><span>+${km1(c.extraKm)} km${aprox}</span>
            <span>Tiempo de más</span><span>+${Math.round(c.extraMin)} min${aprox}</span>
          </div>
          <div class="datos">Km ${Math.round(c.km)} del viaje${c.municipio ? ' · ' + escapar(c.municipio) : ''}${c.direccion ? ' · ' + escapar(c.direccion) : ''}</div>
          <div class="datos">${c.conectores.length ? escapar(c.conectores.join(', ')) : 'Conectores sin datos'}${c.puntos ? ' · ' + c.puntos + (c.puntos === 1 ? ' punto' : ' puntos') : ''}</div>
          ${c.operador && c.operador !== c.nombre ? `<div class="datos">Operador: ${escapar(c.operador)}</div>` : ''}
          ${c.horario ? `<div class="datos">Horario: ${escapar(c.horario)}</div>` : ''}
          ${enlacesNavegacion(c.lat, c.lon)}
        </article>`;
        }).join('')
      : '<p class="nota">No he encontrado cargadores con esos filtros cerca de la ruta.</p>';
  } catch (err) {
    $('#listaCargadores').innerHTML = `<p class="nota">${escapar(err.message || 'No he podido buscar cargadores.')}</p>`;
  } finally {
    boton.disabled = false;
  }
}

// ---------- OpenStreetMap (Overpass) ----------

async function overpass(consulta) {
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(consulta),
  });
  if (!r.ok) throw new Error('El servicio de mapas está saturado. Prueba otra vez en un minuto.');
  return r.json();
}

// ---------- Electrolineras alrededor de un punto (sin ruta) ----------

function iniciarMapaCargar() {
  if (mapaCargar) return;
  mapaCargar = L.map('mapaCargar').setView([40.2, -3.7], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapaCargar);
  capaCargar = L.layerGroup().addTo(mapaCargar);
  mapaCargar.on('click', (e) => {
    const { lat, lng } = e.latlng;
    $('#sitioCargar').value = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    buscarElectrolineras({ lat, lon: lng, nombre: 'el punto elegido' });
  });
}

async function buscarElectrolineras(sitioElegido) {
  const boton = $('#btnCargar');
  const texto = $('#sitioCargar').value.trim();
  if (!sitioElegido && !texto) { $('#listaCargar').innerHTML = '<p class="nota">Escribe una localidad o toca el mapa.</p>'; return; }
  boton.disabled = true;
  $('#listaCargar').innerHTML = '<p class="nota">Buscando electrolineras…</p>';
  try {
    let sitio = sitioElegido && sitioElegido.lat != null ? sitioElegido : await geocodificar(texto);
    if (!sitioElegido && /^-?\d/.test(texto)) sitio = { ...sitio, nombre: 'el punto elegido' };
    const radio = parseFloat($('#radioCargar').value) || 5;
    const conector = $('#conectorCargar').value;
    const soloRapidos = $('#soloRapidosCargar').checked;
    const datosC = await cargarCargadoresDGT();

    let lista = [];
    for (const e of datosC.e) {
      if (Math.abs(e[0] - sitio.lat) > radio / 100 || Math.abs(e[1] - sitio.lon) > radio / 70) continue; // filtro rápido
      const dist = distKm(sitio.lat, sitio.lon, e[0], e[1]);
      if (dist > radio) continue;
      if (soloRapidos && e[7] < 50) continue;
      if (conector && !e[8].includes(conector)) continue;
      lista.push({ lat: e[0], lon: e[1], nombre: e[2], operador: e[3], municipio: e[4], direccion: e[5], puntos: e[6], kw: e[7], conectores: e[8], horario: e[9], dist });
    }
    lista.sort((a, b) => a.dist - b.dist);
    const total = lista.length;

    iniciarMapaCargar();
    capaCargar.clearLayers();
    L.circle([sitio.lat, sitio.lon], { radius: radio * 1000, color: '#2563eb', weight: 1, fillOpacity: 0.05 }).addTo(capaCargar);
    L.circleMarker([sitio.lat, sitio.lon], { radius: 9, color: '#111827', fillOpacity: 0.9, weight: 2 })
      .bindPopup(escapar(sitio.nombre)).addTo(capaCargar);
    for (const c of lista.slice(0, 400)) {
      L.circleMarker([c.lat, c.lon], { radius: c.kw >= 50 ? 8 : 6, color: c.kw >= 50 ? '#1d4ed8' : '#60a5fa', fillOpacity: 0.85, weight: 1 })
        .bindPopup(`<b>⚡ ${escapar(c.nombre)}</b><br>${c.kw ? kwTxt(c.kw) : ''} ${escapar(c.conectores.join(', '))}`
          + `<br><a href="https://waze.com/ul?ll=${c.lat},${c.lon}&navigate=yes" target="_blank" rel="noopener"><b>Ir con Waze</b></a>`
          + ` · <a href="https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${c.lat},${c.lon}" target="_blank" rel="noopener">Google Maps</a>`)
        .addTo(capaCargar);
    }
    mapaCargar.setView([sitio.lat, sitio.lon], radio <= 1 ? 15 : radio <= 2 ? 14 : radio <= 5 ? 13 : radio <= 10 ? 12 : 10);

    lista = lista.slice(0, 50);
    $('#listaCargar').innerHTML = total
      ? `<p class="nota">${total} electrolineras a menos de ${radio} km de ${escapar(sitio.nombre)}${total > lista.length ? ` (aquí las ${lista.length} más cercanas; en el mapa, hasta 400)` : ''}. Datos oficiales de la DGT: no incluyen precio ni si están libres.</p>`
        + lista.map((c) => `<article class="tarjeta">
          <div class="cabeza"><span class="nombre">⚡ ${escapar(c.nombre)}</span>
            <span class="precio">${c.kw ? kwTxt(c.kw) : ''}</span></div>
          <div class="datos">A ${c.dist < 1 ? Math.round(c.dist * 1000) + ' m' : km1(c.dist) + ' km'} en línea recta${c.municipio ? ' · ' + escapar(c.municipio) : ''}${c.direccion ? ' · ' + escapar(c.direccion) : ''}</div>
          <div class="datos">${c.conectores.length ? escapar(c.conectores.join(', ')) : 'Conectores sin datos'}${c.puntos ? ' · ' + c.puntos + (c.puntos === 1 ? ' punto' : ' puntos') : ''}</div>
          ${c.operador && c.operador !== c.nombre ? `<div class="datos">Operador: ${escapar(c.operador)}</div>` : ''}
          ${c.horario ? `<div class="datos">Horario: ${escapar(c.horario)}</div>` : ''}
          <div class="enlaces">
            <a class="boton-nav" href="https://waze.com/ul?ll=${c.lat},${c.lon}&navigate=yes" target="_blank" rel="noopener">🚗 Ir con Waze</a>
            <a class="boton-nav" href="https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${c.lat},${c.lon}" target="_blank" rel="noopener">🗺️ Google Maps</a>
          </div>
        </article>`).join('')
      : '<p class="nota">No he encontrado electrolineras con esos filtros. Prueba con más distancia.</p>';
  } catch (err) {
    $('#listaCargar').innerHTML = `<p class="nota">${escapar(err.message === 'sin datos DGT' ? 'No he podido cargar los datos de electrolineras.' : (err.message || 'No he podido buscar electrolineras.'))}</p>`;
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
    if (res.lista.length) {
      estado('Calculando desvíos por carretera…');
      try { res.afinado = await afinarDesvios(res, aj); } catch { res.afinado = false; }
    }

    $('#resultados').hidden = false;
    document.querySelector('.pestanas').hidden = false;
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
    requestAnimationFrame(actualizarMapa);
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

// Pensado para usar en marcha: coge tu ubicación como origen y busca hacia el destino guardado.
// Con destino: busca en la ruta desde donde estás. Sin destino: las que más compensan a tu alrededor.
function repostarAhora() {
  if (!navigator.geolocation) { estado('Tu navegador no permite usar la ubicación.', true); return; }
  estado('Buscando tu ubicación…');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $('#origen').value = `${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`;
      if ($('#destino').value.trim()) $('#formulario').requestSubmit();
      else buscarCerca(p.coords.latitude, p.coords.longitude);
    },
    () => estado('No he podido obtener tu ubicación. Revisa los permisos.', true),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}

// ---------- Sin destino: gasolineras alrededor ----------

const RADIO_CERCA = 10; // km

function tarjetaCerca(g, cercana) {
  const ganas = g.ganas;
  const signo = ganas >= 0 ? 'bien' : 'mal';
  const textoGanas = g === cercana ? 'Es la más cercana'
    : ganas >= 0 ? `Ganas ${euros(ganas)}` : `Pierdes ${euros(-ganas)}`;
  const aprox = g.real ? '' : ' (aprox.)';
  return `<article class="tarjeta">
    <div class="cabeza">
      <span class="nombre">${escapar(g.rotulo)}</span>
      <span class="precio">${precioTxt(g.precio)}</span>
    </div>
    <div class="ahorro ${g === cercana ? '' : signo}">${textoGanas}</div>
    <div class="cuentas">
      <span>Llegar: ${km1(g.km)} km, ${Math.round(g.min)} min${aprox}</span><span>${euros(g.costeLlegar)}</span>
      <span>Depósito (${g.litros} L)</span><span>${euros(g.costeDeposito)}</span>
      <span><b>Total</b></span><span><b>${euros(g.total)}</b></span>
    </div>
    <div class="datos">${escapar(g.localidad)} · ${escapar(g.direccion)}</div>
    <div class="datos">Horario: ${escapar(g.horario) || 'sin datos'}</div>
    <div class="enlaces">
      <a class="boton-nav" href="https://waze.com/ul?ll=${g.lat},${g.lon}&navigate=yes" target="_blank" rel="noopener">🚗 Ir con Waze</a>
      <a class="boton-nav" href="https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${g.lat},${g.lon}" target="_blank" rel="noopener">🗺️ Google Maps</a>
    </div>
  </article>`;
}

// Total = lo que pagas en el depósito + combustible para llegar + tu tiempo para llegar.
// "Ganas" se compara con ir a la gasolinera más cercana.
async function buscarCerca(lat, lon) {
  const aj = ajustesDelFormulario();
  guardarAjustes(aj);
  const boton = $('#btnAhora');
  boton.disabled = true;
  try {
    estado('Cargando precios…');
    await cargarPrecios();
    const col = datos.campos.indexOf(aj.combustible);
    let lista = [];
    for (const e of datos.e) {
      const precio = e[col];
      if (precio == null) continue;
      if (Math.abs(e[0] - lat) > 0.1 || Math.abs(e[1] - lon) > 0.14) continue;
      const dist = distKm(lat, lon, e[0], e[1]);
      if (dist > RADIO_CERCA) continue;
      const km = dist * FACTOR_CARRETERA;
      lista.push({ lat: e[0], lon: e[1], rotulo: e[2], localidad: e[3], direccion: e[4], horario: e[5], precio, km, min: (km / 40) * 60 + 1, real: false });
    }
    if (!lista.length) throw new Error(`No hay gasolineras con ${NOMBRES[aj.combustible]} a menos de ${RADIO_CERCA} km.`);

    const calcular = (g) => {
      g.litros = aj.litros;
      g.costeDeposito = aj.litros * g.precio;
      g.costeLlegar = g.km * (aj.consumo / 100) * g.precio + (g.min / 60) * aj.valorHora;
      g.total = g.costeDeposito + g.costeLlegar;
    };
    lista.forEach(calcular);
    lista.sort((a, b) => a.total - b.total);
    lista = lista.slice(0, MAX_AFINAR);

    // Distancia y tiempo reales por carretera desde donde estás (una petición a OSRM)
    estado('Calculando distancias por carretera…');
    try {
      const coords = [[lon, lat], ...lista.map((g) => [g.lon, g.lat])].map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join(';');
      const destinos = lista.map((_, i) => i + 1).join(';');
      const r = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&destinations=${destinos}&annotations=duration,distance`);
      const j = await r.json();
      if (j.code === 'Ok') {
        lista.forEach((g, i) => {
          const d = j.distances[0][i], t = j.durations[0][i];
          if (d == null || t == null) return;
          g.km = d / 1000; g.min = t / 60; g.real = true;
          calcular(g);
        });
      }
    } catch { /* se quedan los aproximados */ }

    lista.sort((a, b) => a.total - b.total);
    const cercana = [...lista].sort((a, b) => a.min - b.min)[0];
    lista.forEach((g) => { g.ganas = cercana.total - g.total; });

    viaje = null;
    $('#resultados').hidden = false;
    document.querySelector('.pestanas').hidden = true;
    cambiarPestana('compensan');
    iniciarMapa();
    if (capaRuta) { capaRuta.remove(); capaRuta = null; }
    if (!capaEstaciones) capaEstaciones = L.layerGroup().addTo(mapa);
    if (capaCargadores) capaCargadores.clearLayers();
    capaEstaciones.clearLayers();
    L.circleMarker([lat, lon], { radius: 9, color: '#111827', fillOpacity: 0.9, weight: 2 }).bindPopup('Estás aquí').addTo(capaEstaciones);
    const top = lista.slice(0, 15);
    const minimo = Math.min(...lista.map((g) => g.precio));
    pintarLeyenda(minimo, Math.max(...lista.map((g) => g.precio)));
    for (const g of lista) {
      const nivel = nivelPrecio(g.precio);
      const m = L.circleMarker([g.lat, g.lon], { radius: top.includes(g) ? 8 : 5, color: top.includes(g) ? '#111827' : colorNivel(nivel), fillColor: colorNivel(nivel), fillOpacity: 0.9, weight: top.includes(g) ? 2 : 1 })
        .bindPopup(`<b>${escapar(g.rotulo)}</b><br>${precioTxt(g.precio)}<br>${Math.round(g.min)} min`
          + `<br><a href="https://waze.com/ul?ll=${g.lat},${g.lon}&navigate=yes" target="_blank" rel="noopener"><b>Ir con Waze</b></a>`);
      etiquetaPrecio(m, g.precio, top.includes(g), lista.indexOf(g), nivel).addTo(capaEstaciones);
    }
    mapa.invalidateSize();
    mapa.setView([lat, lon], 12);
    requestAnimationFrame(actualizarMapa);

    const mejor = lista[0];
    $('#resumen').innerHTML = `
      <div><b>${lista.length}</b><span>gasolineras a ≤ ${RADIO_CERCA} km</span></div>
      <div><b>${precioTxt(mejor.precio)}</b><span>la que más compensa</span></div>
      <div><b>${euros(Math.max(0, mejor.ganas))}</b><span>frente a la más cercana</span></div>
      <div><b>${Math.round(cercana.min)} min</b><span>a la más cercana</span></div>`;
    $('#p-compensan').innerHTML =
      `<p class="nota">Sin destino: ordenadas por lo que te cuesta en total (depósito de ${aj.litros} L + combustible y tiempo para llegar, a ${euros(aj.valorHora)}/hora). "Ganas" es frente a ir a la más cercana (${escapar(cercana.rotulo)}).</p>`
      + top.map((g) => tarjetaCerca(g, cercana)).join('');
    estado(`Gasolineras alrededor de ti · ${NOMBRES[aj.combustible]}`);
  } catch (err) {
    estado(err.message || 'No he podido buscar gasolineras cerca.', true);
  } finally {
    boton.disabled = false;
  }
}

function cambiarModo(modo) {
  document.querySelectorAll('.modo').forEach((b) => b.classList.toggle('activo', b.dataset.modo === modo));
  $('#modo-ruta').hidden = modo !== 'ruta';
  $('#modo-cargar').hidden = modo !== 'cargar';
  $('#titulo').textContent = modo === 'cargar' ? '⚡ Electrolineras' : '⛽ Gasolineras en ruta';
  $('#subtitulo').textContent = modo === 'cargar'
    ? 'Puntos de recarga alrededor de cualquier punto del mapa'
    : 'La gasolinera y el cargador que más compensan en tu viaje';
  document.title = modo === 'cargar' ? 'Electrolineras' : 'Gasolineras en ruta';
  try { localStorage.setItem('modo', modo); } catch { /* sin almacenamiento */ }
  if (modo === 'cargar') {
    iniciarMapaCargar();
    setTimeout(() => mapaCargar.invalidateSize(), 0);
  } else if (mapa) {
    setTimeout(() => mapa.invalidateSize(), 0);
  }
}

function ubicacionCargar() {
  if (!navigator.geolocation) return;
  $('#listaCargar').innerHTML = '<p class="nota">Buscando tu ubicación…</p>';
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $('#sitioCargar').value = `${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`;
      buscarElectrolineras({ lat: p.coords.latitude, lon: p.coords.longitude, nombre: 'tu ubicación' });
    },
    () => { $('#listaCargar').innerHTML = '<p class="nota">No he podido obtener tu ubicación. Revisa los permisos.</p>'; },
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
  $('#valorHora').value = aj.valorHora;
  if (aj.destino) $('#destino').value = aj.destino;

  $('#formulario').addEventListener('submit', buscar);
  $('#btnUbicacion').addEventListener('click', usarUbicacion);
  $('#btnAhora').addEventListener('click', repostarAhora);
  $('#cerrarContinuar').addEventListener('click', cerrarContinuar);
  $('#enlaceContinuar').addEventListener('click', () => setTimeout(cerrarContinuar, 500));
  document.addEventListener('click', (e) => { if (e.target.closest('a[data-continuar]')) guardarContinuar(); });
  mostrarContinuar();
  $('#btnCargadores').addEventListener('click', buscarCargadores);
  $('#btnCargar').addEventListener('click', () => buscarElectrolineras());
  $('#sitioCargar').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscarElectrolineras(); } });
  $('#btnUbicacionCargar').addEventListener('click', ubicacionCargar);
  document.querySelectorAll('.modo').forEach((b) => b.addEventListener('click', () => cambiarModo(b.dataset.modo)));
  let modoGuardado = 'ruta';
  try { modoGuardado = localStorage.getItem('modo') || 'ruta'; } catch { /* sin almacenamiento */ }
  cambiarModo(modoGuardado === 'cargar' ? 'cargar' : 'ruta');
  document.querySelectorAll('.pestana').forEach((b) => b.addEventListener('click', () => cambiarPestana(b.dataset.pestana)));

  cargarPrecios().catch(() => { /* se avisa al buscar */ });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

iniciar();
