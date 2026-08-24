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
//   TOKEN_MASITAPREX      -> API key de masitaprex.com
//   MASITAPREX_AUTH_HEADER (opcional, por defecto "x-api-key")
//   MASITAPREX_AUTH_SCHEME (opcional, por defecto "" -> sin prefijo)
//     -> Según https://masitaprex.com/API-Docs.html, el token se envía
//        SIEMPRE como header "x-api-key: TU_TOKEN" (sin "Bearer" ni
//        ningún otro prefijo). Ajusta estas variables sólo si Masitaprex
//        cambia su esquema de autenticación en el futuro.
//   VALIDAR_CLIENTES_TIMEOUT_MS (opcional, por defecto 60000)
//     -> Tanto APISPERU como Masitaprex pueden tardar hasta ~50s en
//        responder en consultas pesadas (huellas, firma, cruces de
//        RENIEC/SUNAT, etc). El timeout debe ser siempre mayor a ese
//        margen para no cortar respuestas válidas antes de tiempo.
// ================================================================
//
// 🐞 BUGS CORREGIDOS EN ESTA REVISIÓN (causaban resultados vacíos):
//
// 1) Auth header incorrecto: Masitaprex exige "x-api-key: TOKEN" (documentado
//    en API-Docs.html). El código enviaba "Authorization: Bearer TOKEN" por
//    defecto, lo que provocaba 401 en TODAS las consultas de Masitaprex
//    (cédula, buscar-cedula, buscar-dni, telefonia-doc, telefonia-numero).
//
// 2) Ruta equivocada para "Telefonía por número": el endpoint real es
//    /v3/consulta/telefonia-num (sin "ero"), no /v3/consulta/telefonia-numero.
//    Esto causaba 404 en esa consulta específica.
//
// 3) Doble anidado de "data": Masitaprex devuelve siempre
//    { success: true, data: { ...campos reales... }, meta: {...} }.
//    El proxy reenviaba el "body" completo (con su success/data propios)
//    dentro de otro { success: true, data: body }, así que el frontend
//    terminaba leyendo "data.cedula" en vez de "data.data.cedula" y
//    todos los campos llegaban "undefined" -> tarjetas vacías.
//    Ahora se desenvuelve automáticamente el "data" interno de Masitaprex
//    antes de responder al navegador (ver unwrapProviderBody). APISPERU
//    (DNI/RUC) no usa este formato, así que no se ve afectado.
//
// 4) Timeout de 15s demasiado corto: las APIs externas pueden tardar hasta
//    ~50s. Un timeout tan corto abortaba la petición antes de tiempo,
//    devolviendo error justo cuando la respuesta real venía en camino.
//    Se sube a 60s (configurable) + 1 reintento automático ante fallos de
//    red/timeout.
//
// 5) Tokens sin "trim()": TOKEN_APISPERU y TOKEN_MASITAPREX se usaban tal
//    cual llegaban de las variables de entorno. Un espacio o salto de línea
//    de más en el secret (común al copiar/pegar o al setearlo con
//    "fly secrets set" desde archivo) invalida el token silenciosamente:
//    la API responde HTTP 200 con success:false en vez de un 401 explícito.
//    Esto coincide exactamente con el log real observado en producción:
//    "[ERROR] [VALIDAR_DNI] Error consultando proveedor externo Error:
//    APISPERU (DNI) devolvió success:false - Stack: undefined". Se corrige
//    aplicando .trim() a ambos tokens (igual que ya se hacía con el token de
//    Mercado Pago en index.js) y se agrega un log de arranque que confirma
//    si el token quedó cargado y con qué longitud (nunca su valor).
//
// 6) Logging insuficiente ante success:false: el mensaje real devuelto por
//    el proveedor (ej. "Token inválido o vencido") se descartaba y solo se
//    logueaba el texto genérico "devolvió success:false", haciendo
//    imposible diagnosticar la causa real desde los logs de Fly.io. Ahora
//    ese mensaje se propaga (providerMessage) y se registra explícitamente
//    en cada error, además de distinguir automáticamente un problema de
//    configuración/token (HTTP 502 + aviso a soporte) de un simple
//    "documento no encontrado" (HTTP 404).
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
// 🐞 BUG ADICIONAL CORREGIDO (causaba "success:false" en TODAS las consultas
// de DNI/RUC, ver log [ERROR] [VALIDAR_DNI] ... devolvió success:false):
//
// 5) Tokens sin "trim()": si el secret TOKEN_APISPERU (o TOKEN_MASITAPREX) se
//    configuró en Fly.io con un espacio, tabulador o salto de línea de más al
//    final (algo muy común al copiar/pegar el valor o al setearlo desde un
//    archivo con "fly secrets set"), el token enviado a la API externa deja
//    de coincidir con el registrado en su plataforma. La API responde
//    HTTP 200 con { success:false, message:'Token inválido' } en vez de un
//    401 claro, por lo que el síntoma visible es justamente el que aparece
//    en los logs: la consulta "falla" sin más explicación. index.js ya
//    aplicaba .trim() al token de Mercado Pago por esta misma razón; aquí no
//    se estaba haciendo. Se corrige para ambos proveedores.
const TOKEN_APISPERU = (process.env.TOKEN_APISPERU || '').trim();
const TOKEN_MASITAPREX = (process.env.TOKEN_MASITAPREX || '').trim();

