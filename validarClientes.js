// ================================================================
// 🛡️ VALIDAR CLIENTES — Router seguro (DNI, RUC, Cédula, Teléfonos)
// ================================================================
// Este módulo expone endpoints backend que actúan como PROXY hacia
// APISPERU (DNI/RUC) y MASITAPREX (cédula, búsquedas, telefonía).
//
// - Los tokens (TOKEN_APISPERU, TOKEN_MASITAPREX) viven SOLO en el
//   servidor (variables de entorno / secrets). Nunca se envían al navegador.
// - Cada request exige sesión activa (cookie httpOnly user_uid, la
//   misma que usa el resto de la app) y se asocia siempre al uid real.
// - Cada consulta descuenta cupo del plan del usuario en Firestore
//   ANTES de llamar a la API externa (transacción atómica), de forma
//   que nadie pueda "saltarse" la interfaz y consumir gratis.
// - Incluye un rate-limit por usuario como defensa adicional contra
//   ráfagas/abuso, además del límite de plan.
//
// Cómo integrarlo en index.js:
//
//   import validarClientesRouter, { setDb as setValidarClientesDb } from './validarClientes.js';
//   ...
//   initFirebase(serviceAccount).then(() => {
//     setPlantillasDb(db);
//     setValidarClientesDb(db);   // <-- agregar esta línea
//   })...
//   ...
//   app.use('/api/validar', validarClientesRouter);
//
// Variables de entorno requeridas:
//   TOKEN_APISPERU        -> token JWT de apisperu.com (DNI y RUC)
//   TOKEN_MASITAPREX      -> token/API key de masitaprex.com
//   MASITAPREX_AUTH_HEADER (opcional, por defecto "Authorization")
//   MASITAPREX_AUTH_SCHEME (opcional, por defecto "Bearer")
//     -> Si en https://masitaprex.com/API-Docs.html el token se envía
//        de otra forma (p.ej. header "x-api-key" sin esquema), ajusta
//        estas dos variables sin tocar el código.
// ================================================================

import express from 'express';
import admin from 'firebase-admin';
import { logger, getClientIp } from './seguridad.js';

const router = express.Router();

// Instancia de Firestore, inyectada desde index.js
let db = null;
export function setDb(database) {
  db = database;
}

// ----------------------------------------------------------------
// 🔑 Tokens y configuración de terceros (SOLO backend)
// ----------------------------------------------------------------
const TOKEN_APISPERU = process.env.TOKEN_APISPERU || '';
const TOKEN_MASITAPREX = process.env.TOKEN_MASITAPREX || '';
const MASITAPREX_AUTH_HEADER = process.env.MASITAPREX_AUTH_HEADER || 'Authorization';
const MASITAPREX_AUTH_SCHEME = process.env.MASITAPREX_AUTH_SCHEME !== undefined
  ? process.env.MASITAPREX_AUTH_SCHEME
  : 'Bearer';

const APISPERU_BASE = 'https://dniruc.apisperu.com/api/v1';
const MASITAPREX_BASE = 'https://api.masitaprex.com/v3';

function masitaprexHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN_MASITAPREX) {
    headers[MASITAPREX_AUTH_HEADER] = MASITAPREX_AUTH_SCHEME
      ? `${MASITAPREX_AUTH_SCHEME} ${TOKEN_MASITAPREX}`.trim()
      : TOKEN_MASITAPREX;
  }
  return headers;
}

// ----------------------------------------------------------------
// 🚦 Rate limit simple por usuario (defensa adicional en memoria)
// ----------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const RATE_LIMIT_MAX = 20; // máx. 20 consultas/minuto por usuario
const rateBuckets = new Map();

function isRateLimited(uid) {
  const now = Date.now();
  const bucket = rateBuckets.get(uid) || [];
  const fresh = bucket.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  fresh.push(now);
  rateBuckets.set(uid, fresh);
  return fresh.length > RATE_LIMIT_MAX;
}

// Limpieza periódica del mapa de rate-limit para no acumular memoria
setInterval(() => {
  const now = Date.now();
  for (const [uid, bucket] of rateBuckets.entries()) {
    const fresh = bucket.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateBuckets.delete(uid);
    else rateBuckets.set(uid, fresh);
  }
}, 5 * 60 * 1000).unref?.();

