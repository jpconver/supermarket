const searchForm = document.getElementById('searchForm');
const productInput = document.getElementById('productInput');
const brandSelect = document.getElementById('brandSelect');
const statusBox = document.getElementById('status');

const rawBody = document.querySelector('#rawTable tbody');
const eanHead = document.querySelector('#eanTable thead');
const eanBody = document.querySelector('#eanTable tbody');
const eanFilteredHead = document.querySelector('#eanFilteredTable thead');
const eanFilteredBody = document.querySelector('#eanFilteredTable tbody');
const eanFilteredCount = document.getElementById('eanFilteredCount');
const exportLlmBtn = document.getElementById('exportLlmBtn');
const exportProgress = document.getElementById('exportProgress');
const exportDownloadLink = document.getElementById('exportDownloadLink');
const llmJsonInput = document.getElementById('llmJsonInput');
const applyPromosBtn = document.getElementById('applyPromosBtn');
const promoApplyStatus = document.getElementById('promoApplyStatus');
const scrapeStatusBox = document.getElementById('scrapeStatus');
const scrapeMeta = document.getElementById('scrapeMeta');
const scrapeOutput = document.getElementById('scrapeOutput');
const scrapePreview = document.getElementById('scrapePreview');

let latestSearchData = null;
let exportPollingTimer = null;
let filteredRowsList = [];
let promoLookup = {
  byEanStore: new Map(),
  byUrl: new Map(),
  importedCount: 0,
  activeCount: 0
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(value, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback || '-';
  }

  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 2
  }).format(value);
}

function scoreText(score) {
  if (typeof score !== 'number') return '-';
  return `${Math.round(score * 100)}%`;
}

function linkCell(link) {
  if (!link) return '-';
  return `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Ver producto</a>`;
}

function availabilityCell(available) {
  return available
    ? '<span class="badge ok">SI</span>'
    : '<span class="badge no">NO</span>';
}

function discountText(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '0%';
  return `${value}%`;
}

function setStatus(text, isError = false) {
  statusBox.textContent = text;
  statusBox.style.color = isError ? '#b42318' : '#576779';
}

function setScrapeStatus(text, isError = false) {
  scrapeStatusBox.textContent = text;
  scrapeStatusBox.style.color = isError ? '#b42318' : '#576779';
}

function setScrapePanel(metaText, content) {
  scrapeMeta.textContent = metaText || '';
  scrapeOutput.textContent = content || '';
}

function setPromoStatus(text, isError = false) {
  promoApplyStatus.textContent = text || '';
  promoApplyStatus.style.color = isError ? '#b42318' : '#576779';
}

function resetPromoUi() {
  promoLookup = {
    byEanStore: new Map(),
    byUrl: new Map(),
    importedCount: 0,
    activeCount: 0
  };
  if (llmJsonInput) llmJsonInput.value = '';
  setPromoStatus('');
}

function resetExportUi() {
  exportProgress.textContent = '';
  exportDownloadLink.style.display = 'none';
  exportDownloadLink.removeAttribute('href');
  exportLlmBtn.disabled = false;
}

function sanitizeHtmlForPreview(html) {
  if (!html) return '<p>Sin HTML para mostrar</p>';

  // Sanitizacion basica para vista: remueve scripts y etiquetas potencialmente conflictivas.
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<base[^>]*>/gi, '');
}

