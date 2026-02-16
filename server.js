const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const OFFER_PATTERNS = [
  /\b2\s*[xX]\s*1\b/i,
  /\b3\s*[xX]\s*2\b/i,
  /\b4\s*[xX]\s*3\b/i,
  /\b\d+\s*%\s*(off|descuento)\b/i,
  /\bsegunda\s+unidad\b/i,
  /\boferta\b/i,
  /\bpromo\b/i,
  /\bpromoci[oó]n\b/i,
  /\bll[eé]vate\b/i
];

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const normalized = value
    .replace(/\$/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .trim();

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

function extractArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const candidateKeys = ['products', 'result', 'results', 'data', 'items'];
  for (const key of candidateKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  const firstArray = Object.values(payload).find(Array.isArray);
  return Array.isArray(firstArray) ? firstArray : [];
}

function normalizeProduct(item, index) {
  const name = pick(item, ['name', 'product', 'product_name', 'title', 'descripcion', 'description']) || `Producto ${index + 1}`;
  const supermarket = pick(item, ['store', 'supermarket', 'merchant', 'shop']) || 'Sin supermercado';
  const priceObj = item && typeof item.price === 'object' ? item.price : null;
  const priceRaw = pick(item, ['precio', 'final_price', 'sale_price', 'amount']);
  const amount = toNumber(priceObj ? priceObj.amount : priceRaw);
  const originalAmount = toNumber(priceObj ? priceObj.originalAmount : null);
  const discountPercentage = toNumber(priceObj ? priceObj.discountPercentage : null) || 0;
  const link = pick(item, ['link', 'url', 'product_url', 'href']);

  return {
    id: String(pick(item, ['id', 'sku', 'product_id', 'ean']) || `${supermarket}-${name}-${index}`),
    ean: String(pick(item, ['ean']) || ''),
    name: String(name),
    description: String(pick(item, ['description', 'descripcion']) || ''),
    brand: String(pick(item, ['brand']) || ''),
    availability: Boolean(pick(item, ['availability']) === true),
    supermarket: String(supermarket),
    price: amount,
    originalPrice: originalAmount,
    discountPercentage,
    priceRaw: priceObj || priceRaw,
    imageUrl: String(pick(item, ['imageUrl', 'image_url', 'image']) || ''),
    link: link ? String(link) : null,
    raw: item
  };
}

function normalizeProducts(payload) {
  const arr = extractArrayPayload(payload);
  return arr
    .filter((item) => item && typeof item === 'object')
    .map(normalizeProduct);
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function scoreMatch(query, target) {
  const q = tokenize(query);
  if (!q.length) return 0;

  const t = tokenize(target);
  if (!t.length) return 0;

  let matches = 0;
  for (const qToken of q) {
    if (t.some((token) => token.includes(qToken) || qToken.includes(token))) {
      matches += 1;
    }
  }

  return matches / q.length;
}

function filterByMatch(products, query, threshold = 0.55) {
  return products
    .map((p) => ({ ...p, matchScore: scoreMatch(query, `${p.name} ${p.brand} ${p.description}`) }))
    .filter((p) => p.matchScore >= threshold)
    .sort((a, b) => b.matchScore - a.matchScore);
}

function detectOfferFromHtml(html) {
  const compact = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const matched = OFFER_PATTERNS.filter((re) => re.test(compact)).map((re) => re.source);
  return {
    hasOffer: matched.length > 0,
    signals: matched
  };
}

function hasApiOffer(product) {
  return typeof product.discountPercentage === 'number' && product.discountPercentage > 0;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SupermarketPriceBot/1.0)'
    }
  });

  if (!response.ok) {
    throw new Error(`Error al consultar ${url}: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const json = safeJsonParse(text);
  if (!json) throw new Error('La API devolvio una respuesta no JSON.');
  return json;
}

async function fetchOfferForProduct(product) {
  const apiOffer = hasApiOffer(product);

  if (!product.link) {
    return {
      ...product,
      hasOffer: apiOffer,
      offerSignals: apiOffer ? ['api_discount'] : [],
      offerError: 'Sin link del producto'
    };
  }

  try {
    const response = await fetch(product.link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SupermarketPriceBot/1.0)'
      }
    });

    if (!response.ok) {
      return {
        ...product,
        hasOffer: apiOffer,
        offerSignals: apiOffer ? ['api_discount'] : [],
        offerError: `No se pudo abrir link (${response.status})`
      };
    }

    const html = await response.text();
    const offer = detectOfferFromHtml(html);

    return {
      ...product,
      hasOffer: apiOffer || offer.hasOffer,
      offerSignals: [...(apiOffer ? ['api_discount'] : []), ...offer.signals],
      offerError: null
    };
  } catch (error) {
    return {
      ...product,
      hasOffer: apiOffer,
      offerSignals: apiOffer ? ['api_discount'] : [],
      offerError: error.message
    };
  }
}

async function enrichOffers(products, limit = 6) {
  const toProcess = products.slice(0, limit);
  const enriched = await Promise.all(toProcess.map(fetchOfferForProduct));
  const untouched = products.slice(limit).map((p) => ({
    ...p,
    hasOffer: hasApiOffer(p),
    offerSignals: hasApiOffer(p) ? ['api_discount'] : [],
    offerError: 'No evaluado por limite de scraping'
  }));
  return [...enriched, ...untouched];
}

function groupBySupermarket(products) {
  const grouped = new Map();

  for (const product of products) {
    const key = product.supermarket;
    if (!grouped.has(key)) {
      grouped.set(key, {
        supermarket: key,
        productCount: 0,
        availableCount: 0,
        unavailableCount: 0,
        minPrice: null,
        maxPrice: null,
        avgPrice: null,
        minAvailablePrice: null,
        offerCount: 0,
        anyOffer: false,
        products: []
      });
    }

    const row = grouped.get(key);
    row.productCount += 1;
    row.products.push(product);
    if (product.availability) {
      row.availableCount += 1;
    } else {
      row.unavailableCount += 1;
    }

    if (typeof product.price === 'number') {
      row.minPrice = row.minPrice === null ? product.price : Math.min(row.minPrice, product.price);
      row.maxPrice = row.maxPrice === null ? product.price : Math.max(row.maxPrice, product.price);
      if (product.availability) {
        row.minAvailablePrice = row.minAvailablePrice === null
          ? product.price
          : Math.min(row.minAvailablePrice, product.price);
      }
    }

    if (product.hasOffer) {
      row.offerCount += 1;
      row.anyOffer = true;
    }
  }

  for (const row of grouped.values()) {
    const priced = row.products.filter((p) => typeof p.price === 'number');
    row.avgPrice = priced.length
      ? priced.reduce((acc, p) => acc + p.price, 0) / priced.length
      : null;
  }

  return Array.from(grouped.values()).sort((a, b) => a.supermarket.localeCompare(b.supermarket));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendStaticFile(reqPath, res) {
  const filePath = reqPath === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, reqPath.replace(/^\//, ''));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Acceso denegado' });
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 404, { error: 'Archivo no encontrado' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/search' && req.method === 'GET') {
    const product = (url.searchParams.get('product') || '').trim();
    if (!product) {
      sendJson(res, 400, { error: 'Falta query param: product' });
      return;
    }

    try {
      const apiUrl = `https://www.preciosuper.com/api/products?product=${encodeURIComponent(product)}`;
      const rawPayload = await fetchJson(apiUrl);
      const rawResults = normalizeProducts(rawPayload);
      const filteredResults = filterByMatch(rawResults, product);
      const filteredWithOffers = await enrichOffers(filteredResults, 8);
      const groupedBySupermarket = groupBySupermarket(filteredWithOffers);

      sendJson(res, 200, {
        query: product,
        meta: {
          rawCount: rawResults.length,
          filteredCount: filteredWithOffers.length,
          groupedCount: groupedBySupermarket.length,
          generatedAt: new Date().toISOString()
        },
        rawResults,
        filteredResults: filteredWithOffers,
        groupedBySupermarket
      });
    } catch (error) {
      sendJson(res, 502, {
        error: 'No se pudo consultar preciosuper o procesar datos',
        detail: error.message
      });
    }

    return;
  }

  sendStaticFile(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