// ----------------------------------------------------------------
// 🔒 Middleware de autenticación (misma cookie httpOnly que el resto de la app)
// ----------------------------------------------------------------
async function requireAuth(req, res, next) {
  const context = 'VALIDAR_CLIENTES_AUTH';
  try {
    const uid = req.cookies?.user_uid || null;
    if (!uid) {
      return res.status(401).json({ success: false, error: 'Debes iniciar sesión para validar clientes.' });
    }
    if (!db) {
      return res.status(503).json({ success: false, error: 'Servicio no disponible en este momento.' });
    }

    if (isRateLimited(uid)) {
      logger.warn(context, 'Rate limit alcanzado', { uid, ip: getClientIp(req) });
      return res.status(429).json({ success: false, error: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.' });
    }

    const userRef = db.collection('usuarios').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(401).json({ success: false, error: 'Cuenta no encontrada. Vuelve a iniciar sesión.' });
    }

    req.uid = uid;
    req.userRef = userRef;
    req.userData = userDoc.data();
    next();
  } catch (error) {
    logger.error(context, 'Error verificando autenticación', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
}

// ----------------------------------------------------------------
// 💳 Control de cupo (transacción atómica en Firestore)
// campo: 'consultas'          -> DNI, RUC, Cédula, búsquedas por nombre
// campo: 'consultasTelefonos' -> telefonía por documento / por número
// ----------------------------------------------------------------
async function consumirCupo(userRef, tipo) {
  const limiteField = tipo === 'telefono' ? 'consultasTelefonosLimite' : 'consultasLimite';
  const consumidasField = tipo === 'telefono' ? 'consultasTelefonosConsumidas' : 'consultasConsumidas';

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) {
      const err = new Error('Usuario no encontrado.');
      err.statusCode = 401;
      throw err;
    }
    const data = doc.data();
    const limite = data[limiteField] ?? 0;
    const consumidas = Number(data[consumidasField] || 0);

    // limite === -1 significa "ilimitado" (igual que en el resto de la app)
    if (limite !== -1 && consumidas >= limite) {
      const err = new Error('Has alcanzado el límite de consultas de tu plan. Mejora tu plan para continuar.');
      err.statusCode = 403;
      err.code = 'LIMIT_REACHED';
      throw err;
    }

    tx.update(userRef, { [consumidasField]: admin.firestore.FieldValue.increment(1) });
    return {
      limite,
      consumidas: consumidas + 1,
      disponibles: limite === -1 ? 'Ilimitados' : Math.max(limite - (consumidas + 1), 0)
    };
  });
}

// Revertir el cupo si la API externa falla, para no cobrarle al usuario una consulta fallida
async function revertirCupo(userRef, tipo) {
  const consumidasField = tipo === 'telefono' ? 'consultasTelefonosConsumidas' : 'consultasConsumidas';
  try {
    await userRef.update({ [consumidasField]: admin.firestore.FieldValue.increment(-1) });
  } catch (_) { /* si falla la reversión, no bloqueamos la respuesta original */ }
}

// ----------------------------------------------------------------
// 🧰 Helper genérico para ejecutar una consulta con control de cupo
// ----------------------------------------------------------------
async function ejecutarConsulta({ req, res, tipo, contexto, fetchFn }) {
  let cupoInfo = null;
  try {
    cupoInfo = await consumirCupo(req.userRef, tipo);
  } catch (error) {
    const status = error.statusCode || 500;
    logger.warn(contexto, 'Cupo no disponible', { uid: req.uid, error: error.message });
    return res.status(status).json({ success: false, error: error.message, code: error.code });
  }

  try {
    const resultado = await fetchFn();
    logger.info(contexto, 'Consulta realizada', { uid: req.uid, ip: getClientIp(req) });
    return res.json({ success: true, data: resultado, cupo: cupoInfo });
  } catch (error) {
    // La consulta al proveedor externo falló: devolvemos el cupo consumido
    await revertirCupo(req.userRef, tipo);
    logger.error(contexto, 'Error consultando proveedor externo', { uid: req.uid, message: error.message });
    const status = error.statusCode || 502;
    return res.status(status).json({
      success: false,
      error: error.publicMessage || 'No se pudo completar la consulta. Intenta nuevamente en unos segundos.'
    });
  }
}