// Diagnóstico de arranque (NUNCA se loguea el valor del token, solo si está
// presente y su longitud, para poder detectar en los logs de Fly.io casos
// como "el secret quedó vacío" o "el secret trae espacios" sin exponerlo).
if (!TOKEN_APISPERU) {
  logger.warn('VALIDAR_CLIENTES_CONFIG', 'TOKEN_APISPERU no está configurado: las consultas de DNI/RUC fallarán con 500.');
} else {
  logger.info('VALIDAR_CLIENTES_CONFIG', 'TOKEN_APISPERU cargado', { length: TOKEN_APISPERU.length });
}
if (!TOKEN_MASITAPREX) {
  logger.warn('VALIDAR_CLIENTES_CONFIG', 'TOKEN_MASITAPREX no está configurado: cédula/telefonía fallarán con 500.');
} else {
  logger.info('VALIDAR_CLIENTES_CONFIG', 'TOKEN_MASITAPREX cargado', { length: TOKEN_MASITAPREX.length });
}
// Según la documentación oficial (masitaprex.com/API-Docs.html), el token
// se envía SIEMPRE como header "x-api-key", sin esquema/prefijo.
const MASITAPREX_AUTH_HEADER = process.env.MASITAPREX_AUTH_HEADER || 'x-api-key';
const MASITAPREX_AUTH_SCHEME = process.env.MASITAPREX_AUTH_SCHEME !== undefined
  ? process.env.MASITAPREX_AUTH_SCHEME
  : '';

// Las APIs externas (APISPERU y Masitaprex) pueden tardar hasta ~50s en
// responder consultas pesadas. El timeout debe dar margen suficiente para
// no cortar respuestas válidas antes de tiempo.
const EXTERNAL_TIMEOUT_MS = Number(process.env.VALIDAR_CLIENTES_TIMEOUT_MS) || 60000;

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
    // Se registra el mensaje real devuelto por el proveedor (providerMessage)
    // además del error.message genérico, para poder diagnosticar en Fly.io
    // logs sin tener que reproducir el problema manualmente.
    logger.error(contexto, 'Error consultando proveedor externo', {
      uid: req.uid,
      message: error.message,
      providerMessage: error.providerMessage || null,
      httpStatus: error.httpStatus || null,
      isConfigError: !!error.isConfigError
    });
    const status = error.statusCode || 502;
    return res.status(status).json({
      success: false,
      error: error.publicMessage || 'No se pudo completar la consulta. Intenta nuevamente en unos segundos.'
    });
  }
}

// Algunos proveedores (Masitaprex) envuelven siempre la respuesta real en
// { success: true, data: {...}, meta: {...} }. Otros (APISPERU) devuelven
// los campos directamente en la raíz (a veces junto a un "success": true,
// pero SIN una clave "data" anidada). Esta función normaliza ambos casos
// para que el frontend siempre reciba los campos reales en el primer nivel,
// evitando el bug de "tarjetas vacías" por doble anidado.
function unwrapProviderBody(body) {
  if (body && typeof body === 'object' && body.success === true &&
      body.data && typeof body.data === 'object') {
    return body.data;
  }
  return body;
}

