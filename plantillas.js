import express from 'express';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import admin from 'firebase-admin';

const router = express.Router();
router.use(express.json({ limit: '2mb' }));

const IGV_DEFAULT = 0.18;
const CURRENCY = 'PEN';
const LOCALE = 'es-PE';

const TEMPLATE_REGISTRY = {
  moderna: {
    id: 'moderna',
    name: 'Moderna Azul',
    description: 'Diseño limpio, comercial y actual.',
    theme: {
      accent: '#2563eb',
      accentSoft: '#dbeafe',
      ink: '#0f172a',
      muted: '#64748b',
      line: '#cbd5e1',
      panel: '#f8fafc',
      panelStrong: '#e2e8f0',
      success: '#0f766e'
    }
  },
  elegante: {
    id: 'elegante',
    name: 'Elegante Grafito',
    description: 'Acabado sobrio con presencia premium.',
    theme: {
      accent: '#111827',
      accentSoft: '#e5e7eb',
      ink: '#111827',
      muted: '#6b7280',
      line: '#d1d5db',
      panel: '#fafaf9',
      panelStrong: '#e7e5e4',
      success: '#166534'
    }
  },
  corporativa: {
    id: 'corporativa',
    name: 'Corporativa Índigo',
    description: 'Ideal para marcas serias y ventas B2B.',
    theme: {
      accent: '#3730a3',
      accentSoft: '#e0e7ff',
      ink: '#1f2937',
      muted: '#6b7280',
      line: '#c7d2fe',
      panel: '#f8faff',
      panelStrong: '#e0e7ff',
      success: '#0f766e'
    }
  },
  premium: {
    id: 'premium',
    name: 'Premium Esmeralda',
    description: 'Estilo ejecutivo con contraste elegante.',
    theme: {
      accent: '#065f46',
      accentSoft: '#d1fae5',
      ink: '#0f172a',
      muted: '#6b7280',
      line: '#a7f3d0',
      panel: '#f0fdf4',
      panelStrong: '#d1fae5',
      success: '#047857'
    }
  }
};

// Función para obtener la base de datos (debe ser exportada desde index.js o pasada)
let dbInstance = null;

export function setDb(db) {
  dbInstance = db;
}

// Plan gratuito: identificador real usado en Firestore (ver index.js / negocios.js -> PLANES_CONFIG)
const PLAN_GRATIS_ID = 'gratis';

// Plantillas exclusivas del plan gratuito (según public/planes.html)
const PLANTILLAS_PLAN_GRATIS = ['moderna'];

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(value, currency = CURRENCY) {
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date);
}

function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function buildSeries(documentType) {
  return documentType === 'factura' ? 'F001' : 'B001';
}

function buildCorrelative() {
  return String(Date.now()).slice(-8);
}

function buildDocumentNumber(documentType, customSeries, customCorrelative) {
  const series = (customSeries || buildSeries(documentType)).toUpperCase();
  const correlative = String(customCorrelative || buildCorrelative()).padStart(8, '0');
  return { series, correlative, full: `${series}-${correlative}` };
}

function normalizeItems(rawItems = []) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const cleaned = items
    .map((item, index) => ({
      description: String(item.description || '').trim(),
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      unitLabel: String(item.unitLabel || 'UND').trim().toUpperCase(),
      sku: String(item.sku || '').trim(),
      index
    }))
    .filter((item) => item.description && item.quantity > 0 && item.unitPrice >= 0);

  if (!cleaned.length) {
    throw new Error('Debes ingresar al menos un ítem válido.');
  }

  return cleaned.map((item, index) => ({ ...item, index: index + 1 }));
}

function calculateTotals({ items, taxRate = IGV_DEFAULT, pricesIncludeTax = true }) {
  const rate = Number.isFinite(Number(taxRate)) ? Number(taxRate) : IGV_DEFAULT;

  const enrichedItems = items.map((item) => {
    const gross = item.quantity * item.unitPrice;
    const subtotal = pricesIncludeTax ? gross / (1 + rate) : gross;
    const tax = subtotal * rate;
    const total = pricesIncludeTax ? gross : subtotal + tax;

    return {
      ...item,
      subtotal,
      tax,
      total,
      gross,
      unitSubtotal: pricesIncludeTax ? item.unitPrice / (1 + rate) : item.unitPrice,
      unitTotal: pricesIncludeTax ? item.unitPrice : item.unitPrice * (1 + rate)
    };
  });

  const subtotal = enrichedItems.reduce((sum, item) => sum + item.subtotal, 0);
  const tax = enrichedItems.reduce((sum, item) => sum + item.tax, 0);
  const total = enrichedItems.reduce((sum, item) => sum + item.total, 0);

  return {
    items: enrichedItems,
    subtotal,
    tax,
    total,
    taxRate: rate,
    pricesIncludeTax
  };
}

