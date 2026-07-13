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

// ================================================================
// 🔧 HELPERS GENERALES
// ================================================================

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
  return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function buildSeries(documentType) { return documentType === 'factura' ? 'F001' : 'B001'; }
function buildCorrelative() { return String(Date.now()).slice(-8); }
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
      ...item,
      subtotal, tax, total, gross,
      unitSubtotal: pricesIncludeTax ? item.unitPrice / (1 + rate) : item.unitPrice,
      unitTotal: pricesIncludeTax ? item.unitPrice : item.unitPrice * (1 + rate)
    };
  });
  const subtotal = enrichedItems.reduce((sum, item) => sum + item.subtotal, 0);
  const tax = enrichedItems.reduce((sum, item) => sum + item.tax, 0);
  const total = enrichedItems.reduce((sum, item) => sum + item.total, 0);
  return { items: enrichedItems, subtotal, tax, total, taxRate: rate, pricesIncludeTax };
}

function normalizePayload(payload = {}, options = {}) {
  const documentType = payload.documentType === 'factura' ? 'factura' : 'boleta';
  const templateId = TEMPLATE_REGISTRY[payload.templateId] ? payload.templateId : 'moderna';
  const issueDate = payload.issueDate || new Date().toISOString();
  const pricesIncludeTax = payload.pricesIncludeTax !== false;
  const taxRate = Number.isFinite(Number(payload.taxRate)) ? Number(payload.taxRate) : IGV_DEFAULT;
  const currency = payload.currency || CURRENCY;

  const issuer = {
    businessName: String(payload.issuer?.businessName || 'TU NEGOCIO').trim(),
    documentNumber: String(payload.issuer?.documentNumber || '').trim(),
    address: String(payload.issuer?.address || '').trim(),
    phone: String(payload.issuer?.phone || '').trim(),
    email: String(payload.issuer?.email || '').trim(),
    website: String(payload.issuer?.website || '').trim()
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
    template: TEMPLATE_REGISTRY[templateId],
    marcaAgua: !!options.marcaAgua
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
    color: { dark: '#111827', light: '#ffffff' }
  });
}

// ================================================================
// 🔒 HELPERS DE PLAN Y CONTADOR (Firestore real)
// ================================================================
const PLANES_FACILITOTOOLS = {
  gratis:      { id: 'gratis',      precio: 0,    duracionDias: null, limite: 5,    plantillasPermitidas: ['moderna'],                                              marcaAgua: true  },
  semanal:     { id: 'semanal',     precio: 7.00, duracionDias: 7,   limite: 150,  plantillasPermitidas: ['moderna','elegante','corporativa','premium'],          marcaAgua: false },
  mensual:     { id: 'mensual',     precio: 19.00,duracionDias: 30,  limite: 800,  plantillasPermitidas: ['moderna','elegante','corporativa','premium'],          marcaAgua: false },
  bimestral:   { id: 'bimestral',   precio: 32.00,duracionDias: 60,  limite: 1800, plantillasPermitidas: ['moderna','elegante','corporativa','premium'],          marcaAgua: false },
  semestral:   { id: 'semestral',   precio: 75.00,duracionDias: 180, limite: 6000, plantillasPermitidas: ['moderna','elegante','corporativa','premium'],          marcaAgua: false }
};

function esFechaExpirada(fechaFin) {
  if (!fechaFin) return false;
  try {
    const fin = fechaFin.toDate ? fechaFin.toDate() : new Date(fechaFin);
    return fin.getTime() < Date.now();
  } catch { return false; }
}

async function leerPlanUsuario(db, uid) {
  if (!db || !uid) {
    return {
      planId: 'gratis', plan: PLANES_FACILITOTOOLS.gratis,
      limite: PLANES_FACILITOTOOLS.gratis.limite,
      emitidos: 0,
      restantes: PLANES_FACILITOTOOLS.gratis.limite,
      plantillasPermitidas: PLANES_FACILITOTOOLS.gratis.plantillasPermitidas,
      marcaAgua: PLANES_FACILITOTOOLS.gratis.marcaAgua,
      expiro: false
    };
  }
  const userRef = db.collection('usuarios').doc(uid);
  const userSnap = await userRef.get();
  const data = userSnap.exists ? userSnap.data() : {};
  const planIdCrudo = data.tipoPlan;
  const planId = PLANES_FACILITOTOOLS[planIdCrudo] ? planIdCrudo : 'gratis';
  const plan = PLANES_FACILITOTOOLS[planId];
  const limite = typeof data.limite_plan === 'number' ? data.limite_plan : plan.limite;
  const emitidos = typeof data.recibos_emitidos === 'number' ? data.recibos_emitidos : 0;
  const expiro = esFechaExpirada(data.fecha_fin_plan);
  return {
    planId, plan, limite, emitidos,
    restantes: Math.max(0, limite - emitidos),
    plantillasPermitidas: plan.plantillasPermitidas,
    marcaAgua: plan.marcaAgua,
    expiro
  };
}