function setPreviewHtml(html) {
  if (!scrapePreview) return;
  const safeBody = sanitizeHtmlForPreview(html);
  scrapePreview.srcdoc = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial, sans-serif; margin: 12px; color: #1e2a39; }
    img { max-width: 100%; height: auto; }
    a { color: #0e7490; }
  </style>
</head>
<body>${safeBody}</body>
</html>`;
}

function normalizeForKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function extractJsonFromText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    throw new Error('No hay texto para procesar');
  }

  const direct = (() => {
    try { return JSON.parse(text); } catch { return null; }
  })();
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* noop */ }
  }

  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) {
    const candidate = text.slice(firstArr, lastArr + 1);
    try { return JSON.parse(candidate); } catch { /* noop */ }
  }

  throw new Error('No se pudo extraer JSON valido del texto pegado');
}

function normalizePromoItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.results)) return payload.results;
  throw new Error('El JSON debe ser un array de items o contener items/results');
}

function buildPromoLookupFromItems(items) {
  const byEanStore = new Map();
  const byUrl = new Map();
  let activeCount = 0;

  items.forEach((rawItem) => {
    if (!rawItem || typeof rawItem !== 'object') return;

    const hasPromo = Boolean(rawItem.has_promo ?? rawItem.hasPromo);
    if (!hasPromo) return;

    const ean = String(rawItem.ean || '');
    const store = String(rawItem.store || '');
    const url = String(rawItem.url || '');
    const promoType = String(rawItem.promo_type || rawItem.promoType || 'promo');
    const promoText = String(rawItem.promo_text || rawItem.promoText || '');
    const confidence = Number(rawItem.confidence);

    const promo = {
      ean,
      store,
      url,
      promoType,
      promoText,
      confidence: Number.isFinite(confidence) ? confidence : null
    };

    const eanStoreKey = `${normalizeForKey(ean)}|${normalizeForKey(store)}`;
    if (normalizeForKey(ean) && normalizeForKey(store)) {
      byEanStore.set(eanStoreKey, promo);
    }
    if (normalizeForKey(url)) {
      byUrl.set(normalizeForKey(url), promo);
    }
    activeCount += 1;
  });

  return {
    byEanStore,
    byUrl,
    importedCount: items.length,
    activeCount
  };
}

function getPromoForCell(row, store, entry) {
  const eanStoreKey = `${normalizeForKey(row.ean)}|${normalizeForKey(store)}`;
  const byKey = promoLookup.byEanStore.get(eanStoreKey);
  if (byKey) return byKey;

  const byUrl = promoLookup.byUrl.get(normalizeForKey(entry?.link || ''));
  if (byUrl) return byUrl;

  return null;
}

function renderRaw(rows) {
  rawBody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.ean || '-')}</td>
      <td>${escapeHtml(r.name || '-')}</td>
      <td>${escapeHtml(r.brand || '-')}</td>
      <td>${escapeHtml(r.supermarket || '-')}</td>
      <td>${availabilityCell(r.availability)}</td>
      <td>${formatPrice(r.originalPrice, '-')}</td>
      <td>${discountText(r.discountPercentage)}</td>
      <td>${formatPrice(r.price, r.priceRaw?.amount)}</td>
      <td>${linkCell(r.link)}</td>
    </tr>
  `).join('');
}

function renderGroupedByEanTable(headEl, bodyEl, rows, supermarkets, withMatchScore = false, withScrape = false, withPromos = false) {
  const stores = Array.isArray(supermarkets) ? supermarkets : [];
  if (withMatchScore) {
    filteredRowsList = Array.isArray(rows) ? [...rows] : [];
  }
  headEl.innerHTML = `
    <tr>
      <th>EAN</th>
      <th>Producto unificado</th>
      <th>Marca</th>
      <th>Descripcion</th>
      <th>Coincidencias</th>
      ${withMatchScore ? '<th>Match</th>' : ''}
      ${withScrape ? '<th>Scraping</th>' : ''}
      ${stores.map((s) => `<th>${escapeHtml(s)}</th>`).join('')}
    </tr>
  `;

  bodyEl.innerHTML = rows.map((row, idx) => {
    let rowHasPromo = false;
    const cellsByStore = stores.map((store) => {
      const entry = row.pricesBySupermarket?.[store];
      if (!entry) return '<td>-</td>';

      const priceText = formatPrice(entry.price, '-');
      const stockText = entry.availability ? '' : ' (sin stock)';
      const promo = withPromos ? getPromoForCell(row, store, entry) : null;
      if (promo) rowHasPromo = true;
      const promoLabel = promo
        ? `<div class="small"><span class="badge promo">${escapeHtml(promo.promoType || 'promo')}</span> ${escapeHtml(promo.promoText || '')}</div>`
        : '';
      const scrapeBtn = withScrape && entry.link
        ? `<div><button type="button" class="mini-btn scrape-btn" data-url="${encodeURIComponent(entry.link)}">Ver HTML</button></div>`
        : '';
      return `<td>${escapeHtml(priceText)}${escapeHtml(stockText)}${promoLabel}${scrapeBtn}</td>`;
    }).join('');

    return `
      <tr class="${rowHasPromo ? 'row-has-promo' : ''}">
        <td>${escapeHtml(row.ean || '-')}</td>
        <td>${escapeHtml(row.unifiedName || '-')}</td>
        <td>${escapeHtml(row.brand || '-')}</td>
        <td><span class="small">${escapeHtml(row.unifiedDescription || '-')}</span></td>
        <td>${row.sourceCount ?? '-'}</td>
        ${withMatchScore ? `<td>${scoreText(row.eanMatchScore)}</td>` : ''}
        ${withScrape ? `<td>${row.representativeLink ? `<button type="button" class="mini-btn scrape-btn" data-url="${encodeURIComponent(row.representativeLink)}">Ver principal</button>` : '-'} ${withMatchScore ? `<button type="button" class="mini-btn llm-row-btn" data-row-idx="${idx}">TXT ChatGPT</button>` : ''}</td>` : ''}
        ${cellsByStore}
      </tr>
    `;
  }).join('');
}