function normalizePayload(payload = {}) {
  const documentType = payload.documentType === 'factura' ? 'factura' : 'boleta';
  const templateId = TEMPLATE_REGISTRY[payload.templateId] ? payload.templateId : 'moderna';
  const issueDate = payload.issueDate || new Date().toISOString();
  const pricesIncludeTax = payload.pricesIncludeTax !== false;
  const taxRate = Number.isFinite(Number(payload.taxRate)) ? Number(payload.taxRate) : IGV_DEFAULT;
  const currency = payload.currency || CURRENCY;

  const rawLogo = String(payload.issuer?.logoDataUrl || '').trim();
  const issuer = {
    businessName: String(payload.issuer?.businessName || 'TU NEGOCIO').trim(),
    documentNumber: String(payload.issuer?.documentNumber || '').trim(),
    address: String(payload.issuer?.address || '').trim(),
    phone: String(payload.issuer?.phone || '').trim(),
    email: String(payload.issuer?.email || '').trim(),
    website: String(payload.issuer?.website || '').trim(),
    // Solo se aceptan imágenes en base64 (data URL). Cualquier otro valor se descarta por seguridad.
    logoDataUrl: /^data:image\/(png|jpe?g|webp);base64,/.test(rawLogo) ? rawLogo : ''
  };

  const customer = {
    name: String(payload.customer?.name || 'CLIENTE VARIOS').trim(),
    documentType: String(payload.customer?.documentType || (documentType === 'factura' ? 'RUC' : 'DNI')).trim(),
    documentNumber: String(payload.customer?.documentNumber || '').trim(),
    email: String(payload.customer?.email || '').trim(),
    phone: String(payload.customer?.phone || '').trim(),
    address: String(payload.customer?.address || '').trim()
  };

  if (!issuer.businessName) throw new Error('La razón social o nombre comercial del emisor es obligatoria.');
  if (!customer.name) throw new Error('El nombre del cliente es obligatorio.');

  const items = normalizeItems(payload.items);
  const totals = calculateTotals({ items, taxRate, pricesIncludeTax });
  const numbering = buildDocumentNumber(documentType, payload.series, payload.correlative);

  const meta = {
    issueDate,
    currency,
    notes: String(payload.notes || '').trim(),
    paymentMethod: String(payload.paymentMethod || 'Pago único').trim(),
    documentType,
    templateId,
    pricesIncludeTax,
    taxRate,
    issuer,
    customer,
    numbering,
    template: TEMPLATE_REGISTRY[templateId]
  };

  const qrContent = [
    issuer.documentNumber || '-',
    documentType === 'factura' ? '01' : '03',
    numbering.series,
    numbering.correlative,
    totals.tax.toFixed(2),
    totals.total.toFixed(2),
    formatDate(issueDate),
    customer.documentType || '-',
    customer.documentNumber || '-'
  ].join('|');

  return {
    ...meta,
    ...totals,
    qrContent,
    shareText: `${documentType === 'factura' ? 'Factura' : 'Boleta'} ${numbering.full} · ${customer.name} · ${formatMoney(totals.total, currency)}`
  };
}

async function getQrDataUrl(text) {
  return QRCode.toDataURL(text, {
    margin: 1,
    color: {
      dark: '#111827',
      light: '#ffffff'
    }
  });
}

/* ============================================================
   REDISEÑO PROFESIONAL (inspirado en comprobantes asiáticos)
   ============================================================ */
