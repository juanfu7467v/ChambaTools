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
  /* ============================================================
     4 PLANTILLAS EXISTENTES — INTACTAS
     ============================================================ */
  moderna: {
    id: 'moderna',
    name: 'Moderna Azul',
    description: 'Diseño limpio, comercial y actual.',
    layout: 'modern',
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
    layout: 'modern',
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
    layout: 'modern',
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
    layout: 'modern',
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
  },

  /* ============================================================
     NUEVAS PLANTILLAS INSPIRADAS EN ESTILOS ASIÁTICOS
     ============================================================ */
  sakura: {
    id: 'sakura',
    name: 'Sakura',
    description: 'Inspirada en la flor de cerezo: tonos rosados, detalles florales y elegancia suave.',
    layout: 'sakura',
    theme: {
      accent: '#d81b60',
      accentSoft: '#fce4ec',
      ink: '#1f2937',
      muted: '#6b7280',
      line: '#f8bbd0',
      panel: '#fff5f8',
      panelStrong: '#fce4ec',
      success: '#ad1457'
    }
  },
  imperial: {
    id: 'imperial',
    name: 'Imperial',
    description: 'Estilo tradicional chino con rojo profundo, detalles dorados y sello decorativo.',
    layout: 'imperial',
    theme: {
      accent: '#b71c1c',
      accentSoft: '#ffebee',
      ink: '#1a1a1a',
      muted: '#6b7280',
      line: '#e0b872',
      panel: '#fffaf3',
      panelStrong: '#ffefd5',
      success: '#b45309'
    }
  },
  jade: {
    id: 'jade',
    name: 'Jade Zen',
    description: 'Minimalismo asiático con tonos jade y espacios en blanco elegantes.',
    layout: 'jade',
    theme: {
      accent: '#00897b',
      accentSoft: '#e0f2f1',
      ink: '#0f172a',
      muted: '#64748b',
      line: '#b2dfdb',
      panel: '#f5fbfa',
      panelStrong: '#e0f2f1',
      success: '#00695c'
    }
  },
  dragon: {
    id: 'dragon',
    name: 'Dragón Dorado',
    description: 'Diseño moderno con patrones geométricos y toques dorados sobre azul profundo.',
    layout: 'dragon',
    theme: {
      accent: '#1e3a8a',
      accentSoft: '#e0e7ff',
      ink: '#0f172a',
      muted: '#64748b',
      line: '#c7d2fe',
      panel: '#f8fafc',
      panelStrong: '#e0e7ff',
      success: '#b45309'
    }
  }
};

// Función para obtener la base de datos (debe ser exportada desde index.js o pasada)
let dbInstance = null;

export function setDb(db) {
  dbInstance = db;
}

const PLAN_GRATIS_ID = 'gratis';
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
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(date);
}

function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
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

  if (!cleaned.length) throw new Error('Debes ingresar al menos un ítem válido.');
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
      ...item, subtotal, tax, total, gross,
      unitSubtotal: pricesIncludeTax ? item.unitPrice / (1 + rate) : item.unitPrice,
      unitTotal: pricesIncludeTax ? item.unitPrice : item.unitPrice * (1 + rate)
    };
  });
  const subtotal = enrichedItems.reduce((sum, item) => sum + item.subtotal, 0);
  const tax = enrichedItems.reduce((sum, item) => sum + item.tax, 0);
  const total = enrichedItems.reduce((sum, item) => sum + item.total, 0);
  return { items: enrichedItems, subtotal, tax, total, taxRate: rate, pricesIncludeTax };
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
    issueDate, currency,
    notes: String(payload.notes || '').trim(),
    paymentMethod: String(payload.paymentMethod || 'Pago único').trim(),
    documentType, templateId, pricesIncludeTax, taxRate,
    issuer, customer, numbering,
    template: TEMPLATE_REGISTRY[templateId]
  };

  const qrContent = [
    issuer.documentNumber || '-',
    documentType === 'factura' ? '01' : '03',
    numbering.series, numbering.correlative,
    totals.tax.toFixed(2), totals.total.toFixed(2),
    formatDate(issueDate),
    customer.documentType || '-',
    customer.documentNumber || '-'
  ].join('|');

  return {
    ...meta, ...totals, qrContent,
    shareText: `${documentType === 'factura' ? 'Factura' : 'Boleta'} ${numbering.full} · ${customer.name} · ${formatMoney(totals.total, currency)}`
  };
}

async function getQrDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, color: { dark: '#111827', light: '#ffffff' } });
}

/* ============================================================
   CSS BASE — PLANTILLA MODERNA (existente, intacta)
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
    html, body { margin: 0; padding: 0; }
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
      max-width: 860px; margin: 0 auto; background: #ffffff;
      border-radius: 28px; overflow: hidden;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 30px 70px -20px rgba(15, 23, 42, 0.22), 0 8px 24px -10px rgba(15, 23, 42, 0.12);
      border: 1px solid rgba(148, 163, 184, 0.18);
    }
    .hero {
      position: relative;
      background: radial-gradient(circle at 88% 15%, rgba(255,255,255,0.18) 0%, transparent 45%),
                  linear-gradient(135deg, var(--accent) 0%, #0f172a 130%);
      color: #ffffff; padding: 34px 36px 30px;
      display: grid; grid-template-columns: 1.35fr 0.85fr; gap: 22px;
      align-items: start; overflow: hidden;
    }
    .hero::after { content: ''; position: absolute; right: -80px; bottom: -80px; width: 220px; height: 220px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.14); pointer-events: none; }
    .hero::before { content: ''; position: absolute; right: -30px; top: -60px; width: 160px; height: 160px; border-radius: 50%; background: rgba(255,255,255,0.06); pointer-events: none; }
    .brand-logo { max-width: 84px; max-height: 84px; border-radius: 16px; background: #ffffff; padding: 8px; margin-bottom: 16px; object-fit: contain; box-shadow: 0 10px 30px -8px rgba(0,0,0,0.35); display: block; }
    .brand-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 0.28em; text-transform: uppercase; opacity: 0.75; margin-bottom: 10px; }
    .brand-title { font-size: 30px; font-weight: 800; line-height: 1.08; margin-bottom: 16px; letter-spacing: -0.02em; }
    .brand-meta { display: grid; gap: 6px; font-size: 13px; opacity: 0.95; line-height: 1.5; }
    .brand-meta .row { display: flex; gap: 8px; align-items: baseline; }
    .brand-meta .row .k { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.7; min-width: 78px; font-weight: 700; }
    .doc-card { background: rgba(255,255,255,0.12); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.22); border-radius: 22px; padding: 22px 22px 20px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 12px 30px -12px rgba(0,0,0,0.35); position: relative; z-index: 1; }
    .doc-type { font-size: 10px; font-weight: 800; letter-spacing: 0.22em; text-transform: uppercase; opacity: 0.85; margin-bottom: 12px; }
    .doc-number { font-size: 26px; font-weight: 800; line-height: 1.1; margin-bottom: 14px; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .doc-meta { display: grid; gap: 6px; font-size: 12px; opacity: 0.95; }
    .doc-meta .row { display: flex; justify-content: space-between; gap: 10px; }
    .doc-meta .row .k { opacity: 0.75; }
    .doc-meta .row .v { font-weight: 700; }
    .content { padding: 30px 36px 8px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 24px; }
    .box { border: 1px solid var(--line); border-radius: 20px; background: linear-gradient(180deg, #ffffff 0%, var(--panel) 100%); padding: 20px 22px; box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset; }
    .section-title { display: inline-flex; align-items: center; gap: 8px; color: var(--accent); font-weight: 800; margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px; }
    .section-title::before { content: ''; width: 4px; height: 14px; border-radius: 4px; background: var(--accent); display: inline-block; }
    .info-list { display: grid; gap: 10px; }
    .info-list .info-row { display: grid; grid-template-columns: 96px 1fr; gap: 10px; font-size: 13px; align-items: baseline; }
    .info-list .info-row .k { color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; }
    .info-list .info-row .v { color: var(--ink); font-weight: 600; word-break: break-word; }
    .items-wrap { border: 1px solid var(--line); border-radius: 20px; overflow: hidden; margin-bottom: 24px; background: #ffffff; box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset; }
    .items { width: 100%; border-collapse: collapse; background: white; }
    .items thead th { background: linear-gradient(180deg, var(--accent-soft) 0%, rgba(255,255,255,0.4) 100%); color: var(--accent); text-align: left; padding: 15px 18px; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 800; border-bottom: 1px solid var(--line); }
    .items tbody td { padding: 16px 18px; border-top: 1px solid var(--line); vertical-align: top; font-size: 13px; color: var(--ink); }
    .items tbody tr:first-child td { border-top: none; }
    .items tbody tr:nth-child(even) td { background: var(--panel); }
    .item-name { font-weight: 700; line-height: 1.4; }
    .item-sku { color: var(--muted); font-size: 11px; margin-top: 5px; letter-spacing: 0.02em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .center { text-align: center; }
    .totals-area { display: grid; grid-template-columns: 1fr minmax(300px, 380px); gap: 20px; align-items: start; margin-bottom: 26px; }
    .summary-pills { display: flex; flex-wrap: wrap; gap: 10px; }
    .summary-pill { border: 1px solid var(--line); padding: 10px 16px; border-radius: 999px; background: #ffffff; font-weight: 600; color: var(--muted); font-size: 12px; display: inline-flex; align-items: center; gap: 8px; }
    .summary-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); display: inline-block; }
    .notes-box { margin-top: 16px; border-radius: 18px; border: 1px dashed var(--line); background: var(--panel); padding: 16px 18px; color: var(--muted); font-size: 12.5px; line-height: 1.65; }
    .notes-box strong { color: var(--ink); }
    .empty-note { margin-top: 16px; padding: 16px 18px; background: var(--accent-soft); border-radius: 18px; color: var(--accent); font-weight: 700; font-size: 12.5px; }
    .totals { border: 1px solid var(--line); border-radius: 20px; overflow: hidden; background: #ffffff; box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset; }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td { padding: 16px 20px; border-top: 1px solid var(--line); font-size: 13px; }
    .totals tr:first-child td { border-top: none; }
    .totals td:first-child { color: var(--muted); }
    .totals td:last-child { text-align: right; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
    .totals .grand td { background: linear-gradient(135deg, var(--accent) 0%, #0f172a 130%); color: #ffffff; font-size: 17px; font-weight: 800; padding: 20px; letter-spacing: -0.01em; }
    .totals .grand td:first-child { color: rgba(255,255,255,0.85); font-weight: 700; }
    .totals .grand td:last-child { color: #ffffff; }
    .footer { display: grid; grid-template-columns: 150px 1fr; gap: 22px; border-top: 1px solid var(--line); padding: 26px 36px 34px; align-items: start; background: linear-gradient(180deg, #ffffff 0%, var(--panel) 100%); }
    .qr-box { border: 1px solid var(--line); border-radius: 18px; background: #ffffff; padding: 12px; text-align: center; box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset; }
    .qr-box img { width: 100%; max-width: 120px; display: block; margin: 0 auto 8px; }
    .qr-box .qr-label { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    .legal { color: var(--muted); line-height: 1.75; font-size: 12.5px; }
    .legal strong { color: var(--ink); }
    .legal .legal-title { display: inline-block; color: var(--accent); font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; font-size: 10.5px; margin-bottom: 6px; }
    .legal .qr-chain { display: block; margin-top: 10px; padding: 10px 12px; background: #ffffff; border: 1px dashed var(--line); border-radius: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--muted); word-break: break-all; }
    @media (max-width: 840px) {
      body { padding: 14px 10px; }
      .hero, .grid, .totals-area, .footer { grid-template-columns: 1fr; }
      .content, .hero, .footer { padding-left: 20px; padding-right: 20px; }
      .doc-number { font-size: 22px; }
      .brand-title { font-size: 24px; }
      .items-wrap { overflow-x: auto; }
      .items { min-width: 700px; }
    }
  `;
}

/* ============================================================
   NUEVA PLANTILLA: SAKURA (rosa y floral)
   ============================================================ */