async function consumirRecibo(db, uid) {
  if (!db || !uid) {
    return { ok: false, error: 'NO_AUTH' };
  }
  const userRef = db.collection('usuarios').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return { ok: false, error: 'NO_USER' };
  const data = userSnap.data();
  const planIdCrudo = data.tipoPlan;
  const planId = PLANES_FACILITOTOOLS[planIdCrudo] ? planIdCrudo : 'gratis';
  const plan = PLANES_FACILITOTOOLS[planId];
  const limite = typeof data.limite_plan === 'number' ? data.limite_plan : plan.limite;
  const emitidos = typeof data.recibos_emitidos === 'number' ? data.recibos_emitidos : 0;

  if (esFechaExpirada(data.fecha_fin_plan)) {
    return { ok: false, error: 'PLAN_EXPIRED', planId, limite, emitidos, restantes: 0 };
  }
  if (emitidos >= limite) {
    return {
      ok: false, error: 'LIMIT_REACHED',
      planId, limite, emitidos, restantes: 0,
      message: 'Has alcanzado el límite de tu plan actual. Actualiza a nuestro Plan Mensual o Bimestral para seguir emitiendo sin interrupciones.'
    };
  }
  await userRef.update({
    recibos_emitidos: admin.firestore.FieldValue.increment(1),
    ultimoReciboAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { ok: true, planId, limite, emitidos: emitidos + 1, restantes: Math.max(0, limite - (emitidos + 1)) };
}

// ================================================================
// 🎨 CSS DINÁMICO DE PLANTILLAS + MARCA DE AGUA
// ================================================================

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
    body {
      margin: 0;
      padding: 24px;
      background: #eef2f7;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .voucher {
      max-width: 980px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.14);
      border: 1px solid rgba(148, 163, 184, 0.18);
      position: relative;
    }
    .hero {
      background: linear-gradient(135deg, var(--accent) 0%, #1e293b 100%);
      color: white;
      padding: 28px 32px;
      display: grid;
      grid-template-columns: 1.3fr 0.7fr;
      gap: 20px;
      align-items: start;
    }
    .brand-title { font-size: 28px; font-weight: 800; line-height: 1.1; margin-bottom: 10px; letter-spacing: -0.02em; }
    .brand-meta, .doc-meta, .small-box, .legal, .totals table, .items th, .items td, .summary-pill, .section-title, .empty-note { font-size: 14px; }
    .brand-meta div, .doc-meta div { margin-bottom: 6px; opacity: 0.96; }
    .doc-card {
      background: rgba(255,255,255,0.14);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 20px;
      padding: 18px 20px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.14);
    }
    .doc-type { font-size: 12px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.8; margin-bottom: 10px; }
    .doc-number { font-size: 28px; font-weight: 800; line-height: 1.1; margin-bottom: 12px; }
    .content { padding: 28px 32px 18px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 20px; }
    .box { border: 1px solid var(--line); border-radius: 18px; background: var(--panel); padding: 18px; }
    .section-title {
      display: inline-flex; align-items: center; gap: 8px;
      color: var(--accent); font-weight: 800; margin-bottom: 12px;
      text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px;
    }
    .small-box div { margin-bottom: 8px; }
    .items-wrap { border: 1px solid var(--line); border-radius: 20px; overflow: hidden; margin-bottom: 20px; }
    .items { width: 100%; border-collapse: collapse; background: white; }
    .items thead th {
      background: var(--accent-soft);
      color: var(--accent);
      text-align: left;
      padding: 14px 16px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .items tbody td { padding: 14px 16px; border-top: 1px solid var(--line); vertical-align: top; }
    .items tbody tr:nth-child(even) td { background: var(--panel); }
    .item-name { font-weight: 700; }
    .item-sku { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .totals-area { display: grid; grid-template-columns: 1fr minmax(280px, 360px); gap: 18px; align-items: start; margin-bottom: 24px; }
    .summary-pills { display: flex; flex-wrap: wrap; gap: 10px; }
    .summary-pill {
      border: 1px solid var(--line);
      padding: 12px 14px;
      border-radius: 999px;
      background: white;
      font-weight: 600;
      color: var(--muted);
    }
    .totals { border: 1px solid var(--line); border-radius: 18px; overflow: hidden; background: white; }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td { padding: 14px 16px; border-top: 1px solid var(--line); }
    .totals tr:first-child td { border-top: none; }
    .totals td:last-child { text-align: right; font-weight: 700; }
    .totals .grand td { background: var(--accent); color: white; font-size: 18px; }
    .footer {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 18px;
      border-top: 1px solid var(--line);
      padding: 24px 32px 32px;
      align-items: start;
      background: linear-gradient(180deg, #fff 0%, var(--panel) 100%);
    }
    .qr-box { border: 1px solid var(--line); border-radius: 16px; background: white; padding: 10px; text-align: center; }
    .qr-box img { width: 100%; max-width: 120px; display: block; margin: 0 auto 8px; }
    .legal { color: var(--muted); line-height: 1.7; }
    .legal strong { color: var(--ink); }
    .empty-note { padding: 14px 16px; background: var(--accent-soft); border-radius: 14px; color: var(--accent); font-weight: 700; }
    .watermark-bar {
      background: linear-gradient(90deg, #dc2626 0%, #b91c1c 100%);
      color: white;
      text-align: center;
      padding: 10px 16px;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .watermark-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image: repeating-linear-gradient(
        -30deg,
        rgba(220, 38, 38, 0.08) 0px,
        rgba(220, 38, 38, 0.08) 220px,
        transparent 220px,
        transparent 460px
      );
      z-index: 5;
    }
    .watermark-stamp {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-30deg);
      font-size: 56px;
      font-weight: 900;
      letter-spacing: 0.18em;
      color: rgba(220, 38, 38, 0.18);
      text-transform: uppercase;
      white-space: nowrap;
      pointer-events: none;
      z-index: 6;
    }
    @media (max-width: 840px) {
      body { padding: 10px; }
      .hero, .grid, .totals-area, .footer { grid-template-columns: 1fr; }
      .content, .hero, .footer { padding-left: 18px; padding-right: 18px; }
      .doc-number { font-size: 24px; }
      .brand-title { font-size: 24px; }
      .items-wrap { overflow-x: auto; }
      .items { min-width: 720px; }
      .watermark-stamp { font-size: 36px; }
    }
  `;
}

async function renderVoucherHtml(data) {
  const { template, issuer, customer, numbering, items, subtotal, tax, total, notes, paymentMethod, documentType, currency, taxRate, pricesIncludeTax, qrContent, issueDate, marcaAgua } = data;
  const qrDataUrl = await getQrDataUrl(qrContent);
  const title = documentType === 'factura' ? 'Factura electrónica' : 'Boleta de venta';
  const paymentLabel = paymentMethod || 'Pago único';

  const rows = items.map((item) => `
      <tr>
        <td>${item.index}</td>
        <td>
          <div class="item-name">${escapeHtml(item.description)}</div>
          ${item.sku ? `<div class="item-sku">SKU: ${escapeHtml(item.sku)}</div>` : ''}
        </td>
        <td>${escapeHtml(item.unitLabel)}</td>
        <td>${item.quantity}</td>
        <td>${formatMoney(item.unitTotal, currency)}</td>
        <td>${formatMoney(item.total, currency)}</td>
      </tr>
    `).join('');

  const watermarkHtml = marcaAgua ? `
    <div class="watermark-bar">
      Generado con FacilitoTools · Versión Gratuita<span style="margin-left:8px;">Desbloquea todas las plantillas</span>
    </div>
    <div class="watermark-overlay" aria-hidden="true"></div>
    <div class="watermark-stamp" aria-hidden="true">FACILITOTOOLS · GRATIS</div>
  ` : '';

  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} ${escapeHtml(numbering.full)}</title>
    <style>${buildTemplateCss(template.theme)}</style>
  </head>
  <body>
    <article class="voucher">
      ${watermarkHtml}
      <header class="hero">
        <div>
          <div class="brand-title">${escapeHtml(issuer.businessName)}</div>
          <div class="brand-meta">
            ${issuer.documentNumber ? `<div><strong>Documento:</strong> ${escapeHtml(issuer.documentNumber)}</div>` : ''}
            ${issuer.address ? `<div><strong>Dirección:</strong> ${escapeHtml(issuer.address)}</div>` : ''}
            ${issuer.phone ? `<div><strong>Teléfono:</strong> ${escapeHtml(issuer.phone)}</div>` : ''}
            ${issuer.email ? `<div><strong>Email:</strong> ${escapeHtml(issuer.email)}</div>` : ''}
            ${issuer.website ? `<div><strong>Web:</strong> ${escapeHtml(issuer.website)}</div>` : ''}
          </div>
        </div>
        <div class="doc-card">
          <div class="doc-type">${escapeHtml(title)}</div>
          <div class="doc-number">${escapeHtml(numbering.full)}</div>
          <div class="doc-meta">
            <div><strong>Fecha:</strong> ${escapeHtml(formatDateTime(issueDate))}</div>
            <div><strong>Moneda:</strong> ${escapeHtml(currency)}</div>
            <div><strong>Plantilla:</strong> ${escapeHtml(template.name)}</div>
            <div><strong>Pago:</strong> ${escapeHtml(paymentLabel)}</div>
          </div>
        </div>
      </header>

      <section class="content">
        <div class="grid">
          <div class="box small-box">
            <div class="section-title">Cliente</div>
            <div><strong>Nombre:</strong> ${escapeHtml(customer.name)}</div>
            <div><strong>${escapeHtml(customer.documentType || 'Documento')}:</strong> ${escapeHtml(customer.documentNumber || '-')}</div>
            ${customer.email ? `<div><strong>Email:</strong> ${escapeHtml(customer.email)}</div>` : ''}
            ${customer.phone ? `<div><strong>Teléfono:</strong> ${escapeHtml(customer.phone)}</div>` : ''}
            ${customer.address ? `<div><strong>Dirección:</strong> ${escapeHtml(customer.address)}</div>` : ''}
          </div>

          <div class="box small-box">
            <div class="section-title">Resumen comercial</div>
            <div><strong>Operación gravada:</strong> ${formatMoney(subtotal, currency)}</div>
            <div><strong>IGV (${(taxRate * 100).toFixed(0)}%):</strong> ${formatMoney(tax, currency)}</div>
            <div><strong>Total:</strong> ${formatMoney(total, currency)}</div>
            <div><strong>Precios ingresados:</strong> ${pricesIncludeTax ? 'con IGV incluido' : 'sin IGV'}</div>
          </div>
        </div>

        <div class="items-wrap">
          <table class="items">
            <thead>
              <tr>
                <th>#</th>
                <th>Descripción</th>
                <th>Unidad</th>
                <th>Cantidad</th>
                <th>P. unitario</th>
                <th>Importe</th>
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
              <div class="summary-pill">${escapeHtml(documentType === 'factura' ? 'Factura apta para venta empresarial' : 'Boleta apta para venta rápida')}</div>
              <div class="summary-pill">Plantilla ${escapeHtml(template.name)}</div>
            </div>
            <div style="margin-top:16px;">
              ${notes ? `<div class="box legal"><strong>Observaciones:</strong><br/>${escapeHtml(notes)}</div>` : '<div class="empty-note">Puedes añadir observaciones, condiciones comerciales o mensaje de agradecimiento.</div>'}
            </div>
          </div>
          <div class="totals">
            <table>
              <tr><td>Subtotal</td><td>${formatMoney(subtotal, currency)}</td></tr>
              <tr><td>IGV (${(taxRate * 100).toFixed(0)}%)</td><td>${formatMoney(tax, currency)}</td></tr>
              <tr class="grand"><td>Total a pagar</td><td>${formatMoney(total, currency)}</td></tr>
            </table>
          </div>
        </div>
      </section>

      <footer class="footer">
        <div class="qr-box">
          <img src="${qrDataUrl}" alt="QR del comprobante" />
          <div style="font-size:12px;color:var(--muted)">QR de validación</div>
        </div>
        <div class="legal">
          <strong>Representación visual del comprobante</strong><br/>
          Este documento ha sido generado para agilizar la emisión comercial de ventas por redes sociales y canales directos. Verifica siempre los datos fiscales del emisor y del cliente antes de compartir o descargar el PDF final.<br/><br/>
          <strong>Cadena QR:</strong> ${escapeHtml(qrContent)}
        </div>
      </footer>
    </article>
  </body>
</html>`;
}

// ================================================================
// 📄 GENERACIÓN DEL PDF + MARCA DE AGUA EN CADA PÁGINA
// ================================================================

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

async function buildPdfBuffer(data) {
  const { template, issuer, customer, numbering, items, subtotal, tax, total, notes, paymentMethod, documentType, currency, taxRate, qrContent, issueDate, marcaAgua } = data;
  const theme = template.theme;
  const qrDataUrl = await getQrDataUrl(qrContent);
  const title = documentType === 'factura' ? 'FACTURA ELECTRÓNICA' : 'BOLETA DE VENTA';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.save();
    doc.roundedRect(40, 40, 515, 90, 18).fill(theme.accent);

    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text(issuer.businessName, 60, 60, { width: 280 });
    doc.font('Helvetica').fontSize(9);
    let issuerMetaY = 86;
    [
      issuer.documentNumber ? `Documento: ${issuer.documentNumber}` : '',
      issuer.address ? `Dirección: ${issuer.address}` : '',
      issuer.phone ? `Teléfono: ${issuer.phone}` : '',
      issuer.email ? `Email: ${issuer.email}` : ''
    ].filter(Boolean).forEach((line) => {
      doc.text(line, 60, issuerMetaY, { width: 260 });
      issuerMetaY += 12;
    });

    doc.roundedRect(350, 55, 180, 60, 14).fillOpacity(0.12).fillAndStroke('#ffffff', '#ffffff').fillOpacity(1);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(title, 365, 68, { width: 150, align: 'center' });
    doc.fontSize(18).text(numbering.full, 365, 84, { width: 150, align: 'center' });

    doc.roundedRect(40, 150, 250, 108, 14).fill(theme.panel).stroke(theme.line);
    doc.roundedRect(305, 150, 250, 108, 14).fill(theme.panel).stroke(theme.line);

    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(10).text('DATOS DEL CLIENTE', 55, 165);
    drawLabelValue(doc, 'Nombre', customer.name, 55, 185, 210);
    drawLabelValue(doc, customer.documentType || 'Documento', customer.documentNumber || '-', 55, 215, 210);
    drawLabelValue(doc, 'Email', customer.email || '-', 55, 245, 210);

    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(10).text('DETALLE DE EMISIÓN', 320, 165);
    drawLabelValue(doc, 'Fecha', formatDateTime(issueDate), 320, 185, 210);
    drawLabelValue(doc, 'Plantilla', template.name, 320, 215, 210);
    drawLabelValue(doc, 'Pago', paymentMethod || 'Pago único', 320, 245, 210);

    let y = 285;
    doc.roundedRect(40, y, 515, 28, 10).fill(theme.accentSoft);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9);
    const columns = { index: 50, desc: 78, unit: 320, qty: 380, unitPrice: 430, amount: 495 };
    drawText(doc, '#', columns.index, y + 9);
    drawText(doc, 'DESCRIPCIÓN', columns.desc, y + 9);
    drawText(doc, 'UND', columns.unit, y + 9);
    drawText(doc, 'CANT', columns.qty, y + 9);
    drawText(doc, 'P. UNIT', columns.unitPrice, y + 9);
    drawText(doc, 'IMPORTE', columns.amount, y + 9);
    y += 38;

    items.forEach((item) => {
      const descHeight = doc.heightOfString(item.description, { width: 220, align: 'left' });
      const rowHeight = Math.max(26, descHeight + 10);
      y = ensureSpace(doc, y, rowHeight + 20);
      doc.roundedRect(40, y - 4, 515, rowHeight, 10).fillOpacity(0.08).fill(theme.panelStrong).fillOpacity(1);
      doc.fillColor(theme.ink).font('Helvetica').fontSize(9);
      drawText(doc, item.index, columns.index, y + 6);
      drawText(doc, item.description, columns.desc, y + 6, { width: 220 });
      drawText(doc, item.unitLabel, columns.unit, y + 6);
      drawText(doc, item.quantity, columns.qty, y + 6);
      drawText(doc, formatMoney(item.unitTotal, currency), columns.unitPrice, y + 6);
      drawText(doc, formatMoney(item.total, currency), columns.amount, y + 6);
      y += rowHeight + 8;
    });

    y += 10;
    y = ensureSpace(doc, y, 160);

    doc.roundedRect(40, y, 235, 110, 14).fill(theme.panel).stroke(theme.line);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(10).text('OBSERVACIONES', 55, y + 15);
    doc.font('Helvetica').fillColor(theme.ink).fontSize(9).text(notes || 'Puedes usar este espacio para garantía, condiciones, método de entrega o agradecimiento al cliente.', 55, y + 34, { width: 205, align: 'left' });

    doc.roundedRect(300, y, 255, 110, 14).fill('#ffffff').stroke(theme.line);
    doc.fillColor(theme.ink).font('Helvetica').fontSize(10);
    doc.text('Subtotal', 318, y + 20);
    doc.font('Helvetica-Bold').text(formatMoney(subtotal, currency), 455, y + 20, { width: 80, align: 'right' });
    doc.font('Helvetica').text(`IGV (${(taxRate * 100).toFixed(0)}%)`, 318, y + 45);
    doc.font('Helvetica-Bold').text(formatMoney(tax, currency), 455, y + 45, { width: 80, align: 'right' });
    doc.roundedRect(315, y + 72, 225, 26, 10).fill(theme.accent);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text('TOTAL', 330, y + 80);
    doc.text(formatMoney(total, currency), 430, y + 80, { width: 95, align: 'right' });

    y += 135;
    y = ensureSpace(doc, y, 130);

    doc.roundedRect(40, y, 100, 100, 14).fill('#ffffff').stroke(theme.line);
    doc.image(qrDataUrl, 50, y + 10, { width: 80 });

    doc.roundedRect(155, y, 400, 100, 14).fill(theme.panel).stroke(theme.line);
    doc.fillColor(theme.ink).font('Helvetica-Bold').fontSize(9).text('Representación profesional del comprobante', 170, y + 16);
    doc.font('Helvetica').fillColor('#475569').fontSize(8).text(
      `Documento: ${title} · ${numbering.full}\n` +
      `QR: ${qrContent}\n` +
      `Precios ${data.pricesIncludeTax ? 'con' : 'sin'} IGV incluido. Pago: ${paymentMethod || 'Pago único'}.\n` +
      `Este archivo está pensado para ventas rápidas por Instagram, Facebook, WhatsApp y atención directa.`,
      170, y + 34, { width: 370, lineGap: 2 }
    );

    if (marcaAgua) {
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.save();

        doc.save();
        doc.rect(0, 0, doc.page.width, 26).fill('#dc2626');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
          .text('GENERADO CON FACILITOTOOLS · VERSIÓN GRATUITA', 0, 7, { width: doc.page.width, align: 'center' });
        doc.restore();

        doc.save();
        doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.fillColor('#dc2626').opacity(0.12);
        doc.font('Helvetica-Bold').fontSize(72);
        doc.text('FACILITOTOOLS · GRATIS', 0, doc.page.height / 2 - 36, { width: doc.page.width, align: 'center' });
        doc.fillColor('#dc2626').opacity(0.08);
        doc.fontSize(48);
        doc.text('FACILITOTOOLS · GRATIS', 0, doc.page.height / 2 + 60, { width: doc.page.width, align: 'center' });
        doc.restore();

        doc.save();
        doc.rect(0, doc.page.height - 24, doc.page.width, 24).fill('#fef2f2').stroke('#fecaca');
        doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(9)
          .text('FacilitoTools · Versión Gratuita · Desbloquea todas las plantillas y elimina esta marca con el Plan Mensual o Bimestral.',
                20, doc.page.height - 17, { width: doc.page.width - 40, align: 'center' });
        doc.restore();

        doc.restore();
      }
    }

    doc.restore();
    doc.end();
  });
}

