const searchForm = document.getElementById('searchForm');
const productInput = document.getElementById('productInput');
const statusBox = document.getElementById('status');

const rawBody = document.querySelector('#rawTable tbody');
const filteredBody = document.querySelector('#filteredTable tbody');
const groupedBody = document.querySelector('#groupedTable tbody');

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

function renderFiltered(rows) {
  filteredBody.innerHTML = rows.map((r) => {
    const offerBadge = r.hasOffer
      ? '<span class="badge ok">SI</span>'
      : '<span class="badge no">NO</span>';

    const detail = r.hasOffer
      ? (r.offerSignals?.join(', ') || 'Patrones detectados')
      : (r.offerError || '-');

    return `
      <tr>
        <td>${escapeHtml(r.ean || '-')}</td>
        <td>${escapeHtml(r.name || '-')}</td>
        <td>${escapeHtml(r.brand || '-')}</td>
        <td>${escapeHtml(r.supermarket || '-')}</td>
        <td>${availabilityCell(r.availability)}</td>
        <td>${formatPrice(r.price, r.priceRaw?.amount)}</td>
        <td>${formatPrice(r.originalPrice, '-')}</td>
        <td>${discountText(r.discountPercentage)}</td>
        <td>${scoreText(r.matchScore)}</td>
        <td>${offerBadge}</td>
        <td><span class="small">${escapeHtml(detail)}</span></td>
        <td>${linkCell(r.link)}</td>
      </tr>
    `;
  }).join('');
}

function renderGrouped(rows) {
  groupedBody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.supermarket)}</td>
      <td>${r.productCount}</td>
      <td>${r.availableCount}</td>
      <td>${r.unavailableCount}</td>
      <td>${formatPrice(r.minPrice)}</td>
      <td>${formatPrice(r.minAvailablePrice)}</td>
      <td>${formatPrice(r.avgPrice)}</td>
      <td>${formatPrice(r.maxPrice)}</td>
      <td>${r.anyOffer ? '<span class="badge ok">SI</span>' : '<span class="badge no">NO</span>'}</td>
      <td>${r.offerCount}</td>
    </tr>
  `).join('');
}

function clearTables() {
  rawBody.innerHTML = '';
  filteredBody.innerHTML = '';
  groupedBody.innerHTML = '';
}

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const product = productInput.value.trim();
  if (!product) return;

  clearTables();
  setStatus('Buscando precios y evaluando ofertas...');

  try {
    const response = await fetch(`/api/search?product=${encodeURIComponent(product)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.detail || data?.error || 'Error desconocido');
    }

    renderRaw(data.rawResults || []);
    renderFiltered(data.filteredResults || []);
    renderGrouped(data.groupedBySupermarket || []);

    const meta = data.meta || {};
    setStatus(`Listo. API: ${meta.rawCount ?? 0} | Filtrados: ${meta.filteredCount ?? 0} | Supermercados: ${meta.groupedCount ?? 0}`);
  } catch (error) {
    clearTables();
    setStatus(`Error: ${error.message}`, true);
  }
});
