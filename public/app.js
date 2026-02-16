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
const scrapeStatusBox = document.getElementById('scrapeStatus');
const scrapeMeta = document.getElementById('scrapeMeta');
const scrapeOutput = document.getElementById('scrapeOutput');
const scrapePreview = document.getElementById('scrapePreview');

let latestSearchData = null;
let exportPollingTimer = null;

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

function renderGroupedByEanTable(headEl, bodyEl, rows, supermarkets, withMatchScore = false, withScrape = false) {
  const stores = Array.isArray(supermarkets) ? supermarkets : [];
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

  bodyEl.innerHTML = rows.map((row) => {
    const cellsByStore = stores.map((store) => {
      const entry = row.pricesBySupermarket?.[store];
      if (!entry) return '<td>-</td>';

      const priceText = formatPrice(entry.price, '-');
      const stockText = entry.availability ? '' : ' (sin stock)';
      const scrapeBtn = withScrape && entry.link
        ? `<div><button type="button" class="mini-btn scrape-btn" data-url="${encodeURIComponent(entry.link)}">Ver HTML</button></div>`
        : '';
      return `<td>${escapeHtml(priceText)}${escapeHtml(stockText)}${scrapeBtn}</td>`;
    }).join('');

    return `
      <tr>
        <td>${escapeHtml(row.ean || '-')}</td>
        <td>${escapeHtml(row.unifiedName || '-')}</td>
        <td>${escapeHtml(row.brand || '-')}</td>
        <td><span class="small">${escapeHtml(row.unifiedDescription || '-')}</span></td>
        <td>${row.sourceCount ?? '-'}</td>
        ${withMatchScore ? `<td>${scoreText(row.eanMatchScore)}</td>` : ''}
        ${withScrape ? `<td>${row.representativeLink ? `<button type="button" class="mini-btn scrape-btn" data-url="${encodeURIComponent(row.representativeLink)}">Ver principal</button>` : '-'}</td>` : ''}
        ${cellsByStore}
      </tr>
    `;
  }).join('');
}

function renderGroupedByEan(rows, supermarkets) {
  renderGroupedByEanTable(eanHead, eanBody, rows, supermarkets, false);
}

function renderGroupedByEanFiltered(rows, supermarkets, totalCount, activeBrandFilter) {
  renderGroupedByEanTable(eanFilteredHead, eanFilteredBody, rows, supermarkets, true, true);
  const brandText = activeBrandFilter ? ` (marca: ${activeBrandFilter})` : '';
  eanFilteredCount.textContent = `Quedaron ${rows.length} de ${totalCount} productos agrupados por EAN${brandText}.`;
}

function clearTables() {
  rawBody.innerHTML = '';
  eanHead.innerHTML = '';
  eanBody.innerHTML = '';
  eanFilteredHead.innerHTML = '';
  eanFilteredBody.innerHTML = '';
  eanFilteredCount.textContent = '';
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

  if (!latestSearchData.groupedByEanFiltered.length) {
    exportProgress.textContent = 'No hay EAN filtrados para exportar.';
    return;
  }

  if (exportPollingTimer) {
    clearTimeout(exportPollingTimer);
    exportPollingTimer = null;
  }

  exportLlmBtn.disabled = true;
  exportDownloadLink.style.display = 'none';
  exportProgress.textContent = 'Iniciando export...';

  try {
    const response = await fetch('/api/export-llm-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: latestSearchData.query || '',
        brandFilter: latestSearchData.brandFilter || '',
        groupedByEanFiltered: latestSearchData.groupedByEanFiltered
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
  const button = event.target.closest('.scrape-btn');
  if (!button) return;

  const encoded = button.getAttribute('data-url');
  if (!encoded) return;

  const productUrl = decodeURIComponent(encoded);
  await scrapeProductUrl(productUrl);
});

exportLlmBtn.addEventListener('click', async () => {
  await startLlmExport();
});

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const product = productInput.value.trim();
  const brand = brandSelect ? brandSelect.value.trim() : '';
  if (!product) return;

  clearTables();
  latestSearchData = null;
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
    resetExportUi();
    setStatus(`Error: ${error.message}`, true);
  }
});
