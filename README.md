# Supermarket Comparator

Proyecto base para buscar un producto en `preciosuper`, mostrar resultados en 3 tablas y marcar posibles ofertas en links de producto.

## Requisitos

- Node.js 18+

## Ejecutar

```bash
npm start
```

Abrir: `http://localhost:3000`

## Flujo

1. Tabla 1: salida completa de la API (normalizada).
2. Tabla 2: resultados filtrados por matching de nombre + deteccion de oferta.
3. Tabla 3: resumen por supermercado (min/prom/max y cantidad de ofertas).

## Notas

- El scraping de ofertas usa patrones de texto (`2x1`, `3x2`, `% off`, etc.).
- Se limita por defecto a 8 links para evitar demoras/bloqueos.
- Si un supermercado renderiza ofertas por JavaScript, puede requerir Playwright para mejorar precision.