async function attemptFetch(url, options, providerName) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) });
  } catch (netError) {
    const isTimeout = netError?.name === 'TimeoutError' || netError?.name === 'AbortError';
    const err = new Error(`Error de red al contactar ${providerName}: ${netError.message}`);
    err.isNetworkError = true;
    err.publicMessage = isTimeout
      ? 'El proveedor externo tardó demasiado en responder. Intenta nuevamente en unos segundos.'
      : 'No se pudo contactar al servicio de validación. Intenta de nuevo.';
    throw err;
  }

  let rawBody = null;
  let bodyText = '';
  try {
    bodyText = await response.text();
    rawBody = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    // Respuesta no-JSON (HTML de error, texto plano, etc.)
    rawBody = null;
  }

  if (!response.ok) {
    const err = new Error(`${providerName} respondió ${response.status}`);
    err.statusCode = response.status === 404 ? 404 : (response.status === 401 || response.status === 402) ? 502 : 502;
    err.httpStatus = response.status;
    err.providerMessage = rawBody?.message || rawBody?.error || null;
    err.isConfigError = response.status === 401 || response.status === 402;
    err.publicMessage = rawBody?.message || rawBody?.error ||
      (response.status === 404 ? 'No se encontraron resultados para el dato ingresado.' :
       response.status === 401 ? 'El servicio externo rechazó la autenticación. Contacta al soporte.' :
       response.status === 402 ? 'El servicio externo no tiene créditos disponibles. Contacta al soporte.' :
       'El servicio externo no está disponible en este momento.');
    throw err;
  }

  // Algunos proveedores devuelven HTTP 200 pero success:false en el body
  // (por ejemplo, "no encontrado", token inválido/vencido, o sin créditos).
  // IMPORTANTE: antes esto se logueaba solo como "devolvió success:false",
  // sin el motivo real (rawBody.message), lo que hacía imposible diagnosticar
  // el problema desde los logs de producción. Ahora el mensaje/código real
  // del proveedor queda adjunto al error (providerMessage/providerRaw) para
  // que ejecutarConsulta() lo registre con logger.error.
  if (rawBody && typeof rawBody === 'object' && rawBody.success === false) {
    const providerMessage = rawBody.message || rawBody.error || rawBody.msg || null;
    const err = new Error(`${providerName} devolvió success:false${providerMessage ? `: ${providerMessage}` : ''}`);
    err.statusCode = 404;
    err.providerMessage = providerMessage;
    err.providerRaw = rawBody;
    // Mensajes típicos de APISPERU que indican un problema de CONFIGURACIÓN
    // (token inválido/vencido o sin créditos) en vez de "dato no encontrado".
    // Distinguirlos evita decirle al usuario "no se encontraron resultados"
    // cuando en realidad el servicio está mal configurado.
    const msgLower = (providerMessage || '').toString().toLowerCase();
    const esProblemaDeToken = /token|autoriza|credit|plan|limite|límite/.test(msgLower);
    if (esProblemaDeToken) {
      err.statusCode = 502;
      err.publicMessage = 'El servicio de validación no está disponible en este momento. Contacta al soporte.';
      err.isConfigError = true;
    } else {
      err.publicMessage = providerMessage || 'No se encontraron resultados para el dato ingresado.';
    }
    throw err;
  }

  // Respuesta 200 pero sin cuerpo utilizable: no debe pasar como "éxito vacío".
  if (rawBody === null || (typeof rawBody === 'object' && Object.keys(rawBody).length === 0)) {
    const err = new Error(`${providerName} devolvió una respuesta vacía`);
    err.statusCode = 502;
    err.publicMessage = 'El proveedor externo devolvió una respuesta vacía. Intenta nuevamente.';
    throw err;
  }

  return unwrapProviderBody(rawBody);
}

// callExternal: intenta la consulta y reintenta UNA vez ante fallos de red
// o timeout (no reintenta ante errores 4xx del proveedor, como DNI/RUC
// inexistentes o parámetros inválidos, para no duplicar consumo de créditos
// innecesariamente).
async function callExternal(url, options, providerName) {
  try {
    return await attemptFetch(url, options, providerName);
  } catch (error) {
    if (!error.isNetworkError) throw error;
    logger.warn('VALIDAR_CLIENTES_RETRY', `Reintentando ${providerName} tras fallo de red`, { url: url.split('?')[0] });
    return await attemptFetch(url, options, providerName);
  }
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
      { method: 'GET', headers: { 'Accept': 'application/json' } },
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
      { method: 'GET', headers: { 'Accept': 'application/json' } },
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
    // OJO: el endpoint real documentado es "telefonia-num" (sin "ero").
    // Usar "telefonia-numero" devuelve 404 en la API de Masitaprex.
    fetchFn: () => callExternal(
      `${MASITAPREX_BASE}/consulta/telefonia-num`,
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