function buildSakuraCss(theme) {
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
    html, body { margin: 0; padding: 0; }
    body {
      padding: 32px 16px;
      background: linear-gradient(180deg, #fff5f8 0%, #fce4ec 60%, #f8bbd0 100%);
      color: var(--ink);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-feature-settings: 'tnum' 1, 'lnum' 1;
      -webkit-font-smoothing: antialiased;
    }
    .voucher {
      max-width: 860px; margin: 0 auto; background: #ffffff;
      border-radius: 34px; overflow: hidden;
      box-shadow: 0 30px 80px -20px rgba(216,27,96,0.35), 0 10px 30px -10px rgba(216,27,96,0.15);
      border: 1px solid #f8bbd0; position: relative;
    }
    .hero {
      position: relative;
      background: linear-gradient(135deg, #fff0f5 0%, #fce4ec 55%, #f8bbd0 100%);
      color: #880e4f;
      padding: 40px 36px 34px;
      display: grid; grid-template-columns: 1.35fr 0.85fr; gap: 22px;
      align-items: start; overflow: hidden;
    }
    .hero::before {
      content: '✿'; position: absolute; top: -30px; right: 30px;
      font-size: 110px; color: rgba(216,27,96,0.10);
      transform: rotate(15deg); pointer-events: none; line-height: 1;
    }
    .hero::after {
      content: '❀'; position: absolute; bottom: -40px; left: 20px;
      font-size: 130px; color: rgba(216,27,96,0.08);
      transform: rotate(-20deg); pointer-events: none; line-height: 1;
    }
    .brand-logo {
      max-width: 84px; max-height: 84px; border-radius: 50%;
      background: #ffffff; padding: 8px; margin-bottom: 16px;
      object-fit: contain; box-shadow: 0 10px 30px -8px rgba(216,27,96,0.35);
      border: 2px solid #f8bbd0; display: block;
    }
    .brand-eyebrow {
      font-size: 10px; font-weight: 700; letter-spacing: 0.32em;
      text-transform: uppercase; color: #ad1457; opacity: 0.85; margin-bottom: 10px;
    }
    .brand-title {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 32px; font-weight: 700; line-height: 1.12;
      margin-bottom: 16px; color: #880e4f; letter-spacing: -0.01em;
    }
    .brand-meta { display: grid; gap: 6px; font-size: 13px; color: #6d1439; line-height: 1.55; }
    .brand-meta .row { display: flex; gap: 8px; align-items: baseline; }
    .brand-meta .row .k {
      font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
      color: #ad1457; opacity: 0.8; min-width: 78px; font-weight: 700;
    }
    .doc-card {
      background: rgba(255,255,255,0.75);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(216,27,96,0.20);
      border-radius: 26px; padding: 24px 22px;
      box-shadow: 0 12px 30px -12px rgba(216,27,96,0.3);
      position: relative; z-index: 1;
    }
    .doc-type {
      font-size: 10px; font-weight: 800; letter-spacing: 0.24em;
      text-transform: uppercase; color: #ad1457; opacity: 0.9; margin-bottom: 12px;
    }
    .doc-number {
      font-family: Georgia, serif; font-size: 26px; font-weight: 700;
      line-height: 1.1; margin-bottom: 14px; color: #880e4f;
      font-variant-numeric: tabular-nums;
    }
    .doc-meta { display: grid; gap: 6px; font-size: 12px; color: #6d1439; }
    .doc-meta .row { display: flex; justify-content: space-between; gap: 10px; }
    .doc-meta .row .k { color: #ad1457; opacity: 0.8; }
    .doc-meta .row .v { font-weight: 700; color: #4a051f; }
    .content { padding: 32px 36px 8px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 26px; }
    .box {
      border: 1px solid var(--line); border-radius: 24px;
      background: linear-gradient(180deg, #ffffff 0%, var(--panel) 100%);
      padding: 22px 24px; box-shadow: 0 4px 20px -8px rgba(216,27,96,0.08);
    }
    .section-title {
      display: inline-flex; align-items: center; gap: 8px;
      color: var(--accent); font-weight: 800; margin-bottom: 14px;
      text-transform: uppercase; letter-spacing: 0.16em; font-size: 11px;
      font-family: Georgia, serif;
    }
    .section-title::before {
      content: '❀'; font-size: 14px; color: var(--accent);
      line-height: 1; margin-right: 2px;
    }
    .info-list { display: grid; gap: 10px; }
    .info-list .info-row { display: grid; grid-template-columns: 96px 1fr; gap: 10px; font-size: 13px; align-items: baseline; }
    .info-list .info-row .k {
      color: #ad1457; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.06em; font-size: 10px; opacity: 0.85;
    }
    .info-list .info-row .v { color: var(--ink); font-weight: 600; word-break: break-word; }
    .items-wrap {
      border: 1px solid var(--line); border-radius: 24px; overflow: hidden;
      margin-bottom: 26px; background: #ffffff;
      box-shadow: 0 4px 20px -8px rgba(216,27,96,0.08);
    }
    .items { width: 100%; border-collapse: collapse; background: white; }
    .items thead th {
      background: linear-gradient(180deg, #fce4ec 0%, #fff5f8 100%);
      color: #ad1457; text-align: left; padding: 16px 18px;
      font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase;
      font-weight: 800; border-bottom: 1px solid #f8bbd0;
    }
    .items tbody td {
      padding: 16px 18px; border-top: 1px solid #fce4ec;
      vertical-align: top; font-size: 13px; color: var(--ink);
    }
    .items tbody tr:nth-child(even) td { background: #fffafc; }
    .item-name { font-weight: 700; line-height: 1.4; }
    .item-sku { color: #ad1457; font-size: 11px; margin-top: 5px; opacity: 0.75; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .center { text-align: center; }
    .totals-area { display: grid; grid-template-columns: 1fr minmax(300px, 380px); gap: 20px; align-items: start; margin-bottom: 26px; }
    .summary-pills { display: flex; flex-wrap: wrap; gap: 10px; }
    .summary-pill {
      border: 1px solid #f8bbd0; padding: 10px 16px; border-radius: 999px;
      background: #fff5f8; font-weight: 600; color: #ad1457; font-size: 12px;
      display: inline-flex; align-items: center; gap: 8px;
    }
    .summary-pill::before { content: '❀'; font-size: 12px; color: var(--accent); }
    .notes-box {
      margin-top: 16px; border-radius: 20px; border: 1px dashed #f8bbd0;
      background: #fff5f8; padding: 16px 18px; color: #6d1439;
      font-size: 12.5px; line-height: 1.7;
    }
    .notes-box strong { color: #880e4f; }
    .empty-note {
      margin-top: 16px; padding: 16px 18px; background: #fce4ec;
      border-radius: 20px; color: #ad1457; font-weight: 700; font-size: 12.5px;
    }
    .totals {
      border: 1px solid #f8bbd0; border-radius: 24px; overflow: hidden;
      background: #ffffff; box-shadow: 0 4px 20px -8px rgba(216,27,96,0.12);
    }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td { padding: 16px 20px; border-top: 1px solid #fce4ec; font-size: 13px; }
    .totals tr:first-child td { border-top: none; }
    .totals td:first-child { color: #ad1457; }
    .totals td:last-child { text-align: right; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
    .totals .grand td {
      background: linear-gradient(135deg, #d81b60 0%, #880e4f 130%);
      color: #ffffff; font-size: 18px; font-weight: 800; padding: 22px 20px;
      font-family: Georgia, serif; letter-spacing: 0.01em;
    }
    .totals .grand td:first-child { color: rgba(255,255,255,0.9); font-weight: 700; }
    .totals .grand td:last-child { color: #ffffff; }
    .footer {
      display: grid; grid-template-columns: 150px 1fr; gap: 22px;
      border-top: 1px solid #f8bbd0; padding: 28px 36px 34px;
      align-items: start; background: linear-gradient(180deg, #ffffff 0%, #fff5f8 100%);
    }
    .qr-box {
      border: 1px solid #f8bbd0; border-radius: 20px; background: #ffffff;
      padding: 12px; text-align: center;
    }
    .qr-box img { width: 100%; max-width: 120px; display: block; margin: 0 auto 8px; }
    .qr-box .qr-label {
      font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
      color: #ad1457; font-weight: 700;
    }
    .legal { color: #6d1439; line-height: 1.8; font-size: 12.5px; }
    .legal strong { color: #880e4f; }
    .legal .legal-title {
      display: inline-block; color: var(--accent); font-weight: 800;
      letter-spacing: 0.16em; text-transform: uppercase; font-size: 10.5px;
      margin-bottom: 6px; font-family: Georgia, serif;
    }
    .legal .qr-chain {
      display: block; margin-top: 10px; padding: 10px 12px;
      background: #fff5f8; border: 1px dashed #f8bbd0; border-radius: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px; color: #ad1457; word-break: break-all;
    }
    @media (max-width: 840px) {
      body { padding: 14px 10px; }
      .hero, .grid, .totals-area, .footer { grid-template-columns: 1fr; }
      .content, .hero, .footer { padding-left: 20px; padding-right: 20px; }
      .doc-number { font-size: 22px; }
      .brand-title { font-size: 26px; }
      .items-wrap { overflow-x: auto; }
      .items { min-width: 700px; }
    }
  `;
}

/* ============================================================
   NUEVA PLANTILLA: IMPERIAL (rojo y dorado, sello chino)
   ============================================================ */
function buildImperialCss(theme) {
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
      --gold: #c9a227;
      --gold-soft: #f5e6b8;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      padding: 32px 16px;
      background: #fffaf3;
      background-image:
        radial-gradient(circle at 10% 10%, rgba(183,28,28,0.04) 0%, transparent 40%),
        radial-gradient(circle at 90% 90%, rgba(201,162,39,0.05) 0%, transparent 40%);
      color: var(--ink);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-feature-settings: 'tnum' 1, 'lnum' 1;
      -webkit-font-smoothing: antialiased;
    }
    .voucher {
      max-width: 860px; margin: 0 auto; background: #ffffff;
      border-radius: 12px; overflow: hidden;
      box-shadow: 0 30px 70px -20px rgba(183,28,28,0.25), 0 8px 24px -10px rgba(183,28,28,0.12);
      border: 2px solid var(--gold); position: relative;
    }
    .voucher::before {
      content: ''; position: absolute; inset: 6px;
      border: 1px solid var(--gold); border-radius: 8px;
      pointer-events: none; z-index: 5;
    }
    .hero {
      position: relative;
      background: linear-gradient(135deg, #b71c1c 0%, #7f0000 60%, #4a0000 100%);
      color: #fff8e1;
      padding: 40px 40px 36px;
      display: grid; grid-template-columns: 1.35fr 0.85fr; gap: 22px;
      align-items: start; overflow: hidden;
    }
    .hero::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
      background: linear-gradient(90deg, transparent, var(--gold), transparent);
    }
    .hero::after {
      content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 4px;
      background: linear-gradient(90deg, transparent, var(--gold), transparent);
    }
    .brand-logo {
      max-width: 84px; max-height: 84px; border-radius: 8px;
      background: #ffffff; padding: 8px; margin-bottom: 16px;
      object-fit: contain; box-shadow: 0 10px 30px -8px rgba(0,0,0,0.5);
      border: 2px solid var(--gold); display: block;
    }
    .brand-eyebrow {
      font-size: 10px; font-weight: 700; letter-spacing: 0.36em;
      text-transform: uppercase; color: #f5e6b8; opacity: 0.95; margin-bottom: 12px;
      font-family: Georgia, serif;
    }
    .brand-title {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 32px; font-weight: 700; line-height: 1.15;
      margin-bottom: 16px; color: #ffffff;
      letter-spacing: 0.01em;
      text-shadow: 0 2px 10px rgba(0,0,0,0.35);
    }
    .brand-meta { display: grid; gap: 6px; font-size: 13px; color: #fff8e1; line-height: 1.55; }
    .brand-meta .row { display: flex; gap: 8px; align-items: baseline; }
    .brand-meta .row .k {
      font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
      color: #f5e6b8; min-width: 78px; font-weight: 700;
    }
    .doc-card {
      background: rgba(255,248,225,0.10);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      border: 1.5px solid var(--gold);
      border-radius: 10px; padding: 24px 22px;
      box-shadow: 0 12px 30px -12px rgba(0,0,0,0.5);
      position: relative; z-index: 1;
    }
    .doc-card::after {
      content: '印'; position: absolute; top: -14px; right: -14px;
      width: 48px; height: 48px; border-radius: 50%;
      background: #b71c1c; color: #f5e6b8;
      display: flex; align-items: center; justify-content: center;
      font-family: Georgia, serif; font-size: 24px; font-weight: 700;
      border: 2px solid var(--gold);
      box-shadow: 0 4px 14px rgba(0,0,0,0.4);
      transform: rotate(-12deg);
    }
    .doc-type {
      font-size: 10px; font-weight: 800; letter-spacing: 0.26em;
      text-transform: uppercase; color: #f5e6b8; margin-bottom: 12px;
      font-family: Georgia, serif;
    }
    .doc-number {
      font-family: Georgia, serif; font-size: 26px; font-weight: 700;
      line-height: 1.1; margin-bottom: 14px; color: #ffffff;
      font-variant-numeric: tabular-nums;
    }
    .doc-meta { display: grid; gap: 6px; font-size: 12px; color: #fff8e1; }
    .doc-meta .row { display: flex; justify-content: space-between; gap: 10px; }
    .doc-meta .row .k { color: #f5e6b8; }
    .doc-meta .row .v { font-weight: 700; color: #ffffff; }
    .content { padding: 34px 40px 8px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 26px; }
    .box {
      border: 1px solid var(--gold); border-radius: 10px;
      background: linear-gradient(180deg, #fffaf3 0%, #fff5e0 100%);
      padding: 22px 24px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 2px 12px rgba(201,162,39,0.08);
      position: relative;
    }
    .box::before {
      content: ''; position: absolute; top: 6px; left: 6px; right: 6px; bottom: 6px;
      border: 1px dashed rgba(201,162,39,0.35); border-radius: 6px;
      pointer-events: none;
    }
    .section-title {
      display: inline-flex; align-items: center; gap: 8px;
      color: var(--accent); font-weight: 800; margin-bottom: 14px;
      text-transform: uppercase; letter-spacing: 0.18em; font-size: 11px;
      font-family: Georgia, serif;
    }
    .section-title::before {
      content: '◈'; font-size: 12px; color: var(--gold);
    }
    .info-list { display: grid; gap: 10px; }
    .info-list .info-row { display: grid; grid-template-columns: 100px 1fr; gap: 10px; font-size: 13px; align-items: baseline; }
    .info-list .info-row .k {
      color: #7f0000; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.08em; font-size: 10px; font-family: Georgia, serif;
    }
    .info-list .info-row .v { color: var(--ink); font-weight: 600; word-break: break-word; }
    .items-wrap {
      border: 1.5px solid var(--gold); border-radius: 10px; overflow: hidden;
      margin-bottom: 26px; background: #ffffff;
      box-shadow: 0 4px 20px -8px rgba(201,162,39,0.15);
    }
    .items { width: 100%; border-collapse: collapse; background: white; }
    .items thead th {
      background: linear-gradient(180deg, #b71c1c 0%, #7f0000 100%);
      color: #f5e6b8; text-align: left; padding: 16px 18px;
      font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase;
      font-weight: 800; border-bottom: 2px solid var(--gold);
      font-family: Georgia, serif;
    }
    .items tbody td {
      padding: 16px 18px; border-top: 1px solid #f5e6b8;
      vertical-align: top; font-size: 13px; color: var(--ink);
    }
    .items tbody tr:nth-child(even) td { background: #fffaf3; }
    .item-name { font-weight: 700; line-height: 1.4; }
    .item-sku { color: #b71c1c; font-size: 11px; margin-top: 5px; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .center { text-align: center; }
    .totals-area { display: grid; grid-template-columns: 1fr minmax(300px, 380px); gap: 20px; align-items: start; margin-bottom: 26px; }
    .summary-pills { display: flex; flex-wrap: wrap; gap: 10px; }
    .summary-pill {
      border: 1px solid var(--gold); padding: 10px 16px; border-radius: 999px;
      background: #fffaf3; font-weight: 600; color: #7f0000; font-size: 12px;
      display: inline-flex; align-items: center; gap: 8px;
    }
    .summary-pill::before { content: '✦'; font-size: 11px; color: var(--gold); }
    .notes-box {
      margin-top: 16px; border-radius: 10px; border: 1px dashed var(--gold);
      background: #fffaf3; padding: 16px 18px; color: #5c4a00;
      font-size: 12.5px; line-height: 1.7;
    }
    .notes-box strong { color: #7f0000; font-family: Georgia, serif; }
    .empty-note {
      margin-top: 16px; padding: 16px 18px; background: #ffebee;
      border-radius: 10px; color: #b71c1c; font-weight: 700; font-size: 12.5px;
      border: 1px dashed rgba(183,28,28,0.3);
    }
    .totals {
      border: 1.5px solid var(--gold); border-radius: 10px; overflow: hidden;
      background: #ffffff; box-shadow: 0 4px 20px -8px rgba(201,162,39,0.2);
    }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td { padding: 16px 20px; border-top: 1px solid #f5e6b8; font-size: 13px; }
    .totals tr:first-child td { border-top: none; }
    .totals td:first-child { color: #7f0000; font-weight: 600; }
    .totals td:last-child { text-align: right; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
    .totals .grand td {
      background: linear-gradient(135deg, #b71c1c 0%, #4a0000 130%);
      color: #f5e6b8; font-size: 18px; font-weight: 800; padding: 22px 20px;
      font-family: Georgia, serif;
      border-top: 2px solid var(--gold);
    }
    .totals .grand td:first-child { color: #f5e6b8; font-weight: 700; }
    .totals .grand td:last-child { color: #ffffff; }
    .footer {
      display: grid; grid-template-columns: 150px 1fr; gap: 22px;
      border-top: 1.5px solid var(--gold); padding: 28px 40px 36px;
      align-items: start; background: linear-gradient(180deg, #ffffff 0%, #fffaf3 100%);
    }
    .qr-box {
      border: 1px solid var(--gold); border-radius: 10px; background: #ffffff;
      padding: 12px; text-align: center;
    }
    .qr-box img { width: 100%; max-width: 120px; display: block; margin: 0 auto 8px; }
    .qr-box .qr-label {
      font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
      color: #7f0000; font-weight: 700; font-family: Georgia, serif;
    }
    .legal { color: #5c4a00; line-height: 1.8; font-size: 12.5px; }
    .legal strong { color: #7f0000; }
    .legal .legal-title {
      display: inline-block; color: #b71c1c; font-weight: 800;
      letter-spacing: 0.18em; text-transform: uppercase; font-size: 10.5px;
      margin-bottom: 6px; font-family: Georgia, serif;
    }
    .legal .qr-chain {
      display: block; margin-top: 10px; padding: 10px 12px;
      background: #fffaf3; border: 1px dashed var(--gold); border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px; color: #7f0000; word-break: break-all;
    }
    @media (max-width: 840px) {
      body { padding: 14px 10px; }
      .hero, .grid, .totals-area, .footer { grid-template-columns: 1fr; }
      .content, .hero, .footer { padding-left: 20px; padding-right: 20px; }
      .doc-number { font-size: 22px; }
      .brand-title { font-size: 26px; }
      .items-wrap { overflow-x: auto; }
      .items { min-width: 700px; }
      .voucher::before { inset: 4px; }
    }
  `;
}

/* ============================================================
   NUEVA PLANTILLA: JADE ZEN (minimalismo asiático)
   ============================================================ */
function buildJadeCss(theme) {
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
    html, body { margin: 0; padding: 0; }
    body {
      padding: 40px 16px;
      background: #f5fbfa;
      color: var(--ink);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-feature-settings: 'tnum' 1, 'lnum' 1;
      -webkit-font-smoothing: antialiased;
    }
    .voucher {
      max-width: 860px; margin: 0 auto; background: #ffffff;
      border-radius: 0; overflow: hidden;
      border-left: 6px solid var(--accent);
      box-shadow: 0 30px 70px -25px rgba(0,137,123,0.25);
    }
    .hero {
      position: relative;
      background: #ffffff; color: var(--ink);
      padding: 44px 44px 32px;
      display: grid; grid-template-columns: 1.45fr 0.85fr; gap: 32px;
      align-items: start; border-bottom: 1px solid var(--line);
    }
    .hero::after {
      content: ''; position: absolute; bottom: -1px; left: 44px;
      width: 80px; height: 3px; background: var(--accent);
    }
    .brand-logo {
      max-width: 76px; max-height: 76px; border-radius: 0;
      background: transparent; padding: 0; margin-bottom: 20px;
      object-fit: contain; display: block;
    }
    .brand-eyebrow {
      font-size: 10px; font-weight: 600; letter-spacing: 0.4em;
      text-transform: uppercase; color: var(--accent); margin-bottom: 14px;
    }
    .brand-title {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 38px; font-weight: 400; line-height: 1.05;
      margin-bottom: 20px; color: var(--ink); letter-spacing: -0.01em;
    }
    .brand-meta { display: grid; gap: 8px; font-size: 13px; color: var(--muted); line-height: 1.6; }
    .brand-meta .row { display: flex; gap: 10px; align-items: baseline; }
    .brand-meta .row .k {
      font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
      color: var(--accent); min-width: 80px; font-weight: 700;
    }
    .doc-card {
      background: transparent;
      border-top: 2px solid var(--accent); border-bottom: 1px solid var(--line);
      padding: 18px 0; position: relative; z-index: 1;
    }
    .doc-type {
      font-size: 10px; font-weight: 700; letter-spacing: 0.3em;
      text-transform: uppercase; color: var(--accent); margin-bottom: 10px;
    }
    .doc-number {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 32px; font-weight: 600; line-height: 1.1;
      margin-bottom: 16px; color: var(--ink); letter-spacing: 0.02em;
      font-variant-numeric: tabular-nums;
    }
    .doc-meta { display: grid; gap: 8px; font-size: 12px; color: var(--muted); }
    .doc-meta .row { display: flex; justify-content: space-between; gap: 10px; }
    .doc-meta .row .k { letter-spacing: 0.1em; text-transform: uppercase; font-size: 10px; }
    .doc-meta .row .v { font-weight: 600; color: var(--ink); }
    .content { padding: 36px 44px 8px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; margin-bottom: 32px; }
    .box {
      border: none; border-top: 1px solid var(--line);
      background: transparent; padding: 20px 0 0;
      border-radius: 0;
    }
    .section-title {
      display: inline-flex; align-items: center; gap: 10px;
      color: var(--accent); font-weight: 700; margin-bottom: 18px;
      text-transform: uppercase; letter-spacing: 0.26em; font-size: 10px;
    }
    .section-title::before {
      content: ''; width: 24px; height: 1px; background: var(--accent);
    }
    .info-list { display: grid; gap: 14px; }
    .info-list .info-row { display: grid; grid-template-columns: 110px 1fr; gap: 14px; font-size: 13px; align-items: baseline; }
    .info-list .info-row .k {
      color: var(--muted); font-weight: 500; text-transform: uppercase;
      letter-spacing: 0.14em; font-size: 10px;
    }
    .info-list .info-row .v { color: var(--ink); font-weight: 500; word-break: break-word; }
    .items-wrap {
      border: none; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
      border-radius: 0; overflow: hidden; margin-bottom: 32px; background: transparent;
    }
    .items { width: 100%; border-collapse: collapse; background: transparent; }
    .items thead th {
      background: transparent; color: var(--accent);
      text-align: left; padding: 18px 12px; font-size: 10px;
      letter-spacing: 0.24em; text-transform: uppercase; font-weight: 700;
      border-bottom: 1px solid var(--line);
    }
    .items thead th:first-child { padding-left: 0; }
    .items thead th:last-child { padding-right: 0; text-align: right; }
    .items tbody td {
      padding: 20px 12px; border-top: 1px solid #f0f9f8;
      vertical-align: top; font-size: 13px; color: var(--ink);
    }
    .items tbody td:first-child { padding-left: 0; }
    .items tbody td:last-child { padding-right: 0; }
    .item-name { font-weight: 500; line-height: 1.5; }
    .item-sku { color: var(--muted); font-size: 11px; margin-top: 5px; letter-spacing: 0.05em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .center { text-align: center; }
    .totals-area { display: grid; grid-template-columns: 1fr minmax(280px, 360px); gap: 32px; align-items: start; margin-bottom: 32px; }
    .summary-pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .summary-pill {
      border: 1px solid var(--line); padding: 8px 14px; border-radius: 0;
      background: transparent; font-weight: 500; color: var(--muted); font-size: 11px;
      display: inline-flex; align-items: center; gap: 8px;
      letter-spacing: 0.08em; text-transform: uppercase;
    }
    .summary-pill::before { content: ''; width: 4px; height: 4px; border-radius: 50%; background: var(--accent); }
    .notes-box {
      margin-top: 20px; border-radius: 0; border: none;
      border-left: 2px solid var(--accent); background: transparent;
      padding: 4px 0 4px 16px; color: var(--muted);
      font-size: 12.5px; line-height: 1.8; font-style: italic;
    }
    .notes-box strong { color: var(--ink); font-style: normal; }
    .empty-note {
      margin-top: 20px; padding: 4px 0 4px 16px; background: transparent;
      border-left: 2px solid var(--accent); color: var(--accent);
      font-weight: 500; font-size: 12.5px; font-style: italic;
    }
    .totals { border: none; border-top: 2px solid var(--accent); border-radius: 0; overflow: hidden; background: transparent; }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td { padding: 14px 0; border-top: 1px solid var(--line); font-size: 13px; }
    .totals tr:first-child td { border-top: none; }
    .totals td:first-child { color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; font-size: 11px; }
    .totals td:last-child { text-align: right; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
    .totals .grand td {
      background: transparent; color: var(--ink);
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 26px; font-weight: 600; padding: 20px 0 8px;
      border-top: 2px solid var(--accent); letter-spacing: 0.01em;
    }
    .totals .grand td:first-child { color: var(--accent); font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.24em; font-weight: 700; }
    .totals .grand td:last-child { color: var(--ink); }
    .footer {
      display: grid; grid-template-columns: 140px 1fr; gap: 32px;
      border-top: 1px solid var(--line); padding: 32px 44px 40px;
      align-items: start; background: #fafdfd;
    }
    .qr-box {
      border: 1px solid var(--line); border-radius: 0; background: #ffffff;
      padding: 14px; text-align: center;
    }
    .qr-box img { width: 100%; max-width: 110px; display: block; margin: 0 auto 10px; }
    .qr-box .qr-label {
      font-size: 9.5px; letter-spacing: 0.22em; text-transform: uppercase;
      color: var(--accent); font-weight: 700;
    }
    .legal { color: var(--muted); line-height: 1.9; font-size: 12.5px; }
    .legal strong { color: var(--ink); }
    .legal .legal-title {
      display: inline-block; color: var(--accent); font-weight: 700;
      letter-spacing: 0.24em; text-transform: uppercase; font-size: 10px;
      margin-bottom: 8px;
    }
    .legal .qr-chain {
      display: block; margin-top: 12px; padding: 12px 14px;
      background: #ffffff; border: 1px solid var(--line); border-radius: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px; color: var(--muted); word-break: break-all;
    }
    @media (max-width: 840px) {
      body { padding: 20px 10px; }
      .hero, .grid, .totals-area, .footer { grid-template-columns: 1fr; gap: 24px; }
      .content, .hero, .footer { padding-left: 22px; padding-right: 22px; }
      .doc-number { font-size: 26px; }
      .brand-title { font-size: 30px; }
      .items-wrap { overflow-x: auto; }
      .items { min-width: 640px; }
      .hero::after { left: 22px; }
    }
  `;
}

/* ============================================================
   NUEVA PLANTILLA: DRAGÓN DORADO (navy + dorado, moderna)
   ============================================================ */
function buildDragonCss(theme) {
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
      --gold: #d4af37;
      --gold-soft: rgba(212,175,55,0.15);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      padding: 32px 16px;
      background: #0a1628;
      background-image:
        radial-gradient(circle at 20% 10%, rgba(30,58,138,0.4) 0%, transparent 50%),
        radial-gradient(circle at 80% 90%, rgba(212,175,55,0.08) 0%, transparent 50%);
      color: var(--ink);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-feature-settings: 'tnum' 1, 'lnum' 1;
      -webkit-font-smoothing: antialiased;
    }
    .voucher {
      max-width: 860px; margin: 0 auto; background: #ffffff;
      border-radius: 26px; overflow: hidden;
      box-shadow: 0 30px 80px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(212,175,55,0.25);
    }
    .hero {
      position: relative;
      background: linear-gradient(135deg, #1e3a8a 0%, #0f1f4a 50%, #0a1628 100%);
      color: #ffffff;
      padding: 42px 40px 38px;
      display: grid; grid-template-columns: 1.35fr 0.85fr; gap: 24px;
      align-items: start; overflow: hidden;
    }
    .hero::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, transparent, var(--gold), transparent);
    }
    .hero::after {
      content: ''; position: absolute; inset: 0;
      background-image:
        radial-gradient(circle at 12% 20%, rgba(212,175,55,0.15) 0%, transparent 3%),
        radial-gradient(circle at 88% 30%, rgba(212,175,55,0.18) 0%, transparent 2%),
        radial-gradient(circle at 30% 80%, rgba(212,175,55,0.15) 0%, transparent 2.5%),
        radial-gradient(circle at 70% 75%, rgba(212,175,55,0.12) 0%, transparent 2%),
        radial-gradient(circle at 50% 40%, rgba(212,175,55,0.10) 0%, transparent 2%),
        radial-gradient(circle at 20% 55%, rgba(212,175,55,0.13) 0%, transparent 2.5%);
      pointer-events: none;
    }
    .brand-logo {
      max-width: 84px; max-height: 84px; border-radius: 18px;
      background: #ffffff; padding: 8px; margin-bottom: 18px;
      object-fit: contain; box-shadow: 0 10px 30px -8px rgba(0,0,0,0.6);
      border: 1.5px solid var(--gold); display: block;
      position: relative; z-index: 1;
    }
    .brand-eyebrow {
      font-size: 10px; font-weight: 800; letter-spacing: 0.32em;
      text-transform: uppercase; color: var(--gold); margin-bottom: 12px;
      position: relative; z-index: 1;
    }
    .brand-title {
      font-size: 32px; font-weight: 800; line-height: 1.08;
      margin-bottom: 18px; letter-spacing: -0.02em; color: #ffffff;
      position: relative; z-index: 1;
      text-shadow: 0 2px 20px rgba(0,0,0,0.4);
    }
    .brand-meta {
      display: grid; gap: 6px; font-size: 13px; color: rgba(255,255,255,0.9);
      line-height: 1.55; position: relative; z-index: 1;
    }
    .brand-meta .row { display: flex; gap: 8px; align-items: baseline; }
    .brand-meta .row .k {
      font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
      color: var(--gold); min-width: 78px; font-weight: 700;
    }
    .doc-card {
      background: rgba(255,255,255,0.08);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(212,175,55,0.4);
      border-radius: 20px; padding: 24px 22px;
      box-shadow: 0 12px 30px -12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(212,175,55,0.2);
      position: relative; z-index: 1;
    }
    .doc-type {
      font-size: 10px; font-weight: 800; letter-spacing: 0.26em;
      text-transform: uppercase; color: var(--gold); margin-bottom: 12px;
    }
    .doc-number {
      font-size: 26px; font-weight: 800; line-height: 1.1;
      margin-bottom: 16px; color: #ffffff; letter-spacing: -0.01em;
      font-variant-numeric: tabular-nums;
    }
    .doc-meta { display: grid; gap: 7px; font-size: 12px; color: rgba(255,255,255,0.85); }
    .doc-meta .row { display: flex; justify-content: space-between; gap: 10px; }
    .doc-meta .row .k { color: var(--gold); letter-spacing: 0.1em; }
    .doc-meta .row .v { font-weight: 700; color: #ffffff; }
    .content { padding: 34px 40px 8px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-bottom: 26px; }
    .box {
      border: 1px solid var(--line); border-radius: 18px;
      background: linear-gradient(180deg, #ffffff 0%, var(--panel) 100%);
      padding: 22px 24px; position: relative;
      box-shadow: 0 4px 16px -8px rgba(30,58,138,0.1);
    }
    .box::before {
      content: ''; position: absolute; top: 0; left: 24px; right: 24px; height: 2px;
      background: linear-gradient(90deg, var(--gold), transparent 60%);
      border-radius: 2px;
    }
    .section-title {
      display: inline-flex; align-items: center; gap: 10px;
      color: var(--accent); font-weight: 800; margin-bottom: 16px;
      text-transform: uppercase; letter-spacing: 0.18em; font-size: 11px;
    }
    .section-title::before {
      content: ''; width: 20px; height: 2px; background: var(--gold); border-radius: 2px;
    }
    .info-list { display: grid; gap: 10px; }
    .info-list .info-row { display: grid; grid-template-columns: 100px 1fr; gap: 10px; font-size: 13px; align-items: baseline; }
    .info-list .info-row .k {
      color: var(--muted); font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.1em; font-size: 10px;
    }
    .info-list .info-row .v { color: var(--ink); font-weight: 600; word-break: break-word; }
    .items-wrap {
      border: 1px solid var(--line); border-radius: 18px; overflow: hidden;
      margin-bottom: 26px; background: #ffffff;
      box-shadow: 0 4px 16px -8px rgba(30,58,138,0.1);
    }
    .items { width: 100%; border-collapse: collapse; background: white; }
    .items thead th {
      background: linear-gradient(135deg, #1e3a8a 0%, #0f1f4a 100%);
      color: #ffffff; text-align: left; padding: 16px 18px;
      font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase;
      font-weight: 800; border-bottom: 2px solid var(--gold);
    }
    .items tbody td {
      padding: 16px 18px; border-top: 1px solid var(--line);
      vertical-align: top; font-size: 13px; color: var(--ink);
    }
    .items tbody tr:nth-child(even) td { background: var(--panel); }
    .item-name { font-weight: 700; line-height: 1.4; }
    .item-sku { color: var(--accent); font-size: 11px; margin-top: 5px; letter-spacing: 0.02em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .center { text-align: center; }
    .totals-area { display: grid; grid-template-columns: 1fr minmax(300px, 380px); gap: 20px; align-items: start; margin-bottom: 26px; }
    .summary-pills { display: flex; flex-wrap: wrap; gap: 10px; }
    .summary-pill {
      border: 1px solid var(--line); padding: 10px 16px; border-radius: 999px;
      background: #ffffff; font-weight: 600; color: var(--muted); font-size: 12px;
      display: inline-flex; align-items: center; gap: 8px;
    }
    .summary-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--gold); }
    .notes-box {
      margin-top: 16px; border-radius: 16px; border: 1px dashed var(--line);
      background: var(--panel); padding: 16px 18px; color: var(--muted);
      font-size: 12.5px; line-height: 1.7;
    }
    .notes-box strong { color: var(--ink); }
    .empty-note {
      margin-top: 16px; padding: 16px 18px; background: var(--accent-soft);
      border-radius: 16px; color: var(--accent); font-weight: 700; font-size: 12.5px;
    }
    .totals {
      border: 1px solid var(--line); border-radius: 18px; overflow: hidden;
      background: #ffffff; box-shadow: 0 4px 16px -8px rgba(30,58,138,0.15);
    }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td { padding: 16px 20px; border-top: 1px solid var(--line); font-size: 13px; }
    .totals tr:first-child td { border-top: none; }
    .totals td:first-child { color: var(--muted); }
    .totals td:last-child { text-align: right; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
    .totals .grand td {
      background: linear-gradient(135deg, #1e3a8a 0%, #0a1628 130%);
      color: #ffffff; font-size: 18px; font-weight: 800; padding: 22px 20px;
      border-top: 2px solid var(--gold);
    }
    .totals .grand td:first-child { color: var(--gold); font-weight: 800; letter-spacing: 0.1em; }
    .totals .grand td:last-child { color: #ffffff; }
    .footer {
      display: grid; grid-template-columns: 150px 1fr; gap: 22px;
      border-top: 2px solid var(--gold); padding: 28px 40px 36px;
      align-items: start; background: linear-gradient(180deg, #ffffff 0%, var(--panel) 100%);
    }
    .qr-box {
      border: 1px solid var(--line); border-radius: 16px; background: #ffffff;
      padding: 12px; text-align: center;
    }
    .qr-box img { width: 100%; max-width: 120px; display: block; margin: 0 auto 8px; }
    .qr-box .qr-label {
      font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--accent); font-weight: 800;
    }
    .legal { color: var(--muted); line-height: 1.8; font-size: 12.5px; }
    .legal strong { color: var(--ink); }
    .legal .legal-title {
      display: inline-block; color: var(--accent); font-weight: 800;
      letter-spacing: 0.18em; text-transform: uppercase; font-size: 10.5px;
      margin-bottom: 6px;
    }
    .legal .qr-chain {
      display: block; margin-top: 10px; padding: 10px 12px;
      background: var(--panel); border: 1px dashed var(--line); border-radius: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px; color: var(--accent); word-break: break-all;
    }
    @media (max-width: 840px) {
      body { padding: 14px 10px; }
      .hero, .grid, .totals-area, .footer { grid-template-columns: 1fr; }
      .content, .hero, .footer { padding-left: 20px; padding-right: 20px; }
      .doc-number { font-size: 22px; }
      .brand-title { font-size: 26px; }
      .items-wrap { overflow-x: auto; }
      .items { min-width: 700px; }
    }
  `;
}

/* ============================================================
   DISPATCHER DE CSS SEGÚN LAYOUT
   ============================================================ */
const CSS_BUILDERS = {
  modern: buildTemplateCss,
  sakura: buildSakuraCss,
  imperial: buildImperialCss,
  jade: buildJadeCss,
  dragon: buildDragonCss
};

function getTemplateCss(template) {
  const builder = CSS_BUILDERS[template.layout] || CSS_BUILDERS.modern;
  return builder(template.theme);
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
    <style>${getTemplateCss(template)}</style>
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
   PDF — REDISEÑO PROFESIONAL + DECORACIONES POR LAYOUT
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

/**
 * Aplica decoraciones sutiles al hero del PDF según el layout de la plantilla.
 * - modern: círculos translúcidos (comportamiento original)
 * - sakura: pétalos rosados en las esquinas
 * - imperial: doble borde dorado interior + sello
 * - jade: barra vertical jade a la izquierda
 * - dragon: patrón de puntos dorados
 */
function applyLayoutDecorations(doc, layout, theme, heroTop, heroHeight) {
  if (layout === 'sakura') {
    // Pétalos de sakura en las esquinas
    doc.save();
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
    // Pétalo superior derecho
    for (let i = 0; i < 6; i++) {
      const cx = 500 + Math.cos((i / 6) * Math.PI * 2) * 18;
      const cy = heroTop + 26 + Math.sin((i / 6) * Math.PI * 2) * 18;
      doc.circle(cx, cy, 12).fillOpacity(0.14).fill('#d81b60').fillOpacity(1);
    }
    // Pétalo inferior izquierdo
    for (let i = 0; i < 6; i++) {
      const cx = 90 + Math.cos((i / 6) * Math.PI * 2) * 16;
      const cy = heroTop + heroHeight - 26 + Math.sin((i / 6) * Math.PI * 2) * 16;
      doc.circle(cx, cy, 10).fillOpacity(0.12).fill('#d81b60').fillOpacity(1);
    }
    // Círculo grande translúcido
    doc.circle(520, heroTop + heroHeight - 20, 70).fillOpacity(0.06).fill('#ffffff').fillOpacity(1);
    doc.restore();
  } else if (layout === 'imperial') {
    // Doble borde dorado interior
    doc.save();
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
    doc.rect(48, heroTop + 8, 499, heroHeight - 16).lineWidth(1).strokeColor('#c9a227').strokeOpacity(0.55).stroke().strokeOpacity(1);
    doc.rect(54, heroTop + 14, 487, heroHeight - 28).lineWidth(0.5).strokeColor('#c9a227').strokeOpacity(0.35).stroke().strokeOpacity(1);
    doc.restore();
    // Sello circular decorativo
    doc.circle(535, heroTop + heroHeight - 40, 26).fillOpacity(0.9).fill('#b71c1c').fillOpacity(1);
    doc.circle(535, heroTop + heroHeight - 40, 22).lineWidth(1).strokeColor('#c9a227').stroke();
  } else if (layout === 'jade') {
    // Barra vertical minimalista en el lateral izquierdo (fuera del hero, dentro del voucher)
    doc.rect(40, heroTop, 4, heroHeight).fill(theme.accent);
  } else if (layout === 'dragon') {
    // Patrón de puntos dorados
    doc.save();
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
    for (let i = 0; i < 10; i++) {
      const px = 60 + i * 48;
      const py = heroTop + 20 + (i % 3) * 22;
      doc.circle(px, py, 1.8).fillOpacity(0.55).fill('#d4af37').fillOpacity(1);
      doc.circle(px + 20, py + 30, 1.5).fillOpacity(0.4).fill('#d4af37').fillOpacity(1);
    }
    doc.restore();
  } else {
    // Modern (comportamiento original)
    doc.save();
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
    doc.circle(535, heroTop + heroHeight + 30, 90).fillOpacity(0.08).fill('#ffffff').fillOpacity(1);
    doc.circle(500, heroTop - 20, 60).fillOpacity(0.06).fill('#ffffff').fillOpacity(1);
    doc.restore();
  }
}

async function buildPdfBuffer(data, plan = PLAN_GRATIS_ID) {
  const { template, issuer, customer, numbering, items, subtotal, tax, total, notes, paymentMethod, documentType, currency, taxRate, qrContent, issueDate } = data;
  const theme = template.theme;
  const layout = template.layout || 'modern';
  const qrDataUrl = await getQrDataUrl(qrContent);
  const title = documentType === 'factura' ? 'FACTURA ELECTRÓNICA' : 'BOLETA DE VENTA';
  const esGratuito = plan === PLAN_GRATIS_ID;

  // Ajustes por layout
  const isSakura = layout === 'sakura';
  const isImperial = layout === 'imperial';
  const isJade = layout === 'jade';
  const isDragon = layout === 'dragon';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.save();

    if (esGratuito) {
      doc.fontSize(60)
        .fillColor('#cccccc')
        .opacity(0.18)
        .text('FacilitoTools', 120, 400, { align: 'center', angle: -30, width: 400 })
        .opacity(1);
    }

    // ================================================================
    // HERO — ALTURA DINÁMICA
    // ================================================================
    const issuerMetaLines = [
      issuer.documentNumber ? `Documento: ${issuer.documentNumber}` : '',
      issuer.address ? `Dirección: ${issuer.address}` : '',
      issuer.phone ? `Teléfono: ${issuer.phone}` : '',
      issuer.email ? `Email: ${issuer.email}` : ''
    ].filter(Boolean);

    const heroTop = 40;
    const heroYPadding = 24;

    let issuerTextX = 60;
    let issuerTextWidth = 270;
    if (issuer.logoDataUrl) {
      issuerTextX = 128;
      issuerTextWidth = 200;
    }

    const eyebrowFontSize = 7;
    const eyebrowBlockHeight = 14;
    const brandTitleFontSize = 19;
    const brandTitleGap = 10;
    const metaFontSize = 8.5;
    const metaLineHeight = 12.5;

    doc.font('Helvetica-Bold').fontSize(brandTitleFontSize);
    const businessNameHeight = doc.heightOfString(issuer.businessName, { width: issuerTextWidth });

    const leftLogoBlockHeight = issuer.logoDataUrl ? 72 : 0;
    const leftContentHeight =
      leftLogoBlockHeight + eyebrowBlockHeight + businessNameHeight + brandTitleGap +
      issuerMetaLines.length * metaLineHeight;

    const docCardW = 195;
    const docCardX = 40 + 515 - docCardW - 20;
    const docCardInnerPaddingX = 16;
    const docCardInnerPaddingY = 16;
    const dmLabelW = 52;
    const dmValueW = docCardW - docCardInnerPaddingX * 2 - dmLabelW;
    const dmRowGap = 6;

    const dmRows = [
      ['Fecha', formatDateTime(issueDate)],
      ['Moneda', currency],
      ['Plantilla', template.name],
      ['Pago', paymentMethod || 'Pago único']
    ];

    doc.font('Helvetica-Bold').fontSize(7.5);
    const dmRowHeights = dmRows.map(([k, v]) =>
      Math.max(9, doc.heightOfString(v, { width: dmValueW, align: 'right' }))
    );
    const dmRowsTotalHeight = dmRowHeights.reduce((sum, h) => sum + h + dmRowGap, 0) - dmRowGap;

    const docCardHeaderHeight = 66;
    const docCardH = docCardHeaderHeight + dmRowsTotalHeight + docCardInnerPaddingY * 2;

    const maxContentHeight = Math.max(leftContentHeight, docCardH);
    const heroHeight = Math.max(maxContentHeight + heroYPadding * 2, 150);

    const leftContentStartY = heroTop + (heroHeight - leftContentHeight) / 2;
    const docCardY = heroTop + (heroHeight - docCardH) / 2;

    // --- Fondo del hero (varía según layout) ---
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).fill(theme.accent);

    if (isDragon) {
      // Bandas oscuras para look navy profundo
      doc.save();
      doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
      doc.rect(220, heroTop, 335, heroHeight).fillOpacity(0.32).fill('#000000').fillOpacity(1);
      doc.rect(360, heroTop, 195, heroHeight).fillOpacity(0.22).fill('#000000').fillOpacity(1);
      doc.restore();
    } else if (isImperial) {
      // Bandas rojo profundo
      doc.save();
      doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
      doc.rect(220, heroTop, 335, heroHeight).fillOpacity(0.30).fill('#000000').fillOpacity(1);
      doc.rect(360, heroTop, 195, heroHeight).fillOpacity(0.20).fill('#000000').fillOpacity(1);
      doc.restore();
    } else if (isJade) {
      // Fondo blanco con barra jade
      doc.roundedRect(40, heroTop, 515, heroHeight, 18).fill('#ffffff');
      doc.rect(40, heroTop, 4, heroHeight).fill(theme.accent);
    } else if (isSakura) {
      // Fondo rosa sólido suave con gradiente simulado
      doc.roundedRect(40, heroTop, 515, heroHeight, 18).fill(theme.accentSoft);
      doc.save();
      doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
      doc.rect(360, heroTop, 195, heroHeight).fillOpacity(0.35).fill(theme.accent).fillOpacity(1);
      doc.restore();
    } else {
      // Modern: gradiente simulado original
      doc.save();
      doc.roundedRect(40, heroTop, 515, heroHeight, 18).clip();
      doc.rect(220, heroTop, 335, heroHeight).fillOpacity(0.28).fill('#000000').fillOpacity(1);
      doc.rect(360, heroTop, 195, heroHeight).fillOpacity(0.22).fill('#000000').fillOpacity(1);
      doc.restore();
    }

    // Aplicar decoraciones por layout
    applyLayoutDecorations(doc, layout, theme, heroTop, heroHeight);

    // Determinar color del texto del hero según layout
    const heroTextColor = isJade ? theme.ink : (isSakura ? '#880e4f' : '#ffffff');
    const heroMutedColor = isJade ? theme.muted : (isSakura ? '#ad1457' : '#ffffff');

    // --- Lado izquierdo ---
    let leftY = leftContentStartY;

    if (issuer.logoDataUrl) {
      try {
        const logoBg = isJade ? '#ffffff' : '#ffffff';
        doc.roundedRect(issuerTextX - 5, leftY, 60, 60, 14).fillOpacity(isJade ? 1 : 0.18).fillAndStroke(logoBg, '#ffffff').fillOpacity(1);
        doc.image(issuer.logoDataUrl, issuerTextX, leftY + 5, { fit: [50, 50], align: 'center', valign: 'center' });
      } catch (logoError) { /* omitir */ }
      leftY += 72;
    }

    doc.fillColor(heroMutedColor).font('Helvetica-Bold').fontSize(eyebrowFontSize)
      .text('COMPROBANTE DE PAGO', issuerTextX, leftY, { width: issuerTextWidth, characterSpacing: 2 });
    leftY += eyebrowBlockHeight;

    doc.fillColor(heroTextColor).font('Helvetica-Bold').fontSize(brandTitleFontSize)
      .text(issuer.businessName, issuerTextX, leftY, { width: issuerTextWidth });
    leftY += businessNameHeight + brandTitleGap;

    doc.font('Helvetica').fontSize(metaFontSize);
    issuerMetaLines.forEach((line) => {
      doc.fillColor(heroTextColor).text(line, issuerTextX, leftY, { width: 240 });
      leftY += metaLineHeight;
    });

    // --- Doc-card ---
    if (isJade) {
      // Doc-card minimalista: sin fondo, solo línea superior jade
      doc.rect(docCardX, docCardY, docCardW, 2).fill(theme.accent);
      doc.rect(docCardX, docCardY + docCardH - 1, docCardW, 1).fill(theme.line);
    } else {
      doc.roundedRect(docCardX, docCardY, docCardW, docCardH, 16)
        .fillOpacity(isSakura ? 0.75 : 0.14)
        .fillAndStroke(isSakura ? '#ffffff' : '#ffffff', isSakura ? 'rgba(216,27,96,0.3)' : 'rgba(255,255,255,0.35)')
        .fillOpacity(1);
    }

    let dcY = docCardY + docCardInnerPaddingY;
    const docCardText = isJade ? theme.ink : (isSakura ? '#880e4f' : '#ffffff');
    const docCardMuted = isJade ? theme.muted : (isSakura ? '#ad1457' : '#ffffff');

    doc.fillColor(docCardMuted).font('Helvetica-Bold').fontSize(7)
      .text('TIPO DE DOCUMENTO', docCardX + docCardInnerPaddingX, dcY, { width: docCardW - docCardInnerPaddingX * 2, characterSpacing: 1.6 });
    dcY += 14;

    doc.fillColor(docCardText).font('Helvetica-Bold').fontSize(9)
      .text(title, docCardX + docCardInnerPaddingX, dcY, { width: docCardW - docCardInnerPaddingX * 2 });
    dcY += 16;

    doc.fillColor(docCardText).font('Helvetica-Bold').fontSize(15)
      .text(numbering.full, docCardX + docCardInnerPaddingX, dcY, { width: docCardW - docCardInnerPaddingX * 2 });
    dcY += 24;

    // Separador
    doc.moveTo(docCardX + docCardInnerPaddingX, dcY).lineTo(docCardX + docCardW - docCardInnerPaddingX, dcY)
      .strokeOpacity(isJade ? 0.5 : 0.25)
      .strokeColor(isJade ? theme.line : '#ffffff')
      .lineWidth(0.6).stroke().strokeOpacity(1);
    dcY += 12;

    dmRows.forEach(([k, v], idx) => {
      const rowH = dmRowHeights[idx];
      doc.fillColor(docCardMuted).font('Helvetica').fontSize(7.5)
        .text(k, docCardX + docCardInnerPaddingX, dcY, { width: dmLabelW });
      doc.fillColor(docCardText).font('Helvetica-Bold')
        .text(v, docCardX + docCardInnerPaddingX + dmLabelW, dcY, { width: dmValueW, align: 'right' });
      dcY += rowH + dmRowGap;
    });

    // ================================================================
    // TARJETAS INFO: Cliente / Detalle emisión
    // ================================================================
    const infoBoxTop = heroTop + heroHeight + 22;
    const infoBoxW = 250;
    const infoBoxH = 118;
    const infoBoxGap = 15;

    // Fondo de las cajas varía según layout
    const infoBoxFill = isSakura ? '#fff5f8' : (isImperial ? '#fffaf3' : theme.panel);
    const infoBoxLine = isSakura ? '#f8bbd0' : (isImperial ? '#e0b872' : theme.line);

    doc.roundedRect(40, infoBoxTop, infoBoxW, infoBoxH, 14).fillAndStroke(infoBoxFill, infoBoxLine);
    doc.roundedRect(40 + infoBoxW + infoBoxGap, infoBoxTop, infoBoxW, infoBoxH, 14).fillAndStroke(infoBoxFill, infoBoxLine);

    function drawSectionHeader(x, y, label) {
      doc.rect(x, y + 1, 3, 10).fill(theme.accent);
      doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8).text(label, x + 9, y, { characterSpacing: 1.2 });
    }

    drawSectionHeader(55, infoBoxTop + 14, 'DATOS DEL CLIENTE');
    drawSectionHeader(40 + infoBoxW + infoBoxGap + 15, infoBoxTop + 14, 'DETALLE DE EMISIÓN');

    const rowStartY = infoBoxTop + 36;
    const rowGap = 24;
    const labelColor = isSakura ? '#ad1457' : (isImperial ? '#7f0000' : '#0f172a');
    const valueColor = isSakura ? '#4a051f' : (isImperial ? '#1a1a1a' : '#334155');

    function drawLV(label, value, x, y, width) {
      doc.font('Helvetica-Bold').fillColor(labelColor).fontSize(9).text(label, x, y, { width });
      doc.font('Helvetica').fillColor(valueColor).text(value || '-', x, y + 14, { width });
    }

    drawLV('Nombre', customer.name, 55, rowStartY, infoBoxW - 30);
    drawLV(customer.documentType || 'Documento', customer.documentNumber || '-', 55, rowStartY + rowGap, infoBoxW - 30);
    drawLV('Email', customer.email || '-', 55, rowStartY + rowGap * 2, infoBoxW - 30);

    const emissionX = 40 + infoBoxW + infoBoxGap + 15;
    drawLV('Fecha', formatDateTime(issueDate), emissionX, rowStartY, infoBoxW - 30);
    drawLV('Plantilla', template.name, emissionX, rowStartY + rowGap, infoBoxW - 30);
    drawLV('Pago', paymentMethod || 'Pago único', emissionX, rowStartY + rowGap * 2, infoBoxW - 30);

    // ================================================================
    // TABLA DE ÍTEMS
    // ================================================================
    let y = infoBoxTop + infoBoxH + 26;

    const tableHeaderH = 30;
    // Cabecera de tabla según layout
    if (isImperial) {
      doc.roundedRect(40, y, 515, tableHeaderH, 4).fill(theme.accent);
      doc.fillColor('#f5e6b8').font('Helvetica-Bold').fontSize(8);
    } else if (isDragon) {
      doc.roundedRect(40, y, 515, tableHeaderH, 10).fill(theme.accent);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    } else if (isJade) {
      doc.rect(40, y, 515, tableHeaderH).fill('#ffffff');
      doc.rect(40, y, 515, tableHeaderH).lineWidth(1).strokeColor(theme.line).stroke();
      doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8);
    } else {
      doc.roundedRect(40, y, 515, tableHeaderH, 10).fill(theme.accentSoft);
      doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8);
    }

    const columns = { index: 50, desc: 78, unit: 320, qty: 380, unitPrice: 430, amount: 495 };

    drawText(doc, '#', columns.index, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'DESCRIPCIÓN', columns.desc, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'UND', columns.unit, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'CANT.', columns.qty, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'P. UNIT', columns.unitPrice, y + 11, { characterSpacing: 0.8 });
    drawText(doc, 'IMPORTE', columns.amount, y + 11, { characterSpacing: 0.8 });

    y += tableHeaderH;

    // Fondo alternado por layout
    const rowEvenFill = isSakura ? '#fffafc' : (isImperial ? '#fffaf3' : theme.panel);

    items.forEach((item, idx) => {
      const descHeight = doc.heightOfString(item.description, { width: 220, align: 'left' });
      const rowHeight = Math.max(30, descHeight + 14);
      y = ensureSpace(doc, y, rowHeight + 20);

      if (idx % 2 === 0) {
        doc.rect(40, y, 515, rowHeight).fillOpacity(isJade ? 0.35 : 0.55).fill(rowEvenFill).fillOpacity(1);
      }

      doc.moveTo(40, y + rowHeight).lineTo(555, y + rowHeight)
        .strokeOpacity(isJade ? 0.5 : 0.35)
        .strokeColor(theme.line).lineWidth(0.5).stroke().strokeOpacity(1);

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

    doc.moveTo(40, y).lineTo(555, y)
      .strokeOpacity(isJade ? 0.5 : 0.35)
      .strokeColor(theme.line).lineWidth(0.5).stroke().strokeOpacity(1);

    y += 22;
    y = ensureSpace(doc, y, 170);

    // ================================================================
    // OBSERVACIONES + TOTALES
    // ================================================================
    const bottomBlockH = 118;

    // Observaciones
    const notesFill = isSakura ? '#fff5f8' : (isImperial ? '#fffaf3' : theme.panel);
    const notesBorder = isSakura ? '#f8bbd0' : (isImperial ? '#e0b872' : theme.line);

    doc.roundedRect(40, y, 235, bottomBlockH, 14).fillAndStroke(notesFill, notesBorder);
    doc.rect(55, y + 13, 3, 10).fill(theme.accent);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8).text('OBSERVACIONES', 64, y + 12, { characterSpacing: 1.2 });
    doc.font('Helvetica').fillColor(theme.ink).fontSize(8.5).text(
      notes || 'Puedes usar este espacio para garantía, condiciones, método de entrega o agradecimiento al cliente.',
      55, y + 34, { width: 205, align: 'left', lineGap: 2 }
    );

    // Totales
    const totalsX = 300;
    const totalsW = 255;
    doc.roundedRect(totalsX, y, totalsW, bottomBlockH, 14).fillAndStroke('#ffffff', notesBorder);

    doc.fillColor(theme.muted).font('Helvetica').fontSize(9);
    doc.text('Subtotal', totalsX + 18, y + 20);
    doc.fillColor(theme.ink).font('Helvetica-Bold').text(formatMoney(subtotal, currency), totalsX + 18, y + 20, { width: totalsW - 36, align: 'right' });

    doc.fillColor(theme.muted).font('Helvetica');
    doc.text(`IGV (${(taxRate * 100).toFixed(0)}%)`, totalsX + 18, y + 42);
    doc.fillColor(theme.ink).font('Helvetica-Bold').text(formatMoney(tax, currency), totalsX + 18, y + 42, { width: totalsW - 36, align: 'right' });

    doc.moveTo(totalsX + 16, y + 64).lineTo(totalsX + totalsW - 16, y + 64)
      .strokeOpacity(0.4).strokeColor(notesBorder).lineWidth(0.6).stroke().strokeOpacity(1);

    // Total destacado — color según layout
    const totalFill = isSakura ? '#d81b60' : (isImperial ? '#b71c1c' : (isDragon ? theme.accent : theme.accent));
    doc.roundedRect(totalsX + 14, y + 76, totalsW - 28, 32, 10).fill(totalFill);
    const totalTextColor = isImperial ? '#f5e6b8' : '#ffffff';
    doc.fillColor(totalTextColor).font('Helvetica-Bold').fontSize(9).text('TOTAL', totalsX + 26, y + 86);
    doc.font('Helvetica-Bold').fontSize(13).text(formatMoney(total, currency), totalsX + 14, y + 84, { width: totalsW - 28, align: 'right' });

    // ================================================================
    // FOOTER: QR + Información
    // ================================================================
    y += bottomBlockH + 22;
    y = ensureSpace(doc, y, 130);

    // QR
    doc.roundedRect(40, y, 100, 100, 14).fillAndStroke('#ffffff', notesBorder);
    doc.image(qrDataUrl, 50, y + 10, { width: 80 });
    doc.fillColor(theme.muted).font('Helvetica-Bold').fontSize(6.5).text('QR DE VALIDACIÓN', 40, y + 92, { width: 100, align: 'center', characterSpacing: 1.2 });

    // Panel derecho
    doc.roundedRect(155, y, 400, 100, 14).fillAndStroke(notesFill, notesBorder);
    doc.rect(170, y + 15, 3, 10).fill(theme.accent);

    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(7.5).text('REPRESENTACIÓN PROFESIONAL DEL COMPROBANTE', 179, y + 14, { width: 361, characterSpacing: 0.8 });
    doc.font('Helvetica').fillColor('#475569').fontSize(8).text(
      `Documento: ${title} · ${numbering.full}\n` +
      `Precios ${data.pricesIncludeTax ? 'con' : 'sin'} IGV incluido. Pago: ${paymentMethod || 'Pago único'}.\n` +
      `Este archivo está pensado para ventas rápidas por Instagram, Facebook, WhatsApp y atención directa.`,
      170, y + 30, { width: 370, lineGap: 2 }
    );

    doc.font('Helvetica').fillColor(theme.muted).fontSize(7).text(
      `QR: ${qrContent}`,
      170, y + 78, { width: 370 }
    );

    // Decoración adicional al pie según layout (marca visual de plantilla)
    if (isImperial) {
      // Pequeño sello decorativo en el pie
      doc.circle(555, y + 50, 12).fillOpacity(0.9).fill('#b71c1c').fillOpacity(1);
      doc.fillColor('#f5e6b8').font('Helvetica-Bold').fontSize(7).text('印', 548, y + 47);
    } else if (isSakura) {
      doc.fillColor('#d81b60').font('Helvetica').fontSize(14).text('✿', 540, y + 45, { width: 20, align: 'center' });
    } else if (isJade) {
      doc.rect(545, y + 40, 2, 22).fill(theme.accent);
    } else if (isDragon) {
      doc.circle(548, y + 45, 2).fill('#d4af37');
      doc.circle(554, y + 45, 2).fill('#d4af37');
      doc.circle(551, y + 55, 2).fill('#d4af37');
    }

    doc.restore();
    doc.end();
  });
}

// ---------------------------------------------------------------
//  MIDDLEWARE DE VERIFICACIÓN DE LÍMITE
// ---------------------------------------------------------------
async function verificarLimite(uid) {
  if (!dbInstance) throw new Error('Base de datos no disponible');
  const userRef = dbInstance.collection('usuarios').doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) throw new Error('Usuario no encontrado');
  const data = userDoc.data();
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
  if (!dbInstance) throw new Error('Base de datos no disponible');
  const userRef = dbInstance.collection('usuarios').doc(uid);
  await userRef.update({ comprobantesEmitidos: admin.firestore.FieldValue.increment(1) });
}

// ---------------------------------------------------------------
//  RUTAS (INTACTAS)
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
    if (!uid) return res.status(401).json({ ok: false, message: 'Se requiere autenticación (uid).' });

    const { plan } = await verificarLimite(uid);
    const normalized = normalizePayload(payload);

    if (plan === PLAN_GRATIS_ID) {
      if (!PLANTILLAS_PLAN_GRATIS.includes(normalized.templateId)) {
        return res.status(403).json({ ok: false, message: 'Tu plan gratuito solo permite usar la plantilla Moderna Azul. Actualiza tu plan para desbloquear las demás plantillas.' });
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
    if (!uid) return res.status(401).json({ ok: false, message: 'Se requiere autenticación (uid).' });

    const { plan } = await verificarLimite(uid);
    const normalized = normalizePayload(payload);

    if (plan === PLAN_GRATIS_ID) {
      if (!PLANTILLAS_PLAN_GRATIS.includes(normalized.templateId)) {
        return res.status(403).json({ ok: false, message: 'Tu plan gratuito solo permite usar la plantilla Moderna Azul. Actualiza tu plan para desbloquear las demás plantillas.' });
      }
      normalized.issuer.logoDataUrl = '';
    }

    const pdfBuffer = await buildPdfBuffer(normalized, plan);
    const filename = `${normalized.documentType}_${normalized.numbering.full}.pdf`.replace(/\s+/g, '_');

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