async function callExternal(url, options, providerName) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch (netError) {
    const err = new Error(`Error de red al contactar ${providerName}: ${netError.message}`);
    err.publicMessage = 'El servicio de validación no respondió a tiempo. Intenta de nuevo.';
    throw err;
  }

  let body = null;
  try { body = await response.json(); } catch (_) { /* respuesta no-JSON */ }

  if (!response.ok) {
    const err = new Error(`${providerName} respondió ${response.status}`);
    err.statusCode = response.status === 404 ? 404 : 502;
    err.publicMessage = body?.message || body?.error ||
      (response.status === 404 ? 'No se encontraron resultados para el dato ingresado.' : 'El servicio externo no está disponible en este momento.');
    throw err;
  }
  return body;
}

// ================================================================
// 📄 DNI — APISPERU
// ================================================================
router.get('/dni/:dni', requireAuth, async (req, res) => {
  const dni = String(req.params.dni || '').trim();
  if (!/^\d{8}$/.test(dni)) {
    return res.status(400).json({ success: false, error: 'El DNI debe tener 8 dígitos numéricos.' });
  }
  if (!TOKEN_APISPERU) {
    return res.status(500).json({ success: false, error: 'Servicio de validación de DNI no configurado.' });
  }

  await ejecutarConsulta({
    req, res, tipo: 'documento', contexto: 'VALIDAR_DNI',
    fetchFn: () => callExternal(
      `${APISPERU_BASE}/dni/${dni}?token=${encodeURIComponent(TOKEN_APISPERU)}`,
      { method: 'GET' },
      'APISPERU (DNI)'
    )
  });
});

// ================================================================
// 🏢 RUC — APISPERU
// ================================================================
router.get('/ruc/:ruc', requireAuth, async (req, res) => {
  const ruc = String(req.params.ruc || '').trim();
  if (!/^\d{11}$/.test(ruc)) {
    return res.status(400).json({ success: false, error: 'El RUC debe tener 11 dígitos numéricos.' });
  }
  if (!TOKEN_APISPERU) {
    return res.status(500).json({ success: false, error: 'Servicio de validación de RUC no configurado.' });
  }

  await ejecutarConsulta({
    req, res, tipo: 'documento', contexto: 'VALIDAR_RUC',
    fetchFn: () => callExternal(
      `${APISPERU_BASE}/ruc/${ruc}?token=${encodeURIComponent(TOKEN_APISPERU)}`,
      { method: 'GET' },
      'APISPERU (RUC)'
    )
  });
});

// ================================================================
// 🇻🇪 Cédula venezolana — MASITAPREX
// ================================================================
router.post('/cedula', requireAuth, async (req, res) => {
  const cedula = String(req.body?.cedula || '').trim().toUpperCase();
  if (!/^[VE]?-?\d{5,9}$/.test(cedula)) {
    return res.status(400).json({ success: false, error: 'Ingresa una cédula válida (ej: V12345678).' });
  }
  if (!TOKEN_MASITAPREX) {
    return res.status(500).json({ success: false, error: 'Servicio de validación de cédula no configurado.' });
  }

  await ejecutarConsulta({
    req, res, tipo: 'documento', contexto: 'VALIDAR_CEDULA',
    fetchFn: () => callExternal(
      `${MASITAPREX_BASE}/consulta/cedula`,
      { method: 'POST', headers: masitaprexHeaders(), body: JSON.stringify({ cedula }) },
      'Masitaprex (Cédula)'
    )
  });
});

// ================================================================
// 🔎 Buscar cédula venezolana por nombre — MASITAPREX
// ================================================================
router.post('/buscar-cedula', requireAuth, async (req, res) => {
  const query = String(req.body?.query || '').trim();
  if (query.length < 3) {
    return res.status(400).json({ success: false, error: 'Ingresa nombres y apellidos completos (mínimo 3 caracteres).' });
  }
  if (!TOKEN_MASITAPREX) {
    return res.status(500).json({ success: false, error: 'Servicio de búsqueda no configurado.' });
  }

  await ejecutarConsulta({
    req, res, tipo: 'documento', contexto: 'BUSCAR_CEDULA',
    fetchFn: () => callExternal(
      `${MASITAPREX_BASE}/consulta/buscar-cedula`,
      { method: 'POST', headers: masitaprexHeaders(), body: JSON.stringify({ query }) },
      'Masitaprex (Buscar cédula)'
    )
  });
});

