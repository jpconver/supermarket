# Supermarket Comparator

Proyecto base para buscar un producto en `preciosuper`, mostrar resultados en 3 tablas y marcar posibles ofertas en links de producto.

## Requisitos

- Node.js 18+

## Ejecutar

```bash
npm install
npx playwright install chromium
npm start
```

Abrir: `http://localhost:3000`

## Flujo

1. Tabla 1: salida completa de la API (normalizada).
2. Tabla 2: resultados filtrados por matching de nombre.
3. Boton `Ver HTML` por producto para ejecutar scraping on-demand con navegador real.
4. Tabla 3: resumen por supermercado (min/prom/max y cantidad de ofertas).

## Notas

- El scraping de ofertas usa browser real con Playwright para sitios con JavaScript.
- El endpoint `/api/search` no scrapea enlaces; el scraping se ejecuta al presionar `Ver HTML`.
- Si no esta instalado Playwright, el boton de scraping devolvera error.