function buildTemplateCss(theme) {
  return `
    :root {
      --accent: ${theme.accent};
      --accent-soft: ${theme.accentSoft};
      --ink: ${theme.ink};
      --muted: ${theme.muted};
      --line: ${theme.line};
      --panel: ${theme.panel};
      --panel-strong: ${theme.panelStrong};
      --success: ${theme.success};
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
    }
    body {
      padding: 32px 16px;
      background:
        radial-gradient(circle at 15% 10%, rgba(37, 99, 235, 0.06) 0%, transparent 45%),
        radial-gradient(circle at 85% 90%, rgba(15, 118, 110, 0.06) 0%, transparent 45%),
        #eef2f7;
      color: var(--ink);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      font-feature-settings: 'tnum' 1, 'lnum' 1;
      -webkit-font-smoothing: antialiased;
    }
    .voucher {
      max-width: 860px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 28px;
      overflow: hidden;
      box-shadow:
        0 1px 2px rgba(15, 23, 42, 0.04),
        0 30px 70px -20px rgba(15, 23, 42, 0.22),
        0 8px 24px -10px rgba(15, 23, 42, 0.12);
      border: 1px solid rgba(148, 163, 184, 0.18);
    }

    /* ===== HERO / CABECERA ===== */
    .hero {
      position: relative;
      background:
        radial-gradient(circle at 88% 15%, rgba(255,255,255,0.18) 0%, transparent 45%),
        linear-gradient(135deg, var(--accent) 0%, #0f172a 130%);
      color: #ffffff;
      padding: 34px 36px 30px;
      display: grid;
      grid-template-columns: 1.35fr 0.85fr;
      gap: 22px;
      align-items: start;
      overflow: hidden;
    }
    .hero::after {
      content: '';
      position: absolute;
      right: -80px;
      bottom: -80px;
      width: 220px;
      height: 220px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.14);
      pointer-events: none;
    }
    .hero::before {
      content: '';
      position: absolute;
      right: -30px;
      top: -60px;
      width: 160px;
      height: 160px;
      border-radius: 50%;
      background: rgba(255,255,255,0.06);
      pointer-events: none;
    }
    .brand-logo {
      max-width: 84px;
      max-height: 84px;
      border-radius: 16px;
      background: #ffffff;
      padding: 8px;
      margin-bottom: 16px;
      object-fit: contain;
      box-shadow: 0 10px 30px -8px rgba(0,0,0,0.35);
      display: block;
    }
    .brand-eyebrow {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.28em;
      text-transform: uppercase;
      opacity: 0.75;
      margin-bottom: 10px;
    }
    .brand-title {
      font-size: 30px;
      font-weight: 800;
      line-height: 1.08;
      margin-bottom: 16px;
      letter-spacing: -0.02em;
    }
    .brand-meta {
      display: grid;
      gap: 6px;
      font-size: 13px;
      opacity: 0.95;
      line-height: 1.5;
    }
    .brand-meta .row { display: flex; gap: 8px; align-items: baseline; }
    .brand-meta .row .k {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      opacity: 0.7;
      min-width: 78px;
      font-weight: 700;
    }
    .doc-card {
      background: rgba(255,255,255,0.12);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.22);
      border-radius: 22px;
      padding: 22px 22px 20px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 12px 30px -12px rgba(0,0,0,0.35);
      position: relative;
      z-index: 1;
    }
    .doc-type {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      opacity: 0.85;
      margin-bottom: 12px;
    }
    .doc-number {
      font-size: 26px;
      font-weight: 800;
      line-height: 1.1;
      margin-bottom: 14px;
      letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
    }
    .doc-meta {
      display: grid;
      gap: 6px;
      font-size: 12px;
      opacity: 0.95;
    }
    .doc-meta .row { display: flex; justify-content: space-between; gap: 10px; }
    .doc-meta .row .k { opacity: 0.75; }
    .doc-meta .row .v { font-weight: 700; }

    /* ===== CONTENIDO ===== */
    .content {
      padding: 30px 36px 8px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
      margin-bottom: 24px;
    }
    .box {
      border: 1px solid var(--line);
      border-radius: 20px;
      background: linear-gradient(180deg, #ffffff 0%, var(--panel) 100%);
      padding: 20px 22px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset;
    }
    .section-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--accent);
      font-weight: 800;
      margin-bottom: 14px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-size: 11px;
    }
    .section-title::before {
      content: '';
      width: 4px;
      height: 14px;
      border-radius: 4px;
      background: var(--accent);
      display: inline-block;
    }
    .info-list { display: grid; gap: 10px; }
    .info-list .info-row { display: grid; grid-template-columns: 96px 1fr; gap: 10px; font-size: 13px; align-items: baseline; }
    .info-list .info-row .k {
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 10px;
    }
    .info-list .info-row .v { color: var(--ink); font-weight: 600; word-break: break-word; }

    /* ===== TABLA DE ÍTEMS ===== */
    .items-wrap {
      border: 1px solid var(--line);
      border-radius: 20px;
      overflow: hidden;
      margin-bottom: 24px;
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset;
    }
    .items {
      width: 100%;
      border-collapse: collapse;
      background: white;
    }
    .items thead th {
      background: linear-gradient(180deg, var(--accent-soft) 0%, rgba(255,255,255,0.4) 100%);
      color: var(--accent);
      text-align: left;
      padding: 15px 18px;
      font-size: 10.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 800;
      border-bottom: 1px solid var(--line);
    }
    .items tbody td {
      padding: 16px 18px;
      border-top: 1px solid var(--line);
      vertical-align: top;
      font-size: 13px;
      color: var(--ink);
    }
    .items tbody tr:first-child td { border-top: none; }
    .items tbody tr:nth-child(even) td {
      background: var(--panel);
    }
    .item-name { font-weight: 700; line-height: 1.4; }
    .item-sku {
      color: var(--muted);
      font-size: 11px;
      margin-top: 5px;
      letter-spacing: 0.02em;
    }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .center { text-align: center; }

    /* ===== TOTALES Y RESUMEN ===== */
    .totals-area {
      display: grid;
      grid-template-columns: 1fr minmax(300px, 380px);
      gap: 20px;
      align-items: start;
      margin-bottom: 26px;
    }
    .summary-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .summary-pill {
      border: 1px solid var(--line);
      padding: 10px 16px;
      border-radius: 999px;
      background: #ffffff;
      font-weight: 600;
      color: var(--muted);
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .summary-pill::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      display: inline-block;
    }
    .notes-box {
      margin-top: 16px;
      border-radius: 18px;
      border: 1px dashed var(--line);
      background: var(--panel);
      padding: 16px 18px;
      color: var(--muted);
      font-size: 12.5px;
      line-height: 1.65;
    }
    .notes-box strong { color: var(--ink); }
    .empty-note {
      margin-top: 16px;
      padding: 16px 18px;
      background: var(--accent-soft);
      border-radius: 18px;
      color: var(--accent);
      font-weight: 700;
      font-size: 12.5px;
    }
    .totals {
      border: 1px solid var(--line);
      border-radius: 20px;
      overflow: hidden;
      background: #ffffff;
      box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset;
    }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td {
      padding: 16px 20px;
      border-top: 1px solid var(--line);
      font-size: 13px;
    }
    .totals tr:first-child td { border-top: none; }
    .totals td:first-child { color: var(--muted); }
    .totals td:last-child {
      text-align: right;
      font-weight: 700;
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .totals .grand td {
      background: linear-gradient(135deg, var(--accent) 0%, #0f172a 130%);
      color: #ffffff;
      font-size: 17px;
      font-weight: 800;
      padding: 20px;
      letter-spacing: -0.01em;
    }
    .totals .grand td:first-child { color: rgba(255,255,255,0.85); font-weight: 700; }
    .totals .grand td:last-child { color: #ffffff; }

    /* ===== FOOTER ===== */
    .footer {
      display: grid;
      grid-template-columns: 150px 1fr;
      gap: 22px;
      border-top: 1px solid var(--line);
      padding: 26px 36px 34px;
      align-items: start;
      background: linear-gradient(180deg, #ffffff 0%, var(--panel) 100%);
    }
    .qr-box {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: #ffffff;
      padding: 12px;
      text-align: center;
      box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset;
    }
    .qr-box img {
      width: 100%;
      max-width: 120px;
      display: block;
      margin: 0 auto 8px;
    }
    .qr-box .qr-label {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }
    .legal {
      color: var(--muted);
      line-height: 1.75;
      font-size: 12.5px;
    }
    .legal strong { color: var(--ink); }
    .legal .legal-title {
      display: inline-block;
      color: var(--accent);
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-size: 10.5px;
      margin-bottom: 6px;
    }
    .legal .qr-chain {
      display: block;
      margin-top: 10px;
      padding: 10px 12px;
      background: #ffffff;
      border: 1px dashed var(--line);
      border-radius: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px;
      color: var(--muted);
      word-break: break-all;
    }

    @media (max-width: 840px) {
      body { padding: 14px 10px; }
      .hero,
      .grid,
      .totals-area,
      .footer {
        grid-template-columns: 1fr;
      }
      .content,
      .hero,
      .footer { padding-left: 20px; padding-right: 20px; }
      .doc-number { font-size: 22px; }
      .brand-title { font-size: 24px; }
      .items-wrap { overflow-x: auto; }
      .items { min-width: 700px; }
    }
  `;
}