function renderGroupedByEan(rows, supermarkets) {
  renderGroupedByEanTable(eanHead, eanBody, rows, supermarkets, false);
}

function renderGroupedByEanFiltered(rows, supermarkets, totalCount, activeBrandFilter) {
  const stores = Array.isArray(supermarkets) ? supermarkets : [];
  filteredRowsList = Array.isArray(rows) ? [...rows] : [];

  eanFilteredHead.innerHTML = `
    <tr>
      <th>EAN</th>
      <th>Producto unificado</th>
      <th>Marca</th>
      <th>Descripcion</th>
      <th>Coincidencias</th>
      <th>Match</th>
      <th>Scraping</th>
      ${stores.map((s) => `<th>${escapeHtml(s)}</th>`).join('')}
    </tr>
  `;

  eanFilteredBody.innerHTML = '';
  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    let rowHasPromo = false;

    const fixedCells = [
      row.ean || '-',
      row.unifiedName || '-',
      row.brand || '-',
      row.unifiedDescription || '-',
      String(row.sourceCount ?? '-'),
      scoreText(row.eanMatchScore)
    ];

    fixedCells.forEach((value, cellIdx) => {
      const td = document.createElement('td');
      if (cellIdx === 3) {
        const span = document.createElement('span');
        span.className = 'small';
        span.textContent = String(value);
        td.appendChild(span);
      } else {
        td.textContent = String(value);
      }
      tr.appendChild(td);
    });

    const scrapeTd = document.createElement('td');
    if (row.representativeLink) {
      const btnPrincipal = document.createElement('button');
      btnPrincipal.type = 'button';
      btnPrincipal.className = 'mini-btn scrape-btn';
      btnPrincipal.setAttribute('data-url', encodeURIComponent(row.representativeLink));
      btnPrincipal.textContent = 'Ver principal';
      scrapeTd.appendChild(btnPrincipal);
      scrapeTd.appendChild(document.createTextNode(' '));
    } else {
      scrapeTd.appendChild(document.createTextNode('- '));
    }

    const btnTxt = document.createElement('button');
    btnTxt.type = 'button';
    btnTxt.className = 'mini-btn llm-row-btn';
    btnTxt.setAttribute('data-row-idx', String(idx));
    btnTxt.textContent = 'TXT ChatGPT';
    scrapeTd.appendChild(btnTxt);
    tr.appendChild(scrapeTd);

    stores.forEach((store) => {
      const td = document.createElement('td');
      const entry = row.pricesBySupermarket?.[store];
      if (!entry) {
        td.textContent = '-';
        tr.appendChild(td);
        return;
      }

      const priceText = formatPrice(entry.price, '-');
      const stockText = entry.availability ? '' : ' (sin stock)';
      td.appendChild(document.createTextNode(`${priceText}${stockText}`));

      const promo = getPromoForCell(row, store, entry);
      if (promo) {
        rowHasPromo = true;
        const promoWrap = document.createElement('div');
        promoWrap.className = 'small';
        const badge = document.createElement('span');
        badge.className = 'badge promo';
        badge.textContent = promo.promoType || 'promo';
        promoWrap.appendChild(badge);
        promoWrap.appendChild(document.createTextNode(` ${promo.promoText || ''}`));
        td.appendChild(promoWrap);
      }

      if (entry.link) {
        const btnWrap = document.createElement('div');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mini-btn scrape-btn';
        btn.setAttribute('data-url', encodeURIComponent(entry.link));
        btn.textContent = 'Ver HTML';
        btnWrap.appendChild(btn);
        td.appendChild(btnWrap);
      }

      tr.appendChild(td);
    });

    if (rowHasPromo) {
      tr.classList.add('row-has-promo');
    }
    eanFilteredBody.appendChild(tr);
  });

  const brandText = activeBrandFilter ? ` (marca: ${activeBrandFilter})` : '';
  eanFilteredCount.textContent = `Quedaron ${rows.length} de ${totalCount} productos agrupados por EAN${brandText}. Filas renderizadas: ${eanFilteredBody.children.length}.`;
}