// ================================================================
// 🚦 ENDPOINTS DEL ROUTER
// ================================================================

router.get('/templates', (req, res) => {
  res.json({
    ok: true,
    templates: Object.values(TEMPLATE_REGISTRY).map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      accent: template.theme.accent,
      accentSoft: template.theme.accentSoft
    }))
  });
});

router.get('/planes', (req, res) => {
  res.json({
    ok: true,
    planes: Object.values(PLANES_FACILITOTOOLS)
  });
});

router.get('/plan-info/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ ok: false, error: 'uid requerido' });
    let dbRef = null;
    try {
      const mod = await import('./index.js');
      dbRef = mod.db || null;
    } catch (e) { dbRef = null; }
    const info = await leerPlanUsuario(dbRef, uid);
    res.json(info);
  } catch (error) {
    console.error('plan-info', error);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const { uid, templateId } = req.body;
    let plan = { plantillasPermitidas: ['moderna'], marcaAgua: true, planId: 'gratis' };
    try {
      const mod = await import('./index.js');
      if (mod && typeof mod.obtenerInfoPlanUsuario === 'function') {
        plan = await mod.obtenerInfoPlanUsuario(uid);
      }
    } catch (_) {}

    if (uid && templateId && !plan.plantillasPermitidas.includes(templateId)) {
      return res.status(403).json({
        ok: false,
        code: 'TEMPLATE_LOCKED',
        message: `La plantilla "${templateId}" es exclusiva de los planes pagos. Actualiza a Plan Mensual o Bimestral para desbloquearla.`,
        plantillasPermitidas: plan.plantillasPermitidas
      });
    }

    const marcaAgua = uid ? !!plan.marcaAgua : false;
    const normalized = normalizePayload(req.body, { marcaAgua });
    const html = await renderVoucherHtml(normalized);

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
      marcaAgua,
      html
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'No se pudo generar la vista previa.' });
  }
});