async function renderVoucherHtml(data, plan = PLAN_GRATIS_ID) {
  const { template, issuer, customer, numbering, items, subtotal, tax, total, notes, paymentMethod, documentType, currency, taxRate, pricesIncludeTax, qrContent, issueDate } = data;
  const qrDataUrl = await getQrDataUrl(qrContent);
  const title = documentType === 'factura' ? 'Factura electrónica' : 'Boleta de venta';
  const paymentLabel = paymentMethod || 'Pago único';
  const watermarkHtml = plan === PLAN_GRATIS_ID
    ? `<div style="position:fixed;top:45%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:64px;font-weight:800;color:rgba(15,23,42,0.08);pointer-events:none;white-space:nowrap;z-index:999;letter-spacing:0.05em;">FacilitoTools</div>`
    : '';

  const rows = items.map((item) => `
      <tr>
        <td class="center" style="width:38px;font-variant-numeric:tabular-nums;">${item.index}</td>
        <td>
          <div class="item-name">${escapeHtml(item.description)}</div>
          ${item.sku ? `<div class="item-sku">SKU: ${escapeHtml(item.sku)}</div>` : ''}
        </td>
        <td class="center" style="width:70px;">${escapeHtml(item.unitLabel)}</td>
        <td class="num" style="width:70px;">${item.quantity}</td>
        <td class="num" style="width:110px;">${formatMoney(item.unitTotal, currency)}</td>
        <td class="num" style="width:120px;font-weight:700;">${formatMoney(item.total, currency)}</td>
      </tr>
    `).join('');

  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} ${escapeHtml(numbering.full)}</title>
    <style>${buildTemplateCss(template.theme)}</style>
  </head>
  <body>
    ${watermarkHtml}
    <article class="voucher">
      <header class="hero">
        <div>
          ${issuer.logoDataUrl ? `<img src="${issuer.logoDataUrl}" alt="Logo" class="brand-logo" />` : ''}
          <div class="brand-eyebrow">Comprobante de pago</div>
          <div class="brand-title">${escapeHtml(issuer.businessName)}</div>
          <div class="brand-meta">
            ${issuer.documentNumber ? `<div class="row"><span class="k">Documento</span><span>${escapeHtml(issuer.documentNumber)}</span></div>` : ''}
            ${issuer.address ? `<div class="row"><span class="k">Dirección</span><span>${escapeHtml(issuer.address)}</span></div>` : ''}
            ${issuer.phone ? `<div class="row"><span class="k">Teléfono</span><span>${escapeHtml(issuer.phone)}</span></div>` : ''}
            ${issuer.email ? `<div class="row"><span class="k">Email</span><span>${escapeHtml(issuer.email)}</span></div>` : ''}
            ${issuer.website ? `<div class="row"><span class="k">Web</span><span>${escapeHtml(issuer.website)}</span></div>` : ''}
          </div>
        </div>
        <div class="doc-card">
          <div class="doc-type">${escapeHtml(title)}</div>
          <div class="doc-number">${escapeHtml(numbering.full)}</div>
          <div class="doc-meta">
            <div class="row"><span class="k">Fecha</span><span class="v">${escapeHtml(formatDateTime(issueDate))}</span></div>
            <div class="row"><span class="k">Moneda</span><span class="v">${escapeHtml(currency)}</span></div>
            <div class="row"><span class="k">Plantilla</span><span class="v">${escapeHtml(template.name)}</span></div>
            <div class="row"><span class="k">Pago</span><span class="v">${escapeHtml(paymentLabel)}</span></div>
          </div>
        </div>
      </header>

      <section class="content">
        <div class="grid">
          <div class="box">
            <div class="section-title">Datos del cliente</div>
            <div class="info-list">
              <div class="info-row"><span class="k">Nombre</span><span class="v">${escapeHtml(customer.name)}</span></div>
              <div class="info-row"><span class="k">${escapeHtml(customer.documentType || 'Documento')}</span><span class="v">${escapeHtml(customer.documentNumber || '-')}</span></div>
              ${customer.email ? `<div class="info-row"><span class="k">Email</span><span class="v">${escapeHtml(customer.email)}</span></div>` : ''}
              ${customer.phone ? `<div class="info-row"><span class="k">Teléfono</span><span class="v">${escapeHtml(customer.phone)}</span></div>` : ''}
              ${customer.address ? `<div class="info-row"><span class="k">Dirección</span><span class="v">${escapeHtml(customer.address)}</span></div>` : ''}
            </div>
          </div>

          <div class="box">
            <div class="section-title">Resumen comercial</div>
            <div class="info-list">
              <div class="info-row"><span class="k">Gravado</span><span class="v">${formatMoney(subtotal, currency)}</span></div>
              <div class="info-row"><span class="k">IGV ${(taxRate * 100).toFixed(0)}%</span><span class="v">${formatMoney(tax, currency)}</span></div>
              <div class="info-row"><span class="k">Total</span><span class="v" style="color:var(--accent);">${formatMoney(total, currency)}</span></div>
              <div class="info-row"><span class="k">Precios</span><span class="v">${pricesIncludeTax ? 'Con IGV incluido' : 'Sin IGV'}</span></div>
            </div>
          </div>
        </div>

        <div class="items-wrap">
          <table class="items">
            <thead>
              <tr>
                <th class="center">#</th>
                <th>Descripción</th>
                <th class="center">Unidad</th>
                <th class="num">Cant.</th>
                <th class="num">P. unitario</th>
                <th class="num">Importe</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>

        <div class="totals-area">
          <div>
            <div class="summary-pills">
              <div class="summary-pill">${items.length} ítem(s)</div>
              <div class="summary-pill">${escapeHtml(documentType === 'factura' ? 'Factura empresarial' : 'Boleta de venta')}</div>
              <div class="summary-pill">Plantilla ${escapeHtml(template.name)}</div>
            </div>
            ${notes
              ? `<div class="notes-box"><strong>Observaciones:</strong><br/>${escapeHtml(notes)}</div>`
              : `<div class="empty-note">Puedes añadir observaciones, condiciones comerciales o un mensaje de agradecimiento.</div>`}
          </div>
          <div class="totals">
            <table>
              <tr>
                <td>Subtotal</td>
                <td>${formatMoney(subtotal, currency)}</td>
              </tr>
              <tr>
                <td>IGV (${(taxRate * 100).toFixed(0)}%)</td>
                <td>${formatMoney(tax, currency)}</td>
              </tr>
              <tr class="grand">
                <td>Total a pagar</td>
                <td>${formatMoney(total, currency)}</td>
              </tr>
            </table>
          </div>
        </div>
      </section>

      <footer class="footer">
        <div class="qr-box">
          <img src="${qrDataUrl}" alt="QR del comprobante" />
          <div class="qr-label">QR de validación</div>
        </div>
        <div class="legal">
          <span class="legal-title">Representación profesional del comprobante</span><br/>
          Este documento ha sido generado para agilizar la emisión comercial de ventas por redes sociales y canales directos. Verifica siempre los datos fiscales del emisor y del cliente antes de compartir o descargar el PDF final.
          <span class="qr-chain"><strong>Cadena QR:</strong> ${escapeHtml(qrContent)}</span>
        </div>
      </footer>
    </article>
  </body>
