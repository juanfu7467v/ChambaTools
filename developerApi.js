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
  normalizePayload as publicNormalizePayload,
  renderVoucherHtml,
  buildPdfBuffer,
  incrementarRecibos
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
    const html = await renderVoucherHtml(normalized, auth.tipoPlan);
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

    // Reutilizar exactamente el mismo renderizador PDF de la interfaz web.
    const pdfBuffer = await buildPdfBuffer(normalized, data.tipoPlan);

    // Incrementar contador
    await incrementarRecibos(auth.uid);

    const filename = `${normalized.documentType}_${normalized.numbering.full}.pdf`.replace(/\s+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error(ctx, error);
    res.status(500).json({ ok: false, error: error.message || 'Error generando el PDF.' });
  }
});

// El renderizador y el consumo se reutilizan directamente desde plantillas.js
export default developerApiRouter;
