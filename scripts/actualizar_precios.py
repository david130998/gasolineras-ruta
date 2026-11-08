"""Convierte el JSON de precios del Ministerio en data/estaciones.json (formato compacto para la app).

Uso:
    python scripts/actualizar_precios.py crudo.json

crudo.json se descarga antes con curl (ver README).
"""
import json
import sys
import unicodedata
from pathlib import Path

SALIDA = Path(__file__).resolve().parent.parent / "data" / "estaciones.json"

# Para cada combustible de la app, los nombres de columna del Ministerio en orden de preferencia.
COMBUSTIBLES = {
    "g95": ["precio gasolina 95 e5", "precio gasolina 95 e10"],
    "g98": ["precio gasolina 98 e5", "precio gasolina 98 e10"],
    "diesel": ["precio gasoleo a"],
    "dieselp": ["precio gasoleo premium"],
    "glp": ["precio gases licuados del petroleo"],
}
CAMPOS = ["lat", "lon", "rotulo", "localidad", "direccion", "horario", *COMBUSTIBLES]


def normalizar(texto):
    """Quita tildes y pasa a minúsculas: 'Precio Gasóleo A' -> 'precio gasoleo a'."""
    sin_tildes = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return " ".join(sin_tildes.lower().split())


def numero(valor):
    if valor is None:
        return None
    valor = str(valor).strip().replace(",", ".")
    if not valor:
        return None
    try:
        return float(valor)
    except ValueError:
        return None


def capitalizar(texto):
    return " ".join(p.capitalize() for p in str(texto or "").split())


def main():
    if len(sys.argv) != 2:
        sys.exit("Uso: python scripts/actualizar_precios.py crudo.json")

    crudo = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    filas = crudo.get("ListaEESSPrecio") or []
    if not filas:
        sys.exit(f"El archivo no trae gasolineras. ResultadoConsulta: {crudo.get('ResultadoConsulta')!r}")

    salida = []
    for fila in filas:
        f = {normalizar(k): v for k, v in fila.items()}
        # "R" = venta restringida a socios/flotas; solo queremos las abiertas al público.
        if str(f.get("tipo venta", "P")).strip().upper() == "R":
            continue
        lat = numero(f.get("latitud"))
        lon = numero(f.get("longitud (wgs84)") or f.get("longitud"))
        if lat is None or lon is None:
            continue

        precios = []
        for columnas in COMBUSTIBLES.values():
            precio = None
            for col in columnas:
                precio = numero(f.get(col))
                if precio:
                    break
            precios.append(round(precio, 3) if precio else None)
        if not any(precios):
            continue

        salida.append([
            round(lat, 5),
            round(lon, 5),
            str(f.get("rotulo") or "Gasolinera").strip(),
            capitalizar(f.get("localidad")),
            capitalizar(f.get("direccion")),
            str(f.get("horario") or "").strip(),
            *precios,
        ])

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    datos = {"fecha": crudo.get("Fecha", ""), "campos": CAMPOS, "e": salida}
    SALIDA.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"OK: {len(salida)} gasolineras guardadas en {SALIDA} (precios del {datos['fecha']})")


if __name__ == "__main__":
    main()
