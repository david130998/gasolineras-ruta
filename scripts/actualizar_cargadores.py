"""Convierte el XML de puntos de recarga de la DGT (DATEX II v3) en data/cargadores.json.

Uso:
    python scripts/actualizar_cargadores.py cargadores.xml

Fuente: Punto de Acceso Nacional de la DGT (datos del MITERD), licencia Creative Commons Attribution.
https://nap.dgt.es/dataset/puntos-de-recarga-electrica-para-vehiculos
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SALIDA = Path(__file__).resolve().parent.parent / "data" / "cargadores.json"

NOMBRES_CONECTOR = {
    "iec62196T2": "Tipo 2",
    "iec62196T2COMBO": "CCS2",
    "chademo": "CHAdeMO",
    "iec62196T1": "Tipo 1",
    "iec62196T1COMBO": "CCS1",
    "domestic": "Schuko",
    "domesticF": "Schuko",
    "domesticE": "Schuko",
    "teslaConnectorEurope": "Tesla",
    "teslaR": "Tesla",
    "teslaS": "Tesla",
}
CAMPOS = ["lat", "lon", "nombre", "operador", "municipio", "direccion", "puntos", "kw", "conectores", "horario"]


DIAS = ["Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado", "Domingo"]
ABREV = {"Lunes": "L", "Martes": "M", "Miercoles": "X", "Jueves": "J", "Viernes": "V", "Sabado": "S", "Domingo": "D"}


def resumir_horario(texto):
    """'Lunes (00:00 - 23:59) Martes (08:30 - 17:30) ...' -> '24 h' o 'L 00:00-23:59 · M 08:30-17:30 · ...'"""
    import re
    tramos = dict(re.findall(r"(\w+)\s*\((\d\d:\d\d\s*-\s*\d\d:\d\d)\)", texto))
    if not tramos:
        return texto[:80]
    tramos = {d: h.replace(" ", "") for d, h in tramos.items()}
    if len(tramos) == 7 and set(tramos.values()) == {"00:00-23:59"}:
        return "24 h"
    if len(set(tramos.values())) == 1 and len(tramos) == 7:
        return "Todos los días " + next(iter(tramos.values()))
    return " · ".join(f"{ABREV[d]} {tramos[d]}" for d in DIAS if d in tramos)


def local(tag):
    """'{namespace}nombre' -> 'nombre'"""
    return tag.rsplit("}", 1)[-1]


def primer_texto(elem, nombre):
    for e in elem.iter():
        if local(e.tag) == nombre and e.text and e.text.strip():
            return e.text.strip()
    return ""


def nombre_de(elem):
    """Texto de <fac:name><com:values><com:value> hijo directo de elem."""
    for hijo in elem:
        if local(hijo.tag) == "name":
            return primer_texto(hijo, "value")
    return ""


def convertir_sitio(sitio):
    lat = lon = None
    operador = municipio = direccion = horario = ""
    puntos = 0
    kw_max = 0.0
    conectores = set()

    for e in sitio.iter():
        t = local(e.tag)
        if t == "latitude" and e.text:
            lat = float(e.text)
        elif t == "longitude" and e.text:
            lon = float(e.text)
        elif t == "operator":
            operador = nombre_de(e)
        elif t == "label" and e.text and not horario:
            horario = resumir_horario(" ".join(e.text.split()))
        elif t == "addressLine":
            texto = primer_texto(e, "value")
            if texto.startswith("Municipio:"):
                municipio = texto.split(":", 1)[1].strip()
            elif texto.startswith("Dirección:"):
                direccion = texto.split(":", 1)[1].strip()
        elif t == "refillPoint":
            puntos += 1
        elif t == "connectorType" and e.text:
            conectores.add(NOMBRES_CONECTOR.get(e.text.strip(), e.text.strip()))
        elif t == "maxPowerAtSocket" and e.text:
            try:
                kw_max = max(kw_max, float(e.text) / 1000)
            except ValueError:
                pass

    if lat is None or lon is None:
        return None
    return [
        round(lat, 5),
        round(lon, 5),
        nombre_de(sitio) or operador or "Punto de recarga",
        operador,
        municipio,
        direccion,
        puntos,
        round(kw_max, 1),
        sorted(conectores),
        horario,
    ]


def main():
    if len(sys.argv) != 2:
        sys.exit("Uso: python scripts/actualizar_cargadores.py cargadores.xml")

    salida = []
    fecha = ""
    # iterparse: el archivo es grande, así que se procesa sitio a sitio sin cargarlo entero.
    for evento, elem in ET.iterparse(sys.argv[1], events=("end",)):
        t = local(elem.tag)
        if t == "publicationTime" and not fecha and elem.text:
            fecha = elem.text.strip()
        elif t == "energyInfrastructureSite":
            fila = convertir_sitio(elem)
            if fila:
                salida.append(fila)
            elem.clear()

    if not salida:
        sys.exit("El archivo no trae puntos de recarga.")

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    datos = {"fecha": fecha, "campos": CAMPOS, "e": salida}
    SALIDA.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"OK: {len(salida)} puntos de recarga guardados en {SALIDA} (publicados {fecha})")


if __name__ == "__main__":
    main()
