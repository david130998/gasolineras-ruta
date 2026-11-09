# Gasolineras en ruta

👉 **Abrir la app: https://david130998.github.io/gasolineras-ruta/**

App web para el móvil: le dices origen y destino (por ejemplo Ermua → Madrid) y te dice
qué gasolineras de la ruta compensan de verdad, descontando lo que gastas en desviarte,
y qué cargadores eléctricos hay por el camino.

- **Precios**: datos oficiales del Ministerio para la Transición Ecológica (se actualizan solos 3 veces al día con GitHub Actions).
- **Ruta**: OSRM (gratis, sin clave).
- **Buscar sitios**: Nominatim de OpenStreetMap.
- **Cargadores**: OpenStreetMap (Overpass). Suelen traer potencia y conectores, casi nunca el precio.
- Cada gasolinera o cargador tiene botones para abrirlo en **Google Maps como parada**, Waze o Apple Maps.
  Google Maps y Waze sí salen en CarPlay, así que la navegación la puedes seguir allí.

## Cómo se calcula si compensa

```
ahorro = litros × (precio de referencia − precio de la gasolinera) − coste del desvío
coste del desvío = km de desvío (ida y vuelta) × consumo / 100 × precio de la gasolinera
```

El precio de referencia es el precio medio de las gasolineras de la ruta o, si lo rellenas,
el precio que pagas normalmente. El desvío se estima como 2 × distancia a la carretera × 1,3.

## Probarla en el PC (Windows, PowerShell)

```powershell
cd C:\Users\dalon\Documents\GitHub\gasolineras-ruta
curl.exe -L -o crudo.json "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/"
python scripts\actualizar_precios.py crudo.json
python -m http.server 8000
```

Abre http://localhost:8000 en Chrome. Para pararlo, `Ctrl + C` en PowerShell.

## Publicarla gratis (GitHub Pages)

1. Sube esta carpeta a un repo público llamado `gasolineras-ruta` (con `data/estaciones.json` incluido).
2. En GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.
3. En GitHub: **Actions → Actualizar precios → Run workflow**, para comprobar que la actualización automática funciona.
4. A los 1-2 minutos estará en `https://david130998.github.io/gasolineras-ruta/`.

## Instalarla en el iPhone

Abre la dirección en **Safari** → botón **Compartir** → **Añadir a pantalla de inicio**.
Se abre como una app normal. No aparece en CarPlay (Apple solo lo permite a apps nativas aprobadas).
