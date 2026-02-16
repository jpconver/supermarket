const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

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

let playwrightLib = null;
const exportJobs = new Map();

try {
  playwrightLib = require('playwright');
} catch {
  playwrightLib = null;
}

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
  return normalizeForMatch(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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

function detectOfferFromText(text) {
  const compact = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  const matched = OFFER_PATTERNS.filter((re) => re.test(compact)).map((re) => re.source);
  return {
    hasOffer: matched.length > 0,
    signals: matched
  };
}

function pickRepresentativeProduct(products) {
  if (!products.length) return null;

  // Priorizamos disponible, luego descripción más completa, luego precio menor.
  return [...products].sort((a, b) => {
    const aAvail = a.availability ? 1 : 0;
    const bAvail = b.availability ? 1 : 0;
    if (aAvail !== bAvail) return bAvail - aAvail;

    const aTextLen = `${a.name || ''} ${a.description || ''}`.trim().length;
    const bTextLen = `${b.name || ''} ${b.description || ''}`.trim().length;
    if (aTextLen !== bTextLen) return bTextLen - aTextLen;

    const aPrice = typeof a.price === 'number' ? a.price : Number.POSITIVE_INFINITY;
    const bPrice = typeof b.price === 'number' ? b.price : Number.POSITIVE_INFINITY;
    return aPrice - bPrice;
  })[0];
}

function pickStoreEntry(current, candidate) {
  if (!current) return candidate;

  // Si uno está disponible y el otro no, preferimos disponible.
  if (current.availability !== candidate.availability) {
    return candidate.availability ? candidate : current;
  }

  const currentPrice = typeof current.price === 'number' ? current.price : Number.POSITIVE_INFINITY;
  const candidatePrice = typeof candidate.price === 'number' ? candidate.price : Number.POSITIVE_INFINITY;
  return candidatePrice < currentPrice ? candidate : current;
}

function groupByEan(products) {
  const byEan = new Map();
  const supermarkets = new Set();

  products.forEach((product, idx) => {
    const eanKey = product.ean && product.ean.trim() ? product.ean.trim() : `SIN_EAN_${idx}`;
    if (!byEan.has(eanKey)) {
      byEan.set(eanKey, []);
    }
    byEan.get(eanKey).push(product);
    if (product.supermarket) supermarkets.add(product.supermarket);
  });

  const rows = [];
  for (const [ean, items] of byEan.entries()) {
    const representative = pickRepresentativeProduct(items);
    const pricesBySupermarket = {};

    items.forEach((item) => {
      const key = item.supermarket || 'Sin supermercado';
      pricesBySupermarket[key] = pickStoreEntry(pricesBySupermarket[key], {
        price: item.price,
        originalPrice: item.originalPrice,
        availability: item.availability,
        link: item.link
      });
    });

    rows.push({
      ean,
      unifiedName: representative ? representative.name : '',
      unifiedDescription: representative ? representative.description : '',
      brand: representative ? representative.brand : '',
      representativeLink: representative ? representative.link : null,
      pricesBySupermarket,
      sourceCount: items.length
    });
  }

  return {
    supermarkets: Array.from(supermarkets).sort((a, b) => a.localeCompare(b)),
    rows: rows.sort((a, b) => a.unifiedName.localeCompare(b.unifiedName))
  };
}

function filterGroupedByEan(rows, query, brandFilter = '', threshold = 0.55) {
  const normalizedBrandFilter = normalizeForMatch(brandFilter).trim();

  return rows
    .map((row) => {
      const searchableText = `${row.unifiedDescription || ''} ${row.unifiedName || ''} ${row.brand || ''}`;
      const eanMatchScore = scoreMatch(query, searchableText);
      const normalizedRowBrand = normalizeForMatch(row.brand || '');
      const brandMatches = normalizedBrandFilter
        ? normalizedRowBrand.includes(normalizedBrandFilter)
        : true;
      return { ...row, eanMatchScore, brandMatches };
    })
    .filter((row) => row.brandMatches && row.eanMatchScore >= threshold)
    .sort((a, b) => b.eanMatchScore - a.eanMatchScore);
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

async function scrapeProductPageWithBrowser(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      // Algunos sitios mantienen conexiones abiertas y no alcanzan networkidle.
    }

    await page.waitForTimeout(1200);

    const extracted = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText || '' : '';
      const bodyHtml = document.body ? document.body.innerHTML || '' : '';
      const nodes = Array.from(
        document.querySelectorAll('[class*="promo"],[class*="offer"],[class*="discount"],[class*="price"],[id*="promo"],[id*="offer"],[id*="discount"],[data-testid*="price"],[data-testid*="promo"]')
      );

      const candidateText = nodes
        .map((node) => (node.innerText || '').trim())
        .filter(Boolean)
        .slice(0, 150)
        .join('\n');

      return {
        title: document.title || '',
        bodyHtml,
        bodyText,
        candidateText
      };
    });

    const html = await page.content();

    const offerFromText = detectOfferFromText(`${extracted.title}\n${extracted.candidateText}\n${extracted.bodyText}`);
    const offerFromHtml = detectOfferFromHtml(html);
    const mergedSignals = Array.from(new Set([...offerFromText.signals, ...offerFromHtml.signals]));

    return {
      url,
      title: extracted.title,
      hasOffer: mergedSignals.length > 0,
      offerSignals: mergedSignals,
      candidateText: extracted.candidateText,
      bodyHtml: extracted.bodyHtml.slice(0, 300000),
      bodyTextSnippet: extracted.bodyText.slice(0, 8000),
      html: html.slice(0, 300000)
    };
  } finally {
    await page.close();
  }
}