function clearTables() {
  rawBody.innerHTML = '';
  eanHead.innerHTML = '';
  eanBody.innerHTML = '';
  eanFilteredHead.innerHTML = '';
  eanFilteredBody.innerHTML = '';
  eanFilteredCount.textContent = '';
  filteredRowsList = [];
}

async function pollExportJob(jobId) {
  try {
    const response = await fetch(`/api/export-llm-status?id=${encodeURIComponent(jobId)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || 'No se pudo leer progreso');
    }

    const total = Number(data.total || 0);
    const current = Number(data.current || 0);
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    exportProgress.textContent = `${data.message || ''} ${total > 0 ? `(${current}/${total} - ${percent}%)` : ''}`.trim();

    if (data.status === 'done') {
      exportLlmBtn.disabled = false;
      exportDownloadLink.href = `/api/export-llm-download?id=${encodeURIComponent(jobId)}`;
      exportDownloadLink.style.display = 'inline';
      exportProgress.textContent = `Completado (${current}/${total}).`;
      exportPollingTimer = null;
      return;
    }

    if (data.status === 'failed') {
      exportLlmBtn.disabled = false;
      exportProgress.textContent = `Error: ${data.message || 'fallo del proceso'}`;
      exportPollingTimer = null;
      return;
    }

    exportPollingTimer = setTimeout(() => {
      pollExportJob(jobId);
    }, 1200);
  } catch (error) {
    exportLlmBtn.disabled = false;
    exportProgress.textContent = `Error consultando progreso: ${error.message}`;
    exportPollingTimer = null;
  }
}

async function startLlmExport() {
  if (!latestSearchData || !Array.isArray(latestSearchData.groupedByEanFiltered)) {
    exportProgress.textContent = 'Primero realiza una busqueda.';
    return;
  }

  await startLlmExportForRows(latestSearchData.groupedByEanFiltered, 'Iniciando export completo...');
}

async function startLlmExportForRows(rowsToExport, initialMessage) {
  if (!Array.isArray(rowsToExport) || !rowsToExport.length) {
    exportProgress.textContent = 'No hay filas para exportar.';
    return;
  }

  if (exportPollingTimer) {
    clearTimeout(exportPollingTimer);
    exportPollingTimer = null;
  }

  exportLlmBtn.disabled = true;
  exportDownloadLink.style.display = 'none';
  exportProgress.textContent = initialMessage || 'Iniciando export...';

  try {
    const response = await fetch('/api/export-llm-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: latestSearchData.query || '',
        brandFilter: latestSearchData.brandFilter || '',
        groupedByEanFiltered: rowsToExport
      })
    });
    const data = await response.json();

    if (!response.ok || !data.jobId) {
      throw new Error(data?.detail || data?.error || 'No se pudo iniciar export');
    }

    pollExportJob(data.jobId);
  } catch (error) {
    exportLlmBtn.disabled = false;
    exportProgress.textContent = `Error iniciando export: ${error.message}`;
  }
}

async function startLlmExportForSingleRow(rowIndex) {
  const idx = Number(rowIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= filteredRowsList.length) {
    exportProgress.textContent = 'No se encontro la fila seleccionada para exportar.';
    return;
  }

  const row = filteredRowsList[idx];
  if (!row) {
    exportProgress.textContent = 'No se encontro la fila seleccionada para exportar.';
    return;
  }

  await startLlmExportForRows([row], `Iniciando export rapido de fila (EAN: ${row.ean || 'sin ean'})...`);
}

function applyPromosFromTextarea() {
  if (!latestSearchData || !Array.isArray(latestSearchData.groupedByEanFiltered)) {
    setPromoStatus('Primero realiza una busqueda.', true);
    return;
  }

  try {
    const parsed = extractJsonFromText(llmJsonInput.value);
    const items = normalizePromoItems(parsed);
    promoLookup = buildPromoLookupFromItems(items);

    renderGroupedByEanFiltered(
      latestSearchData.groupedByEanFiltered || [],
      latestSearchData.supermarkets || [],
      latestSearchData.meta?.groupedByEanCount ?? 0,
      latestSearchData.brandFilter || ''
    );

    setPromoStatus(`Promos aplicadas: ${promoLookup.activeCount} de ${promoLookup.importedCount} items JSON.`);
  } catch (error) {
    setPromoStatus(`Error aplicando promos: ${error.message}`, true);
  }
}

async function scrapeProductUrl(productUrl) {
  setScrapeStatus('Scrapeando producto con navegador...');
  setScrapePanel('', '');
  setPreviewHtml('<p>Cargando preview...</p>');

  try {
    const response = await fetch(`/api/scrape-product?url=${encodeURIComponent(productUrl)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.detail || data?.error || 'Error desconocido');
    }

    const metaText = `URL: ${data.url} | Titulo: ${data.title || '-'} | Oferta detectada: ${data.hasOffer ? 'SI' : 'NO'} | Senales: ${(data.offerSignals || []).join(', ') || '-'}`;
    const combined = [
      '===== CANDIDATOS DE OFERTA =====',
      data.candidateText || '(sin candidatos)',
      '',
      '===== TEXTO VISIBLE (SNIPPET) =====',
      data.bodyTextSnippet || '(sin texto)',
      '',
      '===== HTML =====',
      data.html || '(sin html)'
    ].join('\n');

    setScrapePanel(metaText, combined);
    setPreviewHtml(data.bodyHtml || data.html || '<p>Sin HTML</p>');
    setScrapeStatus('Scraping completo.');
  } catch (error) {
    setScrapePanel('', '');
    setPreviewHtml('<p>Error al generar preview.</p>');
    setScrapeStatus(`Error scraping: ${error.message}`, true);
  }
}

