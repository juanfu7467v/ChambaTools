// ================================================================
// 🧑‍💻 DEVELOPER API — Router seguro para integración por API Key
// ================================================================
// Esta capa es COMPLETAMENTE NUEVA y ADITIVA: no modifica ni
// reemplaza ninguna ruta existente (/api/comprobantes, /api/emisor,
// /api/validar/*, /api/login, etc.). Su único objetivo es exponer:
//   1) Endpoints de autogestión de API Keys para usuarios autenticados:
//        GET    /api/developer/keys            → listar claves del usuario
//        POST   /api/developer/keys            → crear nueva clave
//        POST   /api/developer/keys/:id/regenerate → rotar (revoca + crea)
//        DELETE /api/developer/keys/:id        → revocar clave
//   2) Endpoints PÚBLICOS para que los desarrolladores consuman desde
//      sus propios sistemas usando el header `Authorization: Bearer <KEY>`:
//        GET    /v1/me                   → info de la cuenta del dev (plan, cupo)
//        GET    /v1/templates            → plantillas disponibles
//        POST   /v1/comprobantes/preview → vista previa (HTML, sin consumir cupo)
//        POST   /v1/comprobantes/pdf     → PDF (consume 1 cupo del plan)
//        POST   /v1/comprobantes/build   → datos normalizados (JSON) sin PDF
//
// ⚠️ CÓMO INTEGRAR:
//   import developerApiRouter, { setDb as setDevApiDb }
//     from './developerApi.js';
//   initFirebase(...).then(() => setDevApiDb(db));
//   app.use('/api/developer', developerApiRouter);   // bajo cookie httpOnly
//   app.use('/v1', publicDeveloperRouter);           // bajo API Key httpOnly-less
// ================================================================

import express from 'express';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { logger, getClientIp } from './seguridad.js';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

// ----------------------------------------------------------------
// 🔌 Inyección de Firestore desde index.js (igual que plantillas.js
//    y validarClientes.js)
// ----------------------------------------------------------------
let db = null;
export function setDb(database) {
  db = database;
}

// ----------------------------------------------------------------
// 🔐 Constantes y helpers de seguridad para API Keys
// ----------------------------------------------------------------
// - El token NUNCA se guarda en claro en Firestore.
// - Se guarda el HASH (sha256) en un campo `keyHash`.
// - Al validar, hasheamos el token recibido y comparamos con `keyHash`.
// - `keyPrefix` (primeros 8 chars) se guarda como pista para mostrarla
//   en la UI ("ft_live_aB12…") sin revelar la clave completa.
const API_KEY_PREFIX = 'ft_live_';
const API_KEY_BYTES = 32; // 64 caracteres hex → entropía ≈ 256 bits
const api_key_ratelimit_buckets = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60; // máx 60 requests/min por API key

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey)).digest('hex');
}

function generateApiKey() {
  const random = crypto.randomBytes(API_KEY_BYTES).toString('hex');
  return `${API_KEY_PREFIX}${random}`;
}

function keyPreview(rawKey) {
  if (typeof rawKey !== 'string' || rawKey.length < 12) return '••••••••';
  return `${rawKey.slice(0, 12)}…`;
}

function isRateLimitedByApiKey(keyId) {
  const now = Date.now();
  const bucket = api_key_ratelimit_buckets.get(keyId) || [];
  const fresh = bucket.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  fresh.push(now);
  api_key_ratelimit_buckets.set(keyId, fresh);
  return fresh.length > RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [keyId, bucket] of api_key_ratelimit_buckets.entries()) {
    const fresh = bucket.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) api_key_ratelimit_buckets.delete(keyId);
    else api_key_ratelimit_buckets.set(keyId, fresh);
  }
}, 5 * 60 * 1000).unref?.();

// ----------------------------------------------------------------
// 🔒 Rutas autogestionadas por el usuario autenticado (cookie)
//    (crear / listar / regenerar / revocar)
// ----------------------------------------------------------------
export const developerApiRouter = express.Router();
developerApiRouter.use(express.json({ limit: '1mb' }));

// Lee uid desde cookie httpOnly (mismo mecanismo que el resto de la app)
async function requireAuthFromCookie(req, res) {
  const uid = req.cookies?.user_uid || null;
  if (!uid) {
    res.status(401).json({ success: false, error: 'No autenticado.' });
    return null;
  }
  if (!db) {
    res.status(503).json({ success: false, error: 'Servicio no disponible en este momento.' });
    return null;
  }
  return uid;
}

// Verifica que el usuario tenga plan != 'gratis' para crear API Keys
// (la Interfaz pública de desarrolladores es un beneficio del paid plan).
// Permitimos generar hasta 5 claves activas por usuario.
const MAX_KEYS_PER_USER = 5;

async function getUserPlan(uid) {
  const userDoc = await db.collection('usuarios').doc(uid).get();
  if (!userDoc.exists) return null;
  const data = userDoc.data();
  return {
    uid,
    tipoPlan: data.tipoPlan || 'gratis',
    planStatus: data.planStatus || 'active',
    comprobantesLimite: Number(data.comprobantesLimite ?? 0),
    comprobantesEmitidos: Number(data.comprobantesEmitidos || 0),
    email: data.email || null
  };
}