async function scrapeProductPage(url) {
  if (!playwrightLib || !playwrightLib.chromium) {
    throw new Error('Playwright no instalado');
  }

  const browser = await playwrightLib.chromium.launch({ headless: true });
  try {
    return await scrapeProductPageWithBrowser(browser, url);
  } finally {
    await browser.close();
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error('Body demasiado grande'));
      }
    });
    req.on('end', () => {
      const parsed = safeJsonParse(body || '{}');
      if (!parsed || typeof parsed !== 'object') {
        reject(new Error('Body JSON invalido'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

function buildExportPromptAndSchema() {
  return [
    'PROMPT_PARA_CHATGPT:',
    'Analiza cada bloque ITEM del dataset y detecta promociones de supermercado.',
    'Reglas:',
    '- Responder SOLO JSON valido (sin markdown).',
    '- Devolver 1 objeto por ITEM.',
    '- Si no hay promocion clara, has_promo=false y promo_type=\"none\".',
    '- Usa evidencia textual exacta encontrada en el bloque.',
    '',
    'SALIDA_JSON_ESPERADA:',
    '[',
    '  {',
    '    "item_id": "string",',
    '    "ean": "string",',
    '    "store": "string",',
    '    "url": "string",',
    '    "has_promo": true,',
    '    "promo_type": "2x1|3x2|3x1|segunda_unidad|porcentaje|combo|none",',
    '    "promo_text": "string",',
    '    "confidence": 0.0',
    '  }',
    ']',
    '',
    'DATASET_INICIO:',
    '=== DATASET_START ==='
  ].join('\n');
}

function flattenExportTasks(groupedByEanFiltered) {
  const tasks = [];
  (groupedByEanFiltered || []).forEach((row) => {
    const pricesBySupermarket = row && row.pricesBySupermarket ? row.pricesBySupermarket : {};
    Object.entries(pricesBySupermarket).forEach(([store, entry]) => {
      if (!entry || !entry.link) return;
      tasks.push({
        ean: row.ean || '',
        unifiedName: row.unifiedName || '',
        brand: row.brand || '',
        store,
        url: entry.link
      });
    });
  });
  return tasks;
}

function updateJob(jobId, patch) {
  const current = exportJobs.get(jobId);
  if (!current) return;
  exportJobs.set(jobId, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

async function runExportJob(jobId, payload) {
  const tasks = flattenExportTasks(payload.groupedByEanFiltered);
  const total = tasks.length;
  updateJob(jobId, { status: 'running', total, current: 0, message: 'Iniciando scraping...' });

  if (!playwrightLib || !playwrightLib.chromium) {
    updateJob(jobId, { status: 'failed', message: 'Playwright no instalado' });
    return;
  }

  const lines = [];
  lines.push(`# Export generado: ${new Date().toISOString()}`);
  lines.push(`# Query: ${payload.query || ''}`);
  lines.push(`# Brand filter: ${payload.brandFilter || 'Todas'}`);
  lines.push('');
  lines.push(buildExportPromptAndSchema());

  const browser = await playwrightLib.chromium.launch({ headless: true });
  let processed = 0;

  try {
    for (const task of tasks) {
      processed += 1;
      updateJob(jobId, {
        current: processed,
        message: `Scrapeando ${processed}/${total}: ${task.store} - ${task.unifiedName}`
      });

      let scraped;
      try {
        // eslint-disable-next-line no-await-in-loop
        scraped = await scrapeProductPageWithBrowser(browser, task.url);
      } catch (error) {
        scraped = {
          title: '',
          candidateText: '',
          bodyTextSnippet: '',
          html: '',
          error: error.message
        };
      }

      const itemId = `${task.ean || 'SIN_EAN'}|${task.store}`;
      lines.push('=== ITEM_START ===');
      lines.push(`item_id: ${itemId}`);
      lines.push(`ean: ${task.ean}`);
      lines.push(`store: ${task.store}`);
      lines.push(`brand: ${task.brand}`);
      lines.push(`name: ${task.unifiedName}`);
      lines.push(`url: ${task.url}`);
      if (scraped.error) lines.push(`scrape_error: ${scraped.error}`);
      lines.push('TITLE:');
      lines.push(scraped.title || '');
      lines.push('CANDIDATE_TEXT:');
      lines.push(scraped.candidateText || '');
      lines.push('VISIBLE_TEXT_SNIPPET:');
      lines.push(scraped.bodyTextSnippet || '');
      lines.push('HTML_SNIPPET:');
      lines.push((scraped.html || '').slice(0, 120000));
      lines.push('=== ITEM_END ===');
      lines.push('');
    }
  } finally {
    await browser.close();
  }

  lines.push('=== DATASET_END ===');
  lines.push('');
  lines.push('INSTRUCCION_FINAL: Responder solo JSON valido.');

  updateJob(jobId, {
    status: 'done',
    current: total,
    message: 'Completado',
    outputText: lines.join('\n')
  });
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
    const brand = (url.searchParams.get('brand') || '').trim();
    if (!product) {
      sendJson(res, 400, { error: 'Falta query param: product' });
      return;
    }

    try {
      const apiUrl = `https://www.preciosuper.com/api/products?product=${encodeURIComponent(product)}`;
      const rawPayload = await fetchJson(apiUrl);
      const rawResults = normalizeProducts(rawPayload);
      const groupedByEan = groupByEan(rawResults);
      const groupedByEanFiltered = filterGroupedByEan(groupedByEan.rows, product, brand);

      sendJson(res, 200, {
        query: product,
        brandFilter: brand,
        meta: {
          rawCount: rawResults.length,
          groupedByEanCount: groupedByEan.rows.length,
          groupedByEanFilteredCount: groupedByEanFiltered.length,
          generatedAt: new Date().toISOString()
        },
        rawResults,
        groupedByEan: groupedByEan.rows,
        groupedByEanFiltered,
        supermarkets: groupedByEan.supermarkets
      });
    } catch (error) {
      sendJson(res, 502, {
        error: 'No se pudo consultar preciosuper o procesar datos',
        detail: error.message
      });
    }

    return;
  }

  if (url.pathname === '/api/export-llm-start' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const groupedByEanFiltered = Array.isArray(payload.groupedByEanFiltered) ? payload.groupedByEanFiltered : [];
      const jobId = crypto.randomUUID();

      exportJobs.set(jobId, {
        id: jobId,
        status: 'queued',
        total: 0,
        current: 0,
        message: 'En cola',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        outputText: null
      });

      runExportJob(jobId, {
        query: String(payload.query || ''),
        brandFilter: String(payload.brandFilter || ''),
        groupedByEanFiltered
      }).catch((error) => {
        updateJob(jobId, { status: 'failed', message: error.message });
      });

      sendJson(res, 200, { jobId });
    } catch (error) {
      sendJson(res, 400, { error: 'No se pudo iniciar el export', detail: error.message });
    }
    return;
  }

  if (url.pathname === '/api/export-llm-status' && req.method === 'GET') {
    const jobId = (url.searchParams.get('id') || '').trim();
    const job = exportJobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: 'Job no encontrado' });
      return;
    }
    sendJson(res, 200, {
      id: job.id,
      status: job.status,
      total: job.total,
      current: job.current,
      message: job.message,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ready: job.status === 'done'
    });
    return;
  }

  if (url.pathname === '/api/export-llm-download' && req.method === 'GET') {
    const jobId = (url.searchParams.get('id') || '').trim();
    const job = exportJobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: 'Job no encontrado' });
      return;
    }
    if (job.status !== 'done' || !job.outputText) {
      sendJson(res, 409, { error: 'El job aun no termino' });
      return;
    }

    const fileName = `llm_export_${job.id}.txt`;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename=\"${fileName}\"`
    });
    res.end(job.outputText);
    return;
  }

  if (url.pathname === '/api/scrape-product' && req.method === 'GET') {
    const productUrl = (url.searchParams.get('url') || '').trim();

    if (!productUrl) {
      sendJson(res, 400, { error: 'Falta query param: url' });
      return;
    }

    if (!/^https?:\/\//i.test(productUrl)) {
      sendJson(res, 400, { error: 'URL invalida. Debe comenzar con http:// o https://' });
      return;
    }

    try {
      const scraped = await scrapeProductPage(productUrl);
      sendJson(res, 200, scraped);
    } catch (error) {
      sendJson(res, 502, {
        error: 'No se pudo scrapear la URL del producto',
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