eanFilteredBody.addEventListener('click', async (event) => {
  const rowExportBtn = event.target.closest('.llm-row-btn');
  if (rowExportBtn) {
    const rowIdx = rowExportBtn.getAttribute('data-row-idx');
    if (rowIdx === null) return;
    await startLlmExportForSingleRow(rowIdx);
    return;
  }

  const scrapeBtn = event.target.closest('.scrape-btn');
  if (!scrapeBtn) return;

  const encoded = scrapeBtn.getAttribute('data-url');
  if (!encoded) return;

  const productUrl = decodeURIComponent(encoded);
  await scrapeProductUrl(productUrl);
});

exportLlmBtn.addEventListener('click', async () => {
  await startLlmExport();
});

applyPromosBtn.addEventListener('click', () => {
  applyPromosFromTextarea();
});

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const product = productInput.value.trim();
  const brand = brandSelect ? brandSelect.value.trim() : '';
  if (!product) return;

  clearTables();
  latestSearchData = null;
  resetPromoUi();
  setStatus('Buscando precios y evaluando ofertas...');
  setScrapeStatus('');
  setScrapePanel('', '');
  setPreviewHtml('');
  resetExportUi();

  try {
    const query = new URLSearchParams({ product });
    if (brand) query.set('brand', brand);
    const response = await fetch(`/api/search?${query.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.detail || data?.error || 'Error desconocido');
    }

    latestSearchData = data;

    renderRaw(data.rawResults || []);
    renderGroupedByEan(data.groupedByEan || [], data.supermarkets || []);
    renderGroupedByEanFiltered(
      data.groupedByEanFiltered || [],
      data.supermarkets || [],
      data.meta?.groupedByEanCount ?? 0,
      data.brandFilter || ''
    );

    const meta = data.meta || {};
    const brandText = data.brandFilter ? ` | Marca: ${data.brandFilter}` : '';
    setStatus(`Listo. API: ${meta.rawCount ?? 0} | EAN: ${meta.groupedByEanCount ?? 0} | EAN filtrados: ${meta.groupedByEanFilteredCount ?? 0}${brandText}`);
  } catch (error) {
    clearTables();
    latestSearchData = null;
    resetPromoUi();
    resetExportUi();
    setStatus(`Error: ${error.message}`, true);
  }
});