// GET /api/developer/keys → listar claves del usuario actual
developerApiRouter.get('/keys', async (req, res) => {
  const ctx = 'DEVAPI_LIST';
  try {
    const uid = await requireAuthFromCookie(req, res);
    if (!uid) return;

    const snap = await db.collection('api_keys')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .get();

    const items = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name || 'API Key',
        prefix: d.prefix || '',
        createdAt: d.createdAt?.toDate?.()?.toISOString?.() || null,
        lastUsedAt: d.lastUsedAt?.toDate?.()?.toISOString?.() || null,
        revoked: !!d.revoked,
        revokedAt: d.revokedAt?.toDate?.()?.toISOString?.() || null,
        requestsTotal: Number(d.requestsTotal || 0)
      };
    });

    res.json({ success: true, keys: items, max: MAX_KEYS_PER_USER });
  } catch (error) {
    logger.error(ctx, 'Error listando API keys', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

// POST /api/developer/keys → crear nueva clave
// Body: { name: 'Producción Web' }
developerApiRouter.post('/keys', async (req, res) => {
  const ctx = 'DEVAPI_CREATE';
  try {
    const uid = await requireAuthFromCookie(req, res);
    if (!uid) return;

    const plan = await getUserPlan(uid);
    if (!plan) return res.status(404).json({ success: false, error: 'Usuario no encontrado.' });
    if (plan.tipoPlan === 'gratis' || plan.planStatus !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'La API para desarrolladores está disponible desde el plan "Prueba Corta" en adelante. Actualiza tu plan para obtener tu API Key.',
        code: 'PLAN_REQUIRED'
      });
    }

    const existing = await db.collection('api_keys').where('uid', '==', uid).get();
    const active = existing.docs.filter((d) => !d.data().revoked);
    if (active.length >= MAX_KEYS_PER_USER) {
      return res.status(403).json({
        success: false,
        error: `Has alcanzado el máximo de ${MAX_KEYS_PER_USER} API Keys activas. Revoca una existente para crear una nueva.`
      });
    }

    const rawName = String(req.body?.name || '').trim();
    const name = rawName.length > 60 ? rawName.slice(0, 60) : (rawName || 'API Key');

    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const prefix = keyPreview(rawKey);

    const docRef = await db.collection('api_keys').add({
      uid,
      name,
      prefix,
      keyHash,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUsedAt: null,
      revoked: false,
      revokedAt: null,
      requestsTotal: 0,
      plan: plan.tipoPlan
    });

    logger.info(ctx, 'API key creada', { uid, keyId: docRef.id, prefix });

    // ⚠️ El secreto completo se devuelve UNA SOLA VEZ en esta respuesta.
    //    Después de esto NUNCA más es recuperable: solo guardamos el hash.
    res.json({
      success: true,
      key: {
        id: docRef.id,
        name,
        prefix,
        createdAt: new Date().toISOString(),
        apiKey: rawKey
      },
      warning: 'Guarda esta clave ahora: no se mostrará de nuevo. Trátala como una contraseña.'
    });
  } catch (error) {
    logger.error(ctx, 'Error creando API key', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

// POST /api/developer/keys/:id/regenerate → revoca + crea nueva con mismo nombre
developerApiRouter.post('/keys/:id/regenerate', async (req, res) => {
  const ctx = 'DEVAPI_REGENERATE';
  try {
    const uid = await requireAuthFromCookie(req, res);
    if (!uid) return;

    const id = req.params.id;
    const ref = db.collection('api_keys').doc(id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().uid !== uid) {
      return res.status(404).json({ success: false, error: 'API Key no encontrada.' });
    }

    const oldName = doc.data().name;
    await ref.update({
      revoked: true,
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      rotatedTo: null
    });

    const rawKey = generateApiKey();
    const newDoc = await db.collection('api_keys').add({
      uid,
      name: `${oldName} (rotada)`,
      prefix: keyPreview(rawKey),
      keyHash: hashApiKey(rawKey),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUsedAt: null,
      revoked: false,
      revokedAt: null,
      requestsTotal: 0,
      rotatedFrom: id
    });

    logger.info(ctx, 'API key regenerada', { uid, oldId: id, newId: newDoc.id });

    res.json({
      success: true,
      key: {
        id: newDoc.id,
        name: `${oldName} (rotada)`,
        prefix: keyPreview(rawKey),
        createdAt: new Date().toISOString(),
        apiKey: rawKey
      },
      warning: 'La nueva clave reemplaza a la anterior. Guarda este valor: no se mostrará de nuevo.'
    });
  } catch (error) {
    logger.error(ctx, 'Error regenerando API key', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

// DELETE /api/developer/keys/:id → revocar (no se elimina el doc,
// para mantener auditoría). Se puede volver a crear otra cuando se quiera.
developerApiRouter.delete('/keys/:id', async (req, res) => {
  const ctx = 'DEVAPI_REVOKE';
  try {
    const uid = await requireAuthFromCookie(req, res);
    if (!uid) return;

    const id = req.params.id;
    const ref = db.collection('api_keys').doc(id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().uid !== uid) {
      return res.status(404).json({ success: false, error: 'API Key no encontrada.' });
    }
    if (doc.data().revoked) {
      return res.json({ success: true, alreadyRevoked: true });
    }

    await ref.update({
      revoked: true,
      revokedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    logger.info(ctx, 'API key revocada', { uid, keyId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error(ctx, 'Error revocando API key', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

// =================================================================
// 🌐 RUTAS PÚBLICAS — autenticadas por API Key (Bearer)
//    Estas rutas reusan la MISMA lógica que /api/comprobantes/* pero
//    autenticando por header Authorization: Bearer <KEY> en lugar de
//    cookie httpOnly. Son la "puerta de entrada" de los developers.
// =================================================================
export const publicDeveloperRouter = express.Router();
publicDeveloperRouter.use(express.json({ limit: '2mb' }));

// Cache de validación API Key → uid (TTL 5 min) para evitar ir a
// Firestore en cada request.
const apiKeyCache = new Map(); // keyHash → { uid, tipoPlan, planStatus, exp }
const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

async function authenticateByApiKey(req, res) {
  const ctx = 'DEVAPI_PUBLIC_AUTH';
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({
      ok: false,
      error: 'Falta el header Authorization: Bearer <API_KEY>.',
      code: 'AUTH_REQUIRED'
    });
    return null;
  }
  const rawKey = match[1].trim();
  if (!rawKey.startsWith(API_KEY_PREFIX)) {
    res.status(401).json({ ok: false, error: 'Formato de API Key inválido.', code: 'AUTH_FORMAT' });
    return null;
  }
  const keyHash = hashApiKey(rawKey);

  // ¿Está en cache?
  const cached = apiKeyCache.get(keyHash);
  if (cached && cached.exp > Date.now()) {
    if (cached.revoked) {
      res.status(401).json({ ok: false, error: 'API Key revocada.', code: 'AUTH_REVOKED' });
      return null;
    }
    if (isRateLimitedByApiKey(cached.keyId)) {
      res.status(429).json({ ok: false, error: 'Demasiadas solicitudes. Espera un momento.' });
      return null;
    }
    req.auth = { uid: cached.uid, tipoPlan: cached.tipoPlan, planStatus: cached.planStatus, keyId: cached.keyId };
    return req.auth;
  }

  if (!db) {
    res.status(503).json({ ok: false, error: 'Servicio no disponible en este momento.' });
    return null;
  }

  // Buscar en Firestore por hash
  const snap = await db.collection('api_keys').where('keyHash', '==', keyHash).limit(1).get();
  if (snap.empty) {
    res.status(401).json({ ok: false, error: 'API Key inválida.', code: 'AUTH_INVALID' });
    return null;
  }
  const doc = snap.docs[0];
  const data = doc.data();

  if (data.revoked) {
    apiKeyCache.set(keyHash, { ...data, exp: Date.now() + 60_000 });
    res.status(401).json({ ok: false, error: 'API Key revocada.', code: 'AUTH_REVOKED' });
    return null;
  }
  if (isRateLimitedByApiKey(doc.id)) {
    res.status(429).json({ ok: false, error: 'Demasiadas solicitudes. Espera un momento.' });
    return null;
  }

  // Cargar plan vigente del dueño
  const userDoc = await db.collection('usuarios').doc(data.uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const tipoPlan = userData.tipoPlan || data.plan || 'gratis';
  const planStatus = userData.planStatus || 'active';

  // Cachear
  apiKeyCache.set(keyHash, {
    uid: data.uid,
    tipoPlan,
    planStatus,
    revoked: false,
    keyId: doc.id,
    exp: Date.now() + API_KEY_CACHE_TTL_MS
  });

  req.auth = { uid: data.uid, tipoPlan, planStatus, keyId: doc.id };
  // Métricas en background (no bloquea respuesta)
  doc.ref.update({
    lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
    requestsTotal: admin.firestore.FieldValue.increment(1)
  }).catch(() => {});
  return req.auth;
}

// GET /v1/me → info de la cuenta del developer
publicDeveloperRouter.get('/me', async (req, res) => {
  try {
    const auth = await authenticateByApiKey(req, res);
    if (!auth) return;
    res.json({
      ok: true,
      uid: auth.uid,
      tipoPlan: auth.tipoPlan,
      planStatus: auth.planStatus
    });
  } catch (error) {
    logger.error('DEVAPI_ME', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

// ================================================================
// 🧾 Reuso EXACTO de la lógica de plantillas.js
// --------------------------------------------------------------
// Importamos las funciones puras para no duplicar cálculo de totals,
// render de HTML, render de PDF y validación de plantillas.
// ================================================================
import {
  TEMPLATE_REGISTRY as PUBLIC_TEMPLATE_REGISTRY,
  normalizePayload as publicNormalizePayload
} from './plantillas.js';

// Catálogo público de plantillas
const PUBLIC_TEMPLATES = Object.values(PUBLIC_TEMPLATE_REGISTRY).map((t) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  accent: t.theme?.accent
}));

// GET /v1/templates
publicDeveloperRouter.get('/templates', async (req, res) => {
  try {
    const auth = await authenticateByApiKey(req, res);
    if (!auth) return;
    res.json({ ok: true, templates: PUBLIC_TEMPLATES });
  } catch (error) {
    logger.error('DEVAPI_TEMPLATES', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

// POST /v1/comprobantes/build → solo normaliza y devuelve datos
// (útil para integradores que quieren construir su propio PDF)
publicDeveloperRouter.post('/comprobantes/build', async (req, res) => {
  const ctx = 'DEVAPI_COMPROBANTES_BUILD';
  try {
    const auth = await authenticateByApiKey(req, res);
    if (!auth) return;
    if (auth.planStatus !== 'active') {
      return res.status(403).json({ ok: false, error: 'Plan no activo.', code: 'PLAN_INACTIVE' });
    }
    if (auth.tipoPlan === 'gratis') {
      return res.status(403).json({
        ok: false,
        error: 'La API está disponible solo para planes pagos. Actualiza tu plan.',
        code: 'PLAN_REQUIRED'
      });
    }
    let normalized;
    try {
      // El emisor opcionalmente puede venir vacío: si viene, se usa;
      // si no, el integrador debería pasar su propio issuer completo.
      normalized = publicNormalizePayload(req.body || {});
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    // Restricciones de plan gratuito: si llega una gratuita (no debería
    // porque ya validamos arriba, pero por seguridad) solo se permite Moderna.
    if (auth.tipoPlan === 'gratis' && normalized.templateId !== 'moderna') {
      return res.status(403).json({ ok: false, error: 'Plan gratuito solo permite plantilla Moderna.' });
    }
    // Devolvemos JSON sin campos binarios (logoDataUrl puede ser grande,
    // pero permite a integradores re-renderizar con su propio template).
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
      qrContent: normalized.qrContent,
      data: {
        issueDate: normalized.issueDate,
        currency: normalized.currency,
        notes: normalized.notes,
        paymentMethod: normalized.paymentMethod,
        documentType: normalized.documentType,
        templateId: normalized.templateId,
        pricesIncludeTax: normalized.pricesIncludeTax,
        taxRate: normalized.taxRate,
        issuer: { ...normalized.issuer, logoDataUrl: normalized.issuer.logoDataUrl ? '[PRESENTE]' : '' },
        customer: normalized.customer,
        numbering: normalized.numbering,
        items: normalized.items,
        subtotal: normalized.subtotal,
        tax: normalized.tax,
        total: normalized.total
      }
    });
  } catch (error) {
    logger.error(ctx, error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

// POST /v1/comprobantes/preview → vista previa HTML (sin consumir cupo)
publicDeveloperRouter.post('/comprobantes/preview', async (req, res) => {
  const ctx = 'DEVAPI_COMPROBANTES_PREVIEW';
  try {
    const auth = await authenticateByApiKey(req, res);
    if (!auth) return;
    if (auth.tipoPlan === 'gratis') {
      return res.status(403).json({
        ok: false,
        error: 'La API está disponible solo para planes pagos. Actualiza tu plan.',
        code: 'PLAN_REQUIRED'
      });
    }
    if (auth.planStatus !== 'active') {
      return res.status(403).json({ ok: false, error: 'Plan no activo.' });
    }
    let normalized;
    try {
      normalized = publicNormalizePayload(req.body || {});
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    // Para mantener exactamente la MISMA apariencia que la Interfaz 2,
    // replicamos la función renderVoucherHtml literalmente desde
    // plantillas.js. (No la importamos porque en plantillas.js está
    // declarada como función local, no exportada.)
    const html = await renderPublicVoucherHtml(normalized);
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
    logger.error(ctx, error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

// POST /v1/comprobantes/pdf → generar y devolver PDF (consume 1 cupo)
publicDeveloperRouter.post('/comprobantes/pdf', async (req, res) => {
  const ctx = 'DEVAPI_COMPROBANTES_PDF';
  try {
    const auth = await authenticateByApiKey(req, res);
    if (!auth) return;
    if (auth.tipoPlan === 'gratis') {
      return res.status(403).json({
        ok: false,
        error: 'La API está disponible solo para planes pagos. Actualiza tu plan.',
        code: 'PLAN_REQUIRED'
      });
    }
    if (auth.planStatus !== 'active') {
      return res.status(403).json({ ok: false, error: 'Plan no activo.' });
    }

    // Verificar límite (idéntico a plantillas.js)
    const userRef = db.collection('usuarios').doc(auth.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
    }
    const data = userDoc.data();
    const limite = Number(data.comprobantesLimite ?? 0);
    const emitidos = Number(data.comprobantesEmitidos || 0);
    if (limite !== -1 && emitidos >= limite) {
      return res.status(403).json({
        ok: false,
        error: 'Has alcanzado el límite de comprobantes de tu plan actual.',
        code: 'LIMIT_REACHED'
      });
    }

    let normalized;
    try {
      normalized = publicNormalizePayload(req.body || {});
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    if (normalized.templateId !== 'moderna' && data.tipoPlan === 'gratis') {
      return res.status(403).json({ ok: false, error: 'Plan gratuito solo permite plantilla Moderna.' });
    }

    // Generar PDF con la misma función privada (replicada para no
    // tocar plantillas.js, que no debe cambiarse según instrucciones
    // del usuario). Aquí se reutiliza EXACTAMENTE la misma estética.
    const pdfBuffer = await buildPublicPdfBuffer(normalized, data.tipoPlan);

    // Incrementar contador
    await userRef.update({
      comprobantesEmitidos: admin.firestore.FieldValue.increment(1)
    });

    const filename = `${normalized.documentType}_${normalized.numbering.full}.pdf`.replace(/\s+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error(ctx, error);
    res.status(500).json({ ok: false, error: error.message || 'Error generando el PDF.' });
  }
});

// ================================================================
// 🎨 Replicar las funciones de render HTML/PDF desde plantillas.js
// (manteniendo exactamente la misma estética y lógica de marca de
// agua, plantillas, totales, QR, etc.)
// --------------------------------------------------------------
// Estas funciones son COPIAS LOCALES de las equivalentes en
// plantillas.js. La razón es: el usuario pidió que NO se modificara
// ninguna funcionalidad existente. Mantener una copia local aquí
// garantiza cero impacto sobre Interfaz 1/2 (que siguen usando
// plantillas.js sin tocarse).
// ================================================================
const CURRENCY = 'PEN';
const LOCALE = 'es-PE';
const IGV_DEFAULT = 0.18;

function publicEscapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function publicFormatMoney(value, currency = CURRENCY) {
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
}
function publicFormatDate(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}
function publicFormatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

async function publicQrDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, color: { dark: '#111827', light: '#ffffff' } });
}

function publicTemplateCss(theme) {
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
    body { margin: 0; padding: 24px; background: #eef2f7; color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .voucher { max-width: 980px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.14); border: 1px solid rgba(148, 163, 184, 0.18); }
    .hero { background: linear-gradient(135deg, var(--accent) 0%, #1e293b 100%); color: white; padding: 28px 32px; display: grid; grid-template-columns: 1.3fr 0.7fr; gap: 20px; align-items: start; }
    .brand-title { font-size: 28px; font-weight: 800; line-height: 1.1; margin-bottom: 10px; letter-spacing: -0.02em; }
    .doc-card { background: rgba(255,255,255,0.14); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.18); border-radius: 20px; padding: 18px 20px; }
    .doc-type { font-size: 12px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.8; margin-bottom: 10px; }
    .doc-number { font-size: 28px; font-weight: 800; line-height: 1.1; margin-bottom: 12px; }
    .content { padding: 28px 32px 18px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 20px; }
    .box { border: 1px solid var(--line); border-radius: 18px; background: var(--panel); padding: 18px; }
    .section-title { display: inline-flex; align-items: center; gap: 8px; color: var(--accent); font-weight: 800; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; }
    .items-wrap { border: 1px solid var(--line); border-radius: 20px; overflow: hidden; margin-bottom: 20px; }
    .items { width: 100%; border-collapse: collapse; background: white; }
    .items thead th { background: var(--accent-soft); color: var(--accent); text-align: left; padding: 14px 16px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
    .items tbody td { padding: 14px 16px; border-top: 1px solid var(--line); vertical-align: top; }
    .items tbody tr:nth-child(even) td { background: var(--panel); }
    .item-name { font-weight: 700; }
    .item-sku { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .totals-area { display: grid; grid-template-columns: 1fr minmax(280px, 360px); gap: 18px; align-items: start; margin-bottom: 24px; }
    .summary-pill { border: 1px solid var(--line); padding: 12px 14px; border-radius: 999px; background: white; font-weight: 600; color: var(--muted); }
    .summary-pills { display: flex; flex-wrap: wrap; gap: 10px; }
    .totals { border: 1px solid var(--line); border-radius: 18px; overflow: hidden; background: white; }
    .totals table { width: 100%; border-collapse: collapse; }
    .totals td { padding: 14px 16px; border-top: 1px solid var(--line); font-size: 14px; }
    .totals tr:first-child td { border-top: none; }
    .totals td:last-child { text-align: right; font-weight: 700; }
    .totals .grand td { background: var(--accent); color: white; font-size: 18px; }
    .footer { display: grid; grid-template-columns: 140px 1fr; gap: 18px; border-top: 1px solid var(--line); padding: 24px 32px 32px; align-items: start; }
    .qr-box { border: 1px solid var(--line); border-radius: 16px; background: white; padding: 10px; text-align: center; }
    .qr-box img { width: 100%; max-width: 120px; display: block; margin: 0 auto 8px; }
    .legal { color: var(--muted); line-height: 1.7; font-size: 14px; }
    .legal strong { color: var(--ink); }
    @media (max-width: 840px) { body { padding: 10px; } .hero, .grid, .totals-area, .footer { grid-template-columns: 1fr; } .content, .hero, .footer { padding-left: 18px; padding-right: 18px; } .doc-number { font-size: 24px; } .brand-title { font-size: 24px; } .items-wrap { overflow-x: auto; } .items { min-width: 720px; } }
  `;
}

async function renderPublicVoucherHtml(data) {
  const { template, issuer, customer, numbering, items, subtotal, tax, total, notes, paymentMethod, documentType, currency, taxRate, pricesIncludeTax, qrContent, issueDate } = data;
  const qrDataUrl = await publicQrDataUrl(qrContent);
  const title = documentType === 'factura' ? 'Factura electrónica' : 'Boleta de venta';
  const paymentLabel = paymentMethod || 'Pago único';

  const rows = items.map((item) => `
    <tr>
      <td>${item.index}</td>
      <td>
        <div class="item-name">${publicEscapeHtml(item.description)}</div>
        ${item.sku ? `<div class="item-sku">SKU: ${publicEscapeHtml(item.sku)}</div>` : ''}
      </td>
      <td>${publicEscapeHtml(item.unitLabel)}</td>
      <td>${item.quantity}</td>
      <td>${publicFormatMoney(item.unitTotal, currency)}</td>
      <td>${publicFormatMoney(item.total, currency)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${publicEscapeHtml(title)} ${publicEscapeHtml(numbering.full)}</title>
<style>${publicTemplateCss(template.theme)}</style>
</head>
<body>
<article class="voucher">
  <header class="hero">
    <div>
      ${issuer.logoDataUrl ? `<img src="${issuer.logoDataUrl}" alt="Logo" style="max-width:96px;max-height:96px;border-radius:12px;background:#fff;padding:6px;margin-bottom:12px;object-fit:contain;" />` : ''}
      <div class="brand-title">${publicEscapeHtml(issuer.businessName)}</div>
      <div style="font-size:14px;opacity:.96;">
        ${issuer.documentNumber ? `<div><strong>Documento:</strong> ${publicEscapeHtml(issuer.documentNumber)}</div>` : ''}
        ${issuer.address ? `<div><strong>Dirección:</strong> ${publicEscapeHtml(issuer.address)}</div>` : ''}
        ${issuer.phone ? `<div><strong>Teléfono:</strong> ${publicEscapeHtml(issuer.phone)}</div>` : ''}
        ${issuer.email ? `<div><strong>Email:</strong> ${publicEscapeHtml(issuer.email)}</div>` : ''}
        ${issuer.website ? `<div><strong>Web:</strong> ${publicEscapeHtml(issuer.website)}</div>` : ''}
      </div>
    </div>
    <div class="doc-card">
      <div class="doc-type">${publicEscapeHtml(title)}</div>
      <div class="doc-number">${publicEscapeHtml(numbering.full)}</div>
      <div style="font-size:14px;opacity:.96;">
        <div><strong>Fecha:</strong> ${publicEscapeHtml(publicFormatDateTime(issueDate))}</div>
        <div><strong>Moneda:</strong> ${publicEscapeHtml(currency)}</div>
        <div><strong>Plantilla:</strong> ${publicEscapeHtml(template.name)}</div>
        <div><strong>Pago:</strong> ${publicEscapeHtml(paymentLabel)}</div>
      </div>
    </div>
  </header>
  <section class="content">
    <div class="grid">
      <div class="box">
        <div class="section-title">Cliente</div>
        <div><strong>Nombre:</strong> ${publicEscapeHtml(customer.name)}</div>
        <div><strong>${publicEscapeHtml(customer.documentType || 'Documento')}:</strong> ${publicEscapeHtml(customer.documentNumber || '-')}</div>
        ${customer.email ? `<div><strong>Email:</strong> ${publicEscapeHtml(customer.email)}</div>` : ''}
        ${customer.phone ? `<div><strong>Teléfono:</strong> ${publicEscapeHtml(customer.phone)}</div>` : ''}
        ${customer.address ? `<div><strong>Dirección:</strong> ${publicEscapeHtml(customer.address)}</div>` : ''}
      </div>
      <div class="box">
        <div class="section-title">Resumen comercial</div>
        <div><strong>Operación gravada:</strong> ${publicFormatMoney(subtotal, currency)}</div>
        <div><strong>IGV (${(taxRate * 100).toFixed(0)}%):</strong> ${publicFormatMoney(tax, currency)}</div>
        <div><strong>Total:</strong> ${publicFormatMoney(total, currency)}</div>
        <div><strong>Precios ingresados:</strong> ${pricesIncludeTax ? 'con IGV incluido' : 'sin IGV'}</div>
      </div>
    </div>
    <div class="items-wrap">
      <table class="items">
        <thead>
          <tr>
            <th>#</th><th>Descripción</th><th>Unidad</th><th>Cantidad</th>
            <th>P. unitario</th><th>Importe</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="totals-area">
      <div>
        <div class="summary-pills">
          <div class="summary-pill">${items.length} ítem(s)</div>
          <div class="summary-pill">${publicEscapeHtml(documentType === 'factura' ? 'Factura apta para venta empresarial' : 'Boleta apta para venta rápida')}</div>
          <div class="summary-pill">Plantilla ${publicEscapeHtml(template.name)}</div>
        </div>
        <div style="margin-top:16px;">
          ${notes
            ? `<div class="box"><strong>Observaciones:</strong><br/>${publicEscapeHtml(notes)}</div>`
            : '<div class="box" style="font-size:14px;">Puedes añadir observaciones, condiciones comerciales o mensaje de agradecimiento.</div>'}
        </div>
      </div>
      <div class="totals">
        <table>
          <tr><td>Subtotal</td><td>${publicFormatMoney(subtotal, currency)}</td></tr>
          <tr><td>IGV (${(taxRate * 100).toFixed(0)}%)</td><td>${publicFormatMoney(tax, currency)}</td></tr>
          <tr class="grand"><td>Total a pagar</td><td>${publicFormatMoney(total, currency)}</td></tr>
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
      Documento generado mediante la API pública de FacilitoTools.<br/><br/>
      <strong>Cadena QR:</strong> ${publicEscapeHtml(qrContent)}
    </div>
  </footer>
</article>
</body>
</html>`;
}

function _publicDrawText(doc, text, x, y, options = {}) { doc.text(String(text ?? ''), x, y, options); }
function _publicDrawLabelValue(doc, label, value, x, y, width) {
  doc.font('Helvetica-Bold').fillColor('#0f172a').fontSize(9).text(label, x, y, { width });
  doc.font('Helvetica').fillColor('#334155').text(value || '-', x, y + 14, { width });
}
function _publicEnsureSpace(doc, y, neededHeight = 80) {
  if (y + neededHeight > doc.page.height - 60) { doc.addPage(); return 50; }
  return y;
}
async function buildPublicPdfBuffer(data, plan = 'gratis') {
  const { template, issuer, customer, numbering, items, subtotal, tax, total, notes, paymentMethod, documentType, currency, taxRate, qrContent, issueDate, pricesIncludeTax } = data;
  const theme = template.theme;
  const qrDataUrl = await publicQrDataUrl(qrContent);
  const title = documentType === 'factura' ? 'FACTURA ELECTRÓNICA' : 'BOLETA DE VENTA';
  const esGratuito = plan === 'gratis';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.save();

    if (esGratuito) {
      doc.fontSize(60).fillColor('#cccccc').opacity(0.2)
        .text('FacilitoTools', 150, 400, { align: 'center', angle: -30 })
        .opacity(1);
    }

    const issuerMetaLines = [
      issuer.documentNumber ? `Documento: ${issuer.documentNumber}` : '',
      issuer.address ? `Dirección: ${issuer.address}` : '',
      issuer.phone ? `Teléfono: ${issuer.phone}` : '',
      issuer.email ? `Email: ${issuer.email}` : ''
    ].filter(Boolean);
    const heroTop = 40;
    const heroTitleY = 60;
    const heroLineHeight = 13;
    const heroTitleToMetaGap = 10;
    const heroBottomPadding = 20;
    const heroMinHeight = 90;
    let issuerTextX = 60, issuerTextWidth = 280;
    if (issuer.logoDataUrl) { issuerTextX = 128; issuerTextWidth = 210; }
    doc.font('Helvetica-Bold').fontSize(20);
    const businessNameHeight = doc.heightOfString(issuer.businessName, { width: issuerTextWidth });
    const heroMetaStartY = heroTitleY + businessNameHeight + heroTitleToMetaGap;
    const heroHeight = Math.max(heroMinHeight, (heroMetaStartY - heroTop) + issuerMetaLines.length * heroLineHeight + heroBottomPadding);
    doc.roundedRect(40, heroTop, 515, heroHeight, 18).fill(theme.accent);
    if (issuer.logoDataUrl) {
      try {
        doc.roundedRect(55, 55, 60, 60, 12).fillOpacity(0.16).fillAndStroke('#ffffff', '#ffffff').fillOpacity(1);
        doc.image(issuer.logoDataUrl, 60, 60, { fit: [50, 50], align: 'center', valign: 'center' });
      } catch (_) {}
    }
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text(issuer.businessName, issuerTextX, heroTitleY, { width: issuerTextWidth });
    doc.font('Helvetica').fontSize(9);
    let issuerMetaY = heroMetaStartY;
    issuerMetaLines.forEach((line) => { doc.text(line, issuerTextX, issuerMetaY, { width: 260 }); issuerMetaY += heroLineHeight; });
    doc.roundedRect(350, 55, 180, 60, 14).fillOpacity(0.12).fillAndStroke('#ffffff', '#ffffff').fillOpacity(1);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(title, 365, 68, { width: 150, align: 'center' });
    doc.fontSize(18).text(numbering.full, 365, 84, { width: 150, align: 'center' });

    const infoBoxTop = heroTop + heroHeight + 20;
    const infoBoxRowGap = 30, infoBoxFirstRowOffset = 35, infoBoxRowBlockHeight = 25, infoBoxBottomPadding = 20;
    const infoBoxHeight = infoBoxFirstRowOffset + 2 * infoBoxRowGap + infoBoxRowBlockHeight + infoBoxBottomPadding;
    doc.roundedRect(40, infoBoxTop, 250, infoBoxHeight, 14).fill(theme.panel).stroke(theme.line);
    doc.roundedRect(305, infoBoxTop, 250, infoBoxHeight, 14).fill(theme.panel).stroke(theme.line);
    const infoBoxTitleY = infoBoxTop + 15;
    const infoBoxRow1Y = infoBoxTop + infoBoxFirstRowOffset;
    const infoBoxRow2Y = infoBoxRow1Y + infoBoxRowGap;
    const infoBoxRow3Y = infoBoxRow2Y + infoBoxRowGap;
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(10).text('DATOS DEL CLIENTE', 55, infoBoxTitleY);
    _publicDrawLabelValue(doc, 'Nombre', customer.name, 55, infoBoxRow1Y, 210);
    _publicDrawLabelValue(doc, customer.documentType || 'Documento', customer.documentNumber || '-', 55, infoBoxRow2Y, 210);
    _publicDrawLabelValue(doc, 'Email', customer.email || '-', 55, infoBoxRow3Y, 210);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(10).text('DETALLE DE EMISIÓN', 320, infoBoxTitleY);
    _publicDrawLabelValue(doc, 'Fecha', publicFormatDateTime(issueDate), 320, infoBoxRow1Y, 210);
    _publicDrawLabelValue(doc, 'Plantilla', template.name, 320, infoBoxRow2Y, 210);
    _publicDrawLabelValue(doc, 'Pago', paymentMethod || 'Pago único', 320, infoBoxRow3Y, 210);

    let y = infoBoxTop + infoBoxHeight + 27;
    doc.roundedRect(40, y, 515, 28, 10).fill(theme.accentSoft);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9);
    const columns = { index: 50, desc: 78, unit: 320, qty: 380, unitPrice: 430, amount: 495 };
    _publicDrawText(doc, '#', columns.index, y + 9);
    _publicDrawText(doc, 'DESCRIPCIÓN', columns.desc, y + 9);
    _publicDrawText(doc, 'UND', columns.unit, y + 9);
    _publicDrawText(doc, 'CANT', columns.qty, y + 9);
    _publicDrawText(doc, 'P. UNIT', columns.unitPrice, y + 9);
    _publicDrawText(doc, 'IMPORTE', columns.amount, y + 9);
    y += 38;

    items.forEach((item) => {
      const descHeight = doc.heightOfString(item.description, { width: 220, align: 'left' });
      const rowHeight = Math.max(26, descHeight + 10);
      y = _publicEnsureSpace(doc, y, rowHeight + 20);
      doc.roundedRect(40, y - 4, 515, rowHeight, 10).fillOpacity(0.08).fill(theme.panelStrong).fillOpacity(1);
      doc.fillColor(theme.ink).font('Helvetica').fontSize(9);
      _publicDrawText(doc, item.index, columns.index, y + 6);
      _publicDrawText(doc, item.description, columns.desc, y + 6, { width: 220 });
      _publicDrawText(doc, item.unitLabel, columns.unit, y + 6);
      _publicDrawText(doc, item.quantity, columns.qty, y + 6);
      _publicDrawText(doc, publicFormatMoney(item.unitTotal, currency), columns.unitPrice, y + 6);
      _publicDrawText(doc, publicFormatMoney(item.total, currency), columns.amount, y + 6);
      y += rowHeight + 8;
    });

    y += 10;
    y = _publicEnsureSpace(doc, y, 160);
    doc.roundedRect(40, y, 235, 110, 14).fill(theme.panel).stroke(theme.line);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(10).text('OBSERVACIONES', 55, y + 15);
    doc.font('Helvetica').fillColor(theme.ink).fontSize(9).text(notes || 'Puedes usar este espacio para garantía, condiciones, método de entrega o agradecimiento al cliente.', 55, y + 34, { width: 205, align: 'left' });
    doc.roundedRect(300, y, 255, 110, 14).fill('#ffffff').stroke(theme.line);
    doc.fillColor(theme.ink).font('Helvetica').fontSize(10);
    doc.text('Subtotal', 318, y + 20);
    doc.font('Helvetica-Bold').text(publicFormatMoney(subtotal, currency), 455, y + 20, { width: 80, align: 'right' });
    doc.font('Helvetica').text(`IGV (${(taxRate * 100).toFixed(0)}%)`, 318, y + 45);
    doc.font('Helvetica-Bold').text(publicFormatMoney(tax, currency), 455, y + 45, { width: 80, align: 'right' });
    doc.roundedRect(315, y + 72, 225, 26, 10).fill(theme.accent);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text('TOTAL', 330, y + 80);
    doc.text(publicFormatMoney(total, currency), 430, y + 80, { width: 95, align: 'right' });

    y += 135;
    y = _publicEnsureSpace(doc, y, 130);
    doc.roundedRect(40, y, 100, 100, 14).fill('#ffffff').stroke(theme.line);
    doc.image(qrDataUrl, 50, y + 10, { width: 80 });
    doc.roundedRect(155, y, 400, 100, 14).fill(theme.panel).stroke(theme.line);
    doc.fillColor(theme.ink).font('Helvetica-Bold').fontSize(9).text('Representación profesional del comprobante', 170, y + 16);
    doc.font('Helvetica').fillColor('#475569').fontSize(8).text(
      `Documento: ${title} · ${numbering.full}\n` +
      `QR: ${qrContent}\n` +
      `Precios ${pricesIncludeTax ? 'con' : 'sin'} IGV incluido. Pago: ${paymentMethod || 'Pago único'}.\n` +
      `Documento generado mediante la API pública de FacilitoTools.`,
      170, y + 34, { width: 370, lineGap: 2 }
    );
    doc.restore();
    doc.end();
  });
}

export default developerApiRouter;