router.post('/pdf', async (req, res) => {
  try {
    const { uid, templateId } = req.body;
    if (!uid) {
      return res.status(400).json({
        ok: false,
        code: 'NO_AUTH',
        message: 'Debes iniciar sesión para generar PDFs y registrar tu consumo.'
      });
    }

    let mod;
    try { mod = await import('./index.js'); } catch (_) { mod = null; }
    const dbRef = (mod && mod.db) || null;

    const plan = await leerPlanUsuario(dbRef, uid);
    if (templateId && !plan.plantillasPermitidas.includes(templateId)) {
      return res.status(403).json({
        ok: false,
        code: 'TEMPLATE_LOCKED',
        message: `La plantilla "${templateId}" es exclusiva de los planes pagos. Actualiza a Plan Mensual o Bimestral para desbloquearla.`,
        plantillasPermitidas: plan.plantillasPermitidas,
        restantes: plan.restantes,
        limite: plan.limite
      });
    }

    const consumo = await consumirRecibo(dbRef, uid);
    if (!consumo.ok) {
      if (consumo.error === 'LIMIT_REACHED') {
        return res.status(402).json({
          ok: false,
          code: 'LIMIT_REACHED',
          message: 'Has alcanzado el límite de tu plan actual. Actualiza a nuestro Plan Mensual o Bimestral para seguir emitiendo sin interrupciones.',
          limite: consumo.limite,
          emitidos: consumo.emitidos,
          restantes: 0,
          planId: consumo.planId
        });
      }
      if (consumo.error === 'PLAN_EXPIRED') {
        return res.status(402).json({
          ok: false,
          code: 'PLAN_EXPIRED',
          message: 'Tu plan FacilitoTools ha vencido. Renueva uno de nuestros planes para seguir emitiendo.',
          planId: consumo.planId
        });
      }
      return res.status(503).json({ ok: false, message: 'No se pudo registrar el consumo del recibo.', error: consumo.error });
    }

    const marcaAgua = !!plan.marcaAgua;
    const normalized = normalizePayload(req.body, { marcaAgua });
    const pdfBuffer = await buildPdfBuffer(normalized);
    const filename = `${normalized.documentType}_${normalized.numbering.full}.pdf`.replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Facilito-Plan', plan.planId);
    res.setHeader('X-Facilito-Limite', String(consumo.limite));
    res.setHeader('X-Facilito-Emitidos', String(consumo.emitidos));
    res.setHeader('X-Facilito-Restantes', String(consumo.restantes));
    res.send(pdfBuffer);
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'No se pudo generar el PDF.' });
  }
});

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'plantillas-comprobantes-facilito' });
});

export { TEMPLATE_REGISTRY, normalizePayload, PLANES_FACILITOTOOLS };
export default router;