</html>`;
}

/* ============================================================
   PDF — REDISEÑO PROFESIONAL
   ============================================================ */
function drawText(doc, text, x, y, options = {}) {
  doc.text(String(text ?? ''), x, y, options);
}

function drawLabelValue(doc, label, value, x, y, width, gap = 14) {
  doc.font('Helvetica-Bold').fillColor('#0f172a').fontSize(9).text(label, x, y, { width });
  doc.font('Helvetica').fillColor('#334155').text(value || '-', x, y + gap, { width });
}

function ensureSpace(doc, y, neededHeight = 80) {
  if (y + neededHeight > doc.page.height - 60) {
    doc.addPage();
    return 50;
  }
  return y;
}

async function buildPdfBuffer(data, plan = PLAN_GRATIS_ID) {
  const { template, issuer, customer, numbering, items, subtotal, tax, total, notes, paymentMethod, documentType, currency, taxRate, qrContent, issueDate } = data;
  const theme = template.theme;
  const qrDataUrl = await getQrDataUrl(qrContent);
  const title = documentType === 'factura' ? 'FACTURA ELECTRÓNICA' : 'BOLETA DE VENTA';

  // Marca de agua para plan gratuito
  const esGratuito = plan === PLAN_GRATIS_ID;

  // Paleta extendida para el PDF (versiones más ricas derivadas del acento)
  const accentDark = '#0f172a';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.save();

    // Marca de agua "FacilitoTools" si es gratuito
    if (esGratuito) {
      doc.fontSize(60)
        .fillColor('#cccccc')
        .opacity(0.18)
        .text('FacilitoTools', 120, 400, { align: 'center', angle: -30, width: 400 })
        .opacity(1);
    }

    // ================================================================
    // HERO (cabecera con gradiente simulado en 3 capas de bandas)
    // ================================================================
    const issuerMetaLines = [
      issuer.documentNumber ? `Documento: ${issuer.documentNumber}` : '',
      issuer.address ? `Dirección: ${issuer.address}` : '',
      issuer.phone ? `Teléfono: ${issuer.phone}` : '',
      issuer.email ? `Email: ${issuer.email}` : ''
    ].filter(Boolean);

    const heroTop = 40;
    const heroTitleY = 74; // debajo del eyebrow
    const heroLineHeight = 12.5;
    const heroTitleToMetaGap = 12;
    const heroBottomPadding = 22;
    const heroMinHeight = 110;

    let issuerTextX = 60;
    let issuerTextWidth = 270;
    if (issuer.logoDataUrl) {
      issuerTextX = 128;
      issuerTextWidth = 200;
    }

    // Medir altura del nombre del negocio para evitar superposición
    doc.font('Helvetica-Bold').fontSize(19);
    const businessNameHeight = doc.heightOfString(issuer.businessName, { width: issuerTextWidth });
    const heroMetaStartY = heroTitleY + businessNameHeight + heroTitleToMetaGap;

    const heroHeight = Math.max(
      heroMinHeight,
      (heroMetaStartY - heroTop) + issuerMetaLines.length * heroLineHeight + heroBottomPadding
    );

    // Bandas superpuestas para simular gradiente (más oscuro a la derecha)
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).fill(theme.accent);
    doc.save();
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
    doc.rect(220, heroTop, 335, heroHeight).fillOpacity(0.28).fill('#000000').fillOpacity(1);
    doc.rect(360, heroTop, 195, heroHeight).fillOpacity(0.22).fill('#000000').fillOpacity(1);
    doc.restore();

    // Círculos decorativos sutiles (esquina derecha)
    doc.save();
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
    doc.circle(535, heroTop + heroHeight + 30, 90).fillOpacity(0.08).fill('#ffffff').fillOpacity(1);
    doc.circle(500, heroTop - 20, 60).fillOpacity(0.06).fill('#ffffff').fillOpacity(1);
    doc.restore();

    // Logo
    if (issuer.logoDataUrl) {
      try {
        doc.roundedRect(55, 60, 60, 60, 14).fillOpacity(0.18).fillAndStroke('#ffffff', '#ffffff').fillOpacity(1);
        doc.image(issuer.logoDataUrl, 60, 65, { fit: [50, 50], align: 'center', valign: 'center' });
      } catch (logoError) {
        // Si el logo no es válido, se omite silenciosamente
      }
    }

    // Eyebrow
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7).text('COMPROBANTE DE PAGO', issuerTextX, heroTitleY - 16, { width: issuerTextWidth, characterSpacing: 2 });

    // Nombre del negocio
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text(issuer.businessName, issuerTextX, heroTitleY, { width: issuerTextWidth });

    // Datos del emisor
    doc.font('Helvetica').fontSize(8.5);
    let issuerMetaY = heroMetaStartY;
    issuerMetaLines.forEach((line) => {
      doc.fillColor('#ffffff').text(line, issuerTextX, issuerMetaY, { width: 240 });
      issuerMetaY += heroLineHeight;
    });

    // Tarjeta del documento (lado derecho, glass)
    const docCardX = 340;
    const docCardY = heroTop + 16;
    const docCardW = 195;
    const docCardH = heroHeight - 32;
    doc.roundedRect(docCardX, docCardY, docCardW, docCardH, 16).fillOpacity(0.14).fillAndStroke('#ffffff', 'rgba(255,255,255,0.35)').fillOpacity(1);

    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7).text('TIPO DE DOCUMENTO', docCardX + 16, docCardY + 14, { width: docCardW - 32, characterSpacing: 1.6 });
    doc.font('Helvetica-Bold').fontSize(9).text(title, docCardX + 16, docCardY + 26, { width: docCardW - 32 });

    doc.font('Helvetica-Bold').fontSize(15).text(numbering.full, docCardX + 16, docCardY + 44, { width: docCardW - 32 });

    // Separador
    doc.moveTo(docCardX + 16, docCardY + 68).lineTo(docCardX + docCardW - 16, docCardY + 68).strokeOpacity(0.25).strokeColor('#ffffff').lineWidth(0.6).stroke().strokeOpacity(1);

    doc.font('Helvetica').fontSize(7.5);
    let dmY = docCardY + 76;
    const dmRows = [
      ['Fecha', formatDateTime(issueDate)],
      ['Moneda', currency],
      ['Plantilla', template.name],
      ['Pago', paymentMethod || 'Pago único']
    ];
    dmRows.forEach(([k, v]) => {
      doc.fillColor('#ffffff').font('Helvetica').text(k, docCardX + 16, dmY, { width: 60 });
      doc.font('Helvetica-Bold').text(v, docCardX + 76, dmY, { width: docCardW - 92, align: 'right' });
      dmY += 12;
    });

    // ================================================================
    // TARJETAS INFO: Cliente / Detalle emisión
    // ================================================================
    const infoBoxTop = heroTop + heroHeight + 22;
    const infoBoxW = 250;
    const infoBoxH = 118;
    const infoBoxGap = 15;

    // Card cliente
    doc.roundedRect(40, infoBoxTop, infoBoxW, infoBoxH, 14).fillAndStroke(theme.panel, theme.line);
    // Card emisión
    doc.roundedRect(40 + infoBoxW + infoBoxGap, infoBoxTop, infoBoxW, infoBoxH, 14).fillAndStroke(theme.panel, theme.line);

    // Títulos con barrita de acento
    function drawSectionHeader(x, y, label) {
      doc.rect(x, y + 1, 3, 10).fill(theme.accent);
      doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8).text(label, x + 9, y, { characterSpacing: 1.2 });
    }

    drawSectionHeader(55, infoBoxTop + 14, 'DATOS DEL CLIENTE');
    drawSectionHeader(40 + infoBoxW + infoBoxGap + 15, infoBoxTop + 14, 'DETALLE DE EMISIÓN');

    // Filas cliente
    const rowStartY = infoBoxTop + 36;
    const rowGap = 24;
    drawLabelValue(doc, 'Nombre', customer.name, 55, rowStartY, infoBoxW - 30);
    drawLabelValue(doc, customer.documentType || 'Documento', customer.documentNumber || '-', 55, rowStartY + rowGap, infoBoxW - 30);
    drawLabelValue(doc, 'Email', customer.email || '-', 55, rowStartY + rowGap * 2, infoBoxW - 30);

    // Filas emisión
    const emissionX = 40 + infoBoxW + infoBoxGap + 15;
    drawLabelValue(doc, 'Fecha', formatDateTime(issueDate), emissionX, rowStartY, infoBoxW - 30);
    drawLabelValue(doc, 'Plantilla', template.name, emissionX, rowStartY + rowGap, infoBoxW - 30);
    drawLabelValue(doc, 'Pago', paymentMethod || 'Pago único', emissionX, rowStartY + rowGap * 2, infoBoxW - 30);

    // ================================================================
    // TABLA DE ÍTEMS
    // ================================================================
    let y = infoBoxTop + infoBoxH + 26;

    // Barra de cabecera de tabla
    const tableHeaderH = 30;
    doc.roundedRect(40, y, 515, tableHeaderH, 10).fill(theme.accentSoft);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8);

    const columns = {
      index: 50,
      desc: 78,
      unit: 320,
      qty: 380,
      unitPrice: 430,
      amount: 495
    };

    drawText(doc, '#', columns.index, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'DESCRIPCIÓN', columns.desc, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'UND', columns.unit, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'CANT.', columns.qty, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'P. UNIT', columns.unitPrice, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'IMPORTE', columns.amount, y + 11, { characterSpacing: 0.8 });

    y += tableHeaderH;

    // Filas de la tabla
    items.forEach((item, idx) => {
      const descHeight = doc.heightOfString(item.description, { width: 220, align: 'left' });
      const rowHeight = Math.max(30, descHeight + 14);
      y = ensureSpace(doc, y, rowHeight + 20);

      // Fondo alternado
      if (idx % 2 === 0) {
        doc.rect(40, y, 515, rowHeight).fillOpacity(0.55).fill(theme.panel).fillOpacity(1);
      }

      // Línea inferior sutil
      doc.moveTo(40, y + rowHeight).lineTo(555, y + rowHeight).strokeOpacity(0.35).strokeColor(theme.line).lineWidth(0.5).stroke().strokeOpacity(1);

      doc.fillColor(theme.ink).font('Helvetica').fontSize(9);
      drawText(doc, item.index, columns.index, y + 9);
      drawText(doc, item.description, columns.desc, y + 9, { width: 220 });
      drawText(doc, item.unitLabel, columns.unit, y + 9);
      drawText(doc, item.quantity, columns.qty, y + 9);
      drawText(doc, formatMoney(item.unitTotal, currency), columns.unitPrice, y + 9);
      doc.font('Helvetica-Bold');
      drawText(doc, formatMoney(item.total, currency), columns.amount, y + 9);
      doc.font('Helvetica');

      y += rowHeight;
    });

    // Cierre inferior de la tabla
    doc.moveTo(40, y).lineTo(555, y).strokeOpacity(0.35).strokeColor(theme.line).lineWidth(0.5).stroke().strokeOpacity(1);

    y += 22;
    y = ensureSpace(doc, y, 170);

    // ================================================================
    // OBSERVACIONES + TOTALES
    // ================================================================
    const bottomBlockH = 118;

    // Observaciones (izquierda)
    doc.roundedRect(40, y, 235, bottomBlockH, 14).fillAndStroke(theme.panel, theme.line);
    doc.rect(40, y, 3, 18).fill(theme.accent);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8).text('OBSERVACIONES', 55, y + 12, { characterSpacing: 1.2 });
    doc.font('Helvetica').fillColor(theme.ink).fontSize(8.5).text(
      notes || 'Puedes usar este espacio para garantía, condiciones, método de entrega o agradecimiento al cliente.',
      55,
      y + 34,
      { width: 205, align: 'left', lineGap: 2 }
    );

    // Totales (derecha) — estilo tarjeta con fila destacada
    const totalsX = 300;
    const totalsW = 255;
    doc.roundedRect(totalsX, y, totalsW, bottomBlockH, 14).fillAndStroke('#ffffff', theme.line);

    // Subtotal
    doc.fillColor(theme.muted).font('Helvetica').fontSize(9);
    doc.text('Subtotal', totalsX + 18, y + 20);
    doc.fillColor(theme.ink).font('Helvetica-Bold').text(formatMoney(subtotal, currency), totalsX + 18, y + 20, { width: totalsW - 36, align: 'right' });

    // IGV
    doc.fillColor(theme.muted).font('Helvetica');
    doc.text(`IGV (${(taxRate * 100).toFixed(0)}%)`, totalsX + 18, y + 42);
    doc.fillColor(theme.ink).font('Helvetica-Bold').text(formatMoney(tax, currency), totalsX + 18, y + 42, { width: totalsW - 36, align: 'right' });

    // Línea separadora
    doc.moveTo(totalsX + 16, y + 64).lineTo(totalsX + totalsW - 16, y + 64).strokeOpacity(0.4).strokeColor(theme.line).lineWidth(0.6).stroke().strokeOpacity(1);

    // Total destacado
    doc.roundedRect(totalsX + 14, y + 76, totalsW - 28, 32, 10).fill(theme.accent);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text('TOTAL', totalsX + 26, y + 86);
    doc.font('Helvetica-Bold').fontSize(13).text(formatMoney(total, currency), totalsX + 14, y + 84, { width: totalsW - 28, align: 'right' });

    // ================================================================
    // FOOTER: QR + Información
    // ================================================================
    y += bottomBlockH + 22;
    y = ensureSpace(doc, y, 130);

    // QR
    doc.roundedRect(40, y, 100, 100, 14).fillAndStroke('#ffffff', theme.line);
    doc.image(qrDataUrl, 50, y + 10, { width: 80 });
    doc.fillColor(theme.muted).font('Helvetica-Bold').fontSize(6.5).text('QR DE VALIDACIÓN', 40, y + 92, { width: 100, align: 'center', characterSpacing: 1.2 });

    // Panel derecho
    doc.roundedRect(155, y, 400, 100, 14).fillAndStroke(theme.panel, theme.line);
    doc.rect(155, y, 3, 20).fill(theme.accent);

    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(7.5).text('REPRESENTACIÓN PROFESIONAL DEL COMPROBANTE', 170, y + 14, { width: 370, characterSpacing: 0.8 });
    doc.font('Helvetica').fillColor('#475569').fontSize(8).text(
      `Documento: ${title} · ${numbering.full}\n` +
      `Precios ${data.pricesIncludeTax ? 'con' : 'sin'} IGV incluido. Pago: ${paymentMethod || 'Pago único'}.\n` +
      `Este archivo está pensado para ventas rápidas por Instagram, Facebook, WhatsApp y atención directa.`,
      170,
      y + 30,
      { width: 370, lineGap: 2 }
    );

    // Cadena QR en una línea aparte
    doc.font('Helvetica').fillColor(theme.muted).fontSize(7).text(
      `QR: ${qrContent}`,
      170,
      y + 78,
      { width: 370 }
    );

    doc.restore();
    doc.end();
  });
}

// ---------------------------------------------------------------
//  MIDDLEWARE DE VERIFICACIÓN DE LÍMITE
// ---------------------------------------------------------------
async function verificarLimite(uid) {
  if (!dbInstance) {
    throw new Error('Base de datos no disponible');
  }
  const userRef = dbInstance.collection('usuarios').doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    throw new Error('Usuario no encontrado');
  }
  const data = userDoc.data();
  // Campos reales del documento "usuarios" (ver index.js): tipoPlan, comprobantesLimite, comprobantesEmitidos
  const plan = data.tipoPlan || PLAN_GRATIS_ID;
  const limite = Number.isFinite(Number(data.comprobantesLimite)) ? Number(data.comprobantesLimite) : 0;
  const comprobantesEmitidos = Number(data.comprobantesEmitidos || 0);

  if (data.planStatus && data.planStatus !== 'active') {
    throw new Error('Tu plan no está activo. Revisa tu suscripción en la sección de Planes.');
  }

  if (limite !== -1 && comprobantesEmitidos >= limite) {
    throw new Error('Has alcanzado el límite de comprobantes de tu plan actual. Actualiza tu suscripción para seguir generando comprobantes.');
  }
  return { plan, limite, comprobantesEmitidos };
}

async function incrementarRecibos(uid) {
  if (!dbInstance) {
    throw new Error('Base de datos no disponible');
  }
  const userRef = dbInstance.collection('usuarios').doc(uid);
  await userRef.update({
    comprobantesEmitidos: admin.firestore.FieldValue.increment(1)
  });
}

// ---------------------------------------------------------------
//  RUTAS
// ---------------------------------------------------------------

router.get('/templates', (req, res) => {
  res.json({
    ok: true,
    freeTemplateIds: PLANTILLAS_PLAN_GRATIS,
    templates: Object.values(TEMPLATE_REGISTRY).map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      accent: template.theme.accent,
      accentSoft: template.theme.accentSoft,
      freePlan: PLANTILLAS_PLAN_GRATIS.includes(template.id)
    }))
  });
});

router.post('/preview', async (req, res) => {
  try {
    const { uid, ...payload } = req.body;
    if (!uid) {
      return res.status(401).json({ ok: false, message: 'Se requiere autenticación (uid).' });
    }

    // Verificar límite (sin consumir)
    const { plan } = await verificarLimite(uid);

    const normalized = normalizePayload(payload);

    // Si es plan gratuito, solo se permite la plantilla Moderna Azul (sin logo)
    if (plan === PLAN_GRATIS_ID) {
      if (!PLANTILLAS_PLAN_GRATIS.includes(normalized.templateId)) {
        return res.status(403).json({ ok: false, message: 'Tu plan gratuito solo permite usar la plantilla Moderna Azul. Actualiza tu plan para desbloquear Elegante, Corporativa y Premium.' });
      }
      normalized.issuer.logoDataUrl = '';
    }

    const html = await renderVoucherHtml(normalized, plan);

    res.json({
      ok: true,
      documentNumber: normalized.numbering.full,
      summary: {
        subtotal: normalized.subtotal,
        tax: normalized.tax,
        total: normalized.total,
        currency: normalized.currency,
        templateName: normalized.template.name,
        documentType: normalized.documentType
      },
      shareText: normalized.shareText,
      html
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'No se pudo generar la vista previa.' });
  }
});

router.post('/pdf', async (req, res) => {
  try {
    const { uid, ...payload } = req.body;
    if (!uid) {
      return res.status(401).json({ ok: false, message: 'Se requiere autenticación (uid).' });
    }

    // Verificar límite y obtener plan
    const { plan } = await verificarLimite(uid);

    const normalized = normalizePayload(payload);
    // Restricción de plantilla y logo para el plan gratuito
    if (plan === PLAN_GRATIS_ID) {
      if (!PLANTILLAS_PLAN_GRATIS.includes(normalized.templateId)) {
        return res.status(403).json({ ok: false, message: 'Tu plan gratuito solo permite usar la plantilla Moderna Azul. Actualiza tu plan para desbloquear Elegante, Corporativa y Premium.' });
      }
      normalized.issuer.logoDataUrl = '';
    }

    // Generar PDF (pasando el plan para la marca de agua)
    const pdfBuffer = await buildPdfBuffer(normalized, plan);
    const filename = `${normalized.documentType}_${normalized.numbering.full}.pdf`.replace(/\s+/g, '_');

    // Incrementar contador
    await incrementarRecibos(uid);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'No se pudo generar el PDF.' });
  }
});

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'plantillas-comprobantes' });
});

export {
  TEMPLATE_REGISTRY,
  PLANTILLAS_PLAN_GRATIS,
  normalizePayload,
  renderVoucherHtml,
  buildPdfBuffer,
  verificarLimite,
  incrementarRecibos
};
export default router;