// ================================================================
// 🔎 Buscar DNI por nombres — MASITAPREX
// ================================================================
router.post('/buscar-dni', requireAuth, async (req, res) => {
  const nombres = String(req.body?.nombres || '').trim();
  const apepaterno = String(req.body?.apepaterno || '').trim();
  const apematerno = String(req.body?.apematerno || '').trim();

  if (nombres.length < 2 || apepaterno.length < 2) {
    return res.status(400).json({ success: false, error: 'Ingresa al menos nombres y apellido paterno.' });
  }
  if (!TOKEN_MASITAPREX) {
    return res.status(500).json({ success: false, error: 'Servicio de búsqueda no configurado.' });
  }

  await ejecutarConsulta({
    req, res, tipo: 'documento', contexto: 'BUSCAR_DNI',
    fetchFn: () => callExternal(
      `${MASITAPREX_BASE}/consulta/buscar-dni`,
      {
        method: 'POST',
        headers: masitaprexHeaders(),
        body: JSON.stringify({ nombres, apepaterno, ...(apematerno ? { apematerno } : {}) })
      },
      'Masitaprex (Buscar DNI)'
    )
  });
});

// ================================================================
// ☎️ Telefonía por documento (DNI/RUC) — MASITAPREX
// ================================================================
router.post('/telefonia-doc', requireAuth, async (req, res) => {
  const documento = String(req.body?.documento || '').trim();
  if (!/^\d{8}$|^\d{11}$/.test(documento)) {
    return res.status(400).json({ success: false, error: 'Ingresa un DNI (8 dígitos) o RUC (11 dígitos) válido.' });
  }
  if (!TOKEN_MASITAPREX) {
    return res.status(500).json({ success: false, error: 'Servicio de telefonía no configurado.' });
  }

  await ejecutarConsulta({
    req, res, tipo: 'telefono', contexto: 'TELEFONIA_DOC',
    fetchFn: () => callExternal(
      `${MASITAPREX_BASE}/consulta/telefonia-doc`,
      { method: 'POST', headers: masitaprexHeaders(), body: JSON.stringify({ documento }) },
      'Masitaprex (Telefonía por documento)'
    )
  });
});

// ================================================================
// ☎️ Telefonía por número — MASITAPREX
// ================================================================
router.post('/telefonia-numero', requireAuth, async (req, res) => {
  const numero = String(req.body?.numero || '').trim();
  if (!/^\d{9}$/.test(numero)) {
    return res.status(400).json({ success: false, error: 'Ingresa un número telefónico de 9 dígitos.' });
  }
  if (!TOKEN_MASITAPREX) {
    return res.status(500).json({ success: false, error: 'Servicio de telefonía no configurado.' });
  }

  await ejecutarConsulta({
    req, res, tipo: 'telefono', contexto: 'TELEFONIA_NUMERO',
    fetchFn: () => callExternal(
      `${MASITAPREX_BASE}/consulta/telefonia-numero`,
      { method: 'POST', headers: masitaprexHeaders(), body: JSON.stringify({ numero }) },
      'Masitaprex (Telefonía por número)'
    )
  });
});

// ================================================================
// 📊 Estado de cupo (para pintar la UI antes de consultar)
// ================================================================
router.get('/cupo', requireAuth, async (req, res) => {
  const data = req.userData || {};
  const consultasLimite = data.consultasLimite ?? 0;
  const consultasConsumidas = Number(data.consultasConsumidas || 0);
  const consultasTelefonosLimite = data.consultasTelefonosLimite ?? 0;
  const consultasTelefonosConsumidas = Number(data.consultasTelefonosConsumidas || 0);

  res.json({
    success: true,
    consultas: {
      limite: consultasLimite,
      consumidas: consultasConsumidas,
      disponibles: consultasLimite === -1 ? 'Ilimitados' : Math.max(consultasLimite - consultasConsumidas, 0)
    },
    telefonos: {
      limite: consultasTelefonosLimite,
      consumidas: consultasTelefonosConsumidas,
      disponibles: consultasTelefonosLimite === -1 ? 'Ilimitados' : Math.max(consultasTelefonosLimite - consultasTelefonosConsumidas, 0)
    }
  });
});

export default router;
