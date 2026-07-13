import admin from "firebase-admin";
import { MercadoPagoConfig, Payment } from "mercadopago";
import { generateInvoicePDF } from './pdfGenerator.js';
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import moment from "moment-timezone";
import { logger } from './seguridad.js';
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================================================================
// 🔥 CONFIGURACIÓN DE FIREBASE
// ================================================================

export function buildServiceAccountFromEnv() {
  logger.info('FIREBASE_CONFIG', 'Construyendo service account desde variables de entorno individuales');

  const requiredVars = [
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY_ID'
  ];

  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    logger.error('FIREBASE_CONFIG', `Variables de Firebase faltantes: ${missingVars.join(', ')}`);
    return null;
  }

  try {
    const serviceAccount = {
      "type": process.env.FIREBASE_TYPE || "service_account",
      "project_id": process.env.FIREBASE_PROJECT_ID,
      "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
      "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      "client_email": process.env.FIREBASE_CLIENT_EMAIL,
      "client_id": process.env.FIREBASE_CLIENT_ID,
      "auth_uri": process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
      "token_uri": process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
      "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
      "client_x509_cert_url": process.env.FIREBASE_CLIENT_X509_CERT_URL,
      "universe_domain": process.env.FIREBASE_UNIVERSE_DOMAIN || "googleapis.com"
    };

    logger.info('FIREBASE_CONFIG', 'Service account construido exitosamente', {
      project_id: serviceAccount.project_id,
      client_email: serviceAccount.client_email,
      has_private_key: !!serviceAccount.private_key
    });

    return serviceAccount;

  } catch (error) {
    logger.error('FIREBASE_CONFIG', 'Error construyendo service account', error);
    return null;
  }
}

export let db;

// ----------------------------------------------------------------
// supabaseClient: inicializado con las variables SUPABASE_*
// ----------------------------------------------------------------
function buildSupabaseClient() {
  const context = 'SUPABASE_INIT';

  const requiredVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_STORAGE_BUCKET'
  ];

  const missingVars = requiredVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    logger.error(context, `Variables de Supabase faltantes: ${missingVars.join(', ')}`);
    return null;
  }

  try {
    const client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    logger.info(context, 'Cliente Supabase inicializado correctamente', {
      url: process.env.SUPABASE_URL,
      bucket: process.env.SUPABASE_STORAGE_BUCKET
    });

    return client;

  } catch (error) {
    logger.error(context, 'Error inicializando cliente Supabase', error);
    return null;
  }
}

export let supabaseClient = buildSupabaseClient();

// ================================================================
// 🆕 CONFIGURACIÓN DE PLANES (basado en planes.html)
// ================================================================

export const PLANES_CONFIG = {
  gratis: {
    tipo: 'gratis',
    duracionDias: 0, // sin expiración
    comprobantesLimite: 5,
    consultasLimite: 10,
    consultasTelefonosLimite: 5,
    descripcion: 'Plan Gratuito'
  },
  semanal: {
    tipo: 'pago',
    duracionDias: 7,
    comprobantesLimite: 150,
    consultasLimite: 20,
    consultasTelefonosLimite: 20,
    descripcion: 'Plan Semanal'
  },
  mensual: {
    tipo: 'pago',
    duracionDias: 30,
    comprobantesLimite: 800,
    consultasLimite: 60,
    consultasTelefonosLimite: 60,
    descripcion: 'Plan Mensual'
  },
  bimestral: {
    tipo: 'pago',
    duracionDias: 60,
    comprobantesLimite: 1800,
    consultasLimite: 140,
    consultasTelefonosLimite: 140,
    descripcion: 'Plan Bimestral'
  },
  semestral: {
    tipo: 'pago',
    duracionDias: 180,
    comprobantesLimite: 6000,
    consultasLimite: 350,
    consultasTelefonosLimite: 350,
    descripcion: 'Plan Semestral'
  }
};

// ================================================================
// 🗄️  FUNCIONES DE STORAGE (facturas)
// ================================================================

export function getPublicAppUrl() {
  const candidates = [
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
    process.env.WEB_URL,
    process.env.SITE_URL,
    process.env.HOST_URL
  ].filter(Boolean);

  const preferredUrl = candidates.find(url => /masitaprex\.com/i.test(url)) || 'https://www.masitaprex.com';
  return preferredUrl.replace(/\/+$/, '');
}

export function getInvoiceStoragePath(paymentId) {
  return `invoices/${paymentId}.pdf`;
}

export function buildInvoiceProxyUrl(paymentId) {
  return `${getPublicAppUrl()}/boleta/${encodeURIComponent(paymentId)}.pdf`;
}

function extractStoragePathFromSupabaseUrl(fileUrl) {
  if (!fileUrl) return null;

  try {
    const parsedUrl = new URL(fileUrl);
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    const publicSegment = `/storage/v1/object/public/${bucket}/`;
    const signSegment = `/storage/v1/object/sign/${bucket}/`;

    if (parsedUrl.pathname.includes(publicSegment)) {
      return decodeURIComponent(parsedUrl.pathname.split(publicSegment)[1] || '');
    }

    if (parsedUrl.pathname.includes(signSegment)) {
      return decodeURIComponent(parsedUrl.pathname.split(signSegment)[1] || '');
    }

    return null;
  } catch {
    return null;
  }
}

export function resolveInvoiceStoragePath(paymentId, paymentData = {}) {
  return (
    paymentData.pdfStoragePath ||
    paymentData.storagePath ||
    extractStoragePathFromSupabaseUrl(paymentData.pdfPublicUrl) ||
    extractStoragePathFromSupabaseUrl(paymentData.pdfUrl) ||
    getInvoiceStoragePath(paymentId)
  );
}

export async function downloadInvoiceBufferFromStorage(storagePath) {
  const context = 'STORAGE_DOWNLOAD';

  if (!supabaseClient) {
    logger.error(context, 'Supabase no está inicializado');
    return null;
  }

  const bucket = process.env.SUPABASE_STORAGE_BUCKET;

  try {
    const { data, error } = await supabaseClient.storage
      .from(bucket)
      .download(storagePath);

    if (error) {
      logger.error(context, 'Error descargando PDF desde Supabase Storage', error, { storagePath });
      return null;
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    logger.info(context, 'PDF obtenido correctamente desde Supabase Storage', {
      storagePath,
      size: buffer.length
    });

    return {
      buffer,
      size: buffer.length,
      contentType: data.type || 'application/pdf'
    };
  } catch (error) {
    logger.error(context, 'Error descargando PDF desde Supabase Storage', error, { storagePath });
    return null;
  }
}

export async function uploadPDFToStorage(pdfPath, paymentId) {
  const context = 'STORAGE_UPLOAD';

  if (!supabaseClient) {
    logger.error(context, 'Supabase no está inicializado');
    return null;
  }

  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  const fileName = getInvoiceStoragePath(paymentId);

  try {
    const fileBuffer = fs.readFileSync(pdfPath);

    const { error } = await supabaseClient.storage
      .from(bucket)
      .upload(fileName, fileBuffer, {
        contentType: 'application/pdf',
        upsert: true,
        cacheControl: '3600'
      });

    if (error) {
      logger.error(context, '❌ Error subiendo PDF a Supabase Storage', error, { paymentId });
      return null;
    }

    const { data: urlData } = supabaseClient.storage
      .from(bucket)
      .getPublicUrl(fileName);

    const publicUrl = urlData.publicUrl;
    const proxyUrl = buildInvoiceProxyUrl(paymentId);

    logger.info(context, '✅ PDF subido exitosamente a Supabase Storage', {
      fileName,
      publicUrl,
      proxyUrl
    });

    return {
      storagePath: fileName,
      publicUrl,
      proxyUrl
    };

  } catch (error) {
    logger.error(context, '❌ Error subiendo PDF a Supabase Storage', error, { paymentId });
    return null;
  }
}

// ================================================================
// 🔥 INICIALIZACIÓN DE FIREBASE
// ================================================================

export async function initFirebase(serviceAccount) {
  if (serviceAccount && !admin.apps.length) {
    try {
      logger.info('FIREBASE', 'Inicializando Firebase Admin...');

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
      });

      db = admin.firestore();

      db.settings({
        ignoreUndefinedProperties: true
      });

      logger.info('FIREBASE', 'Firebase Admin inicializado correctamente', {
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email
      });

      db.collection('_healthcheck').doc('connection').get()
        .then(() => logger.info('FIRESTORE', 'Conexión a Firestore exitosa'))
        .catch(error => logger.error('FIRESTORE', 'Error verificando conexión', error));

    } catch (error) {
      logger.error('FIREBASE', 'Error crítico al inicializar Firebase Admin', error, {
        projectId: serviceAccount?.project_id,
        clientEmail: serviceAccount?.client_email
      });
      console.error('CRITICAL: Firebase no pudo inicializarse.');
    }
  } else if (admin.apps.length) {
    db = admin.firestore();
    logger.info('FIREBASE', 'Usando instancia existente de Firebase');
  }
}

// ================================================================
// 🗄️  LOCKS Y CACHE PARA PAGOS
// ================================================================

export const processedPaymentsCache = new Map();
export const paymentLocks = new Map();

export async function acquirePaymentLock(paymentRef, maxWaitMs = 10000) {
  const context = 'PAYMENT_LOCK';
  const startTime = Date.now();

  while (paymentLocks.has(paymentRef)) {
    if (Date.now() - startTime > maxWaitMs) {
      logger.warn(context, 'Timeout esperando lock', { paymentRef, waitedMs: maxWaitMs });
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  paymentLocks.set(paymentRef, Date.now());
  logger.info(context, '🔒 Lock adquirido', { paymentRef });
  return true;
}

export function releasePaymentLock(paymentRef) {
  const context = 'PAYMENT_LOCK';
  paymentLocks.delete(paymentRef);
  logger.info(context, '🔓 Lock liberado', { paymentRef });
}

// ================================================================
// 💰 OTORGAR BENEFICIO (NUEVA LÓGICA POR PLAN)
// ================================================================

export async function otorgarBeneficio(uid, email, montoPagado, processor, paymentRefString, resend, planId) {
  const context = 'OTORGAR_BENEFICIO';
  
  if (!db) {
    logger.error(context, 'Base de datos no disponible');
    return { status: 'error', message: 'Database not available' };
  }

  // Validar que el plan existe en la configuración
  const planConfig = PLANES_CONFIG[planId];
  if (!planConfig) {
    logger.error(context, 'PlanId no válido', { planId, uid });
    return { status: 'error', message: 'Invalid Plan ID' };
  }

  // Validación de Monto (opcional, si se desea verificar el precio)
  // Podríamos obtener el precio de una tabla de precios asociada al plan, pero por ahora omitimos.
  // Si se desea, se puede añadir un mapa de precios.

  try {
    const lockAcquired = await acquirePaymentLock(paymentRefString);
    if (!lockAcquired) {
      return { status: 'error', message: 'Could not acquire payment lock' };
    }

    if (processedPaymentsCache.has(paymentRefString)) {
      const cached = processedPaymentsCache.get(paymentRefString);
      logger.info(context, 'Pago ya procesado (Cache)', { paymentRef: paymentRefString, uid: cached.uid });
      releasePaymentLock(paymentRefString);
      return { status: 'already_processed', pdfUrl: buildInvoiceProxyUrl(paymentRefString) };
    }

    const pagoDoc = db.collection("pagos_registrados").doc(paymentRefString);
    const pagoSnap = await pagoDoc.get();

    if (pagoSnap.exists && pagoSnap.data().procesado) {
      logger.info(context, 'Pago ya procesado (Firestore)', { paymentRef: paymentRefString });
      releasePaymentLock(paymentRefString);
      return { status: 'already_processed', pdfUrl: buildInvoiceProxyUrl(paymentRefString) };
    }

    if (!pagoSnap.exists) {
      logger.info(context, 'Creando documento de pago inicial', { paymentRef: paymentRefString });
      await pagoDoc.set({
        email: email,
        monto: montoPagado || 0,
        uid: uid,
        planId: planId,
        estado: "pending",
        procesado: false,
        fechaRegistro: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const result = await db.runTransaction(async (t) => {
      const userRef = db.collection("usuarios").doc(uid);
      const userSnap = await t.get(userRef);

      if (!userSnap.exists) {
        logger.warn(context, 'Usuario no encontrado en colección usuarios, buscando en empresas', { uid });
        const empresaDoc = await t.get(db.collection("empresas").doc(uid));
        if (!empresaDoc.exists) {
          throw new Error(`Usuario ${uid} no encontrado en ninguna colección`);
        }
      }

      const userData = userSnap.data() || {};

      // Obtener valores actuales o establecer por defecto
      const currentComprobantesLimite = userData.comprobantesLimite || 0;
      const currentConsultasLimite = userData.consultasLimite || 0;
      const currentConsultasTelefonosLimite = userData.consultasTelefonosLimite || 0;
      const currentPlanExpiration = userData.planExpiration ? userData.planExpiration.toDate() : null;
      const now = new Date();

      // Determinar nueva fecha de expiración
      let newExpiration;
      if (planConfig.duracionDias === 0) {
        // Plan gratuito no expira
        newExpiration = null;
      } else {
        // Si el plan actual está activo y su expiración es futura, sumamos días
        if (currentPlanExpiration && currentPlanExpiration > now) {
          newExpiration = moment(currentPlanExpiration).add(planConfig.duracionDias, 'days').toDate();
        } else {
          newExpiration = moment(now).add(planConfig.duracionDias, 'days').toDate();
        }
      }

      // Sumar límites (acumulativos)
      const nuevosComprobantesLimite = currentComprobantesLimite + planConfig.comprobantesLimite;
      const nuevosConsultasLimite = currentConsultasLimite + planConfig.consultasLimite;
      const nuevosConsultasTelefonosLimite = currentConsultasTelefonosLimite + planConfig.consultasTelefonosLimite;

      // Actualizar documento del usuario
      const updateData = {
        tipoPlan: planId,
        planStatus: 'active',
        planExpiration: newExpiration,
        comprobantesLimite: nuevosComprobantesLimite,
        consultasLimite: nuevosConsultasLimite,
        consultasTelefonosLimite: nuevosConsultasTelefonosLimite,
        ultimaCompra: admin.firestore.FieldValue.serverTimestamp()
      };

      // Si es la primera compra o no tenía plan activo, actualizar fecha de activación
      if (!userData.planActivationDate || !currentPlanExpiration || currentPlanExpiration <= now) {
        updateData.planActivationDate = admin.firestore.FieldValue.serverTimestamp();
      }

      t.set(userRef, updateData, { merge: true });

      // Actualizar documento de pago
      t.update(pagoDoc, {
        procesado: true,
        estado: "approved",
        procesadoEn: admin.firestore.FieldValue.serverTimestamp(),
        procesadoPor: processor,
        planOtorgado: {
          planId,
          duracionDias: planConfig.duracionDias,
          comprobantesLimite: planConfig.comprobantesLimite,
          consultasLimite: planConfig.consultasLimite,
          consultasTelefonosLimite: planConfig.consultasTelefonosLimite,
          expiracion: newExpiration
        },
        tipoPlanNuevo: planId
      });

      return {
        status: 'success',
        planOtorgado: {
          planId,
          duracionDias: planConfig.duracionDias,
          comprobantesLimite: planConfig.comprobantesLimite,
          consultasLimite: planConfig.consultasLimite,
          consultasTelefonosLimite: planConfig.consultasTelefonosLimite,
          expiracion: newExpiration
        },
        descripcion: planConfig.descripcion,
        tipoPlanNuevo: planId
      };
    });

    // Generación de PDF y envío de correo (fuera de la transacción)
    try {
      const invoiceData = {
        orderId: paymentRefString,
        date: new Date().toLocaleString('es-PE'),
        email: email || 'cliente@example.com',
        amount: montoPagado || 0,
        credits: 0, // Ya no se usan créditos
        description: result.descripcion || 'Compra de plan',
        type: 'boleta'
      };

      const pdfPath = await generateInvoicePDF(invoiceData);
      const uploadResult = await uploadPDFToStorage(pdfPath, paymentRefString);
      const proxyUrl = uploadResult?.proxyUrl || buildInvoiceProxyUrl(paymentRefString);
      const publicUrl = uploadResult?.publicUrl || null;
      const storagePath = uploadResult?.storagePath || getInvoiceStoragePath(paymentRefString);

      await pagoDoc.update({
        pdfUrl: proxyUrl,
        pdfPublicUrl: publicUrl,
        pdfStoragePath: storagePath,
        invoiceData: invoiceData
      });

      result.pdfUrl = proxyUrl;

      // Enviar correo de éxito automáticamente
      if (resend) {
        let nombreUsuario = email.split('@')[0];
        try {
          const userSnap = await db.collection("usuarios").doc(uid).get();
          if (userSnap.exists) {
            nombreUsuario = userSnap.data().name || userSnap.data().displayName || nombreUsuario;
          } else {
            const empresaSnap = await db.collection("empresas").doc(uid).get();
            if (empresaSnap.exists) {
              nombreUsuario = empresaSnap.data().nombre || nombreUsuario;
            }
          }
        } catch (e) {
          logger.error(context, 'Error obteniendo nombre para email', e);
        }

        enviarCorreoExito(
          email,
          nombreUsuario,
          paymentRefString,
          montoPagado || 0,
          result.descripcion || 'Plan adquirido',
          proxyUrl,
          resend
        ).catch(err => logger.error(context, 'Error en envío automático de email de éxito', err));
      }

      // Limpiar archivo temporal
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

    } catch (pdfError) {
      logger.error(context, 'Error generando/subiendo PDF', pdfError);
    }

    processedPaymentsCache.set(paymentRefString, { uid, ...result });
    releasePaymentLock(paymentRefString);
    return result;

  } catch (error) {
    logger.error(context, 'Error procesando beneficio', error, { uid, paymentRef: paymentRefString });
    releasePaymentLock(paymentRefString);
    return { status: 'error', message: error.message };
  }
}

// ================================================================
// 📧 FUNCIONES DE ENVÍO DE CORREOS (sin créditos)
// ================================================================

function readHtmlTemplate(templateName, replacements = {}) {
  const templatePath = path.join(__dirname, 'emails', templateName);
  try {
    let html = fs.readFileSync(templatePath, 'utf8');
    for (const [key, value] of Object.entries(replacements)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, value);
    }
    return html;
  } catch (error) {
    logger.error('EMAIL_TEMPLATE', `Error leyendo plantilla ${templateName}`, error);
    return `<p>Error al cargar la plantilla. Por favor contacte a soporte.</p>`;
  }
}

export async function enviarBienvenida(email, nombre, resend) {
  const context = 'EMAIL_BIENVENIDA';
  try {
    const html = readHtmlTemplate('bienvenida-usuario-nuevo.html', { nombre: nombre || email.split('@')[0] });
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex <noreply@masitaprex.com>',
      to: email,
      subject: 'Bienvenido a Masitaprex - Tu cuenta está lista',
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de bienvenida enviado', { email, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de bienvenida', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

export async function enviarCorreoSospechoso(email, nombre, location, ip, userAgent, resend) {
  const context = 'EMAIL_SOSPECHOSO';
  try {
    let dispositivo = 'Desconocido';
    if (userAgent) {
      if (userAgent.includes('Windows')) dispositivo = 'Windows PC';
      else if (userAgent.includes('Mac')) dispositivo = 'Mac';
      else if (userAgent.includes('iPhone')) dispositivo = 'iPhone';
      else if (userAgent.includes('Android')) dispositivo = 'Android';
      else if (userAgent.includes('Linux')) dispositivo = 'Linux';
    }

    const fecha_hora = moment().tz('America/Lima').format('DD/MM/YYYY HH:mm:ss');

    const html = readHtmlTemplate('intento-inicio-seccion-sospechoso.html', {
      nombre: nombre || email.split('@')[0],
      ubicacion: location || 'Ubicación desconocida',
      ip: ip || 'IP no registrada',
      isp: 'Proveedor no identificado',
      tipo_conexion: 'No disponible',
      fecha_hora: fecha_hora,
      dispositivo: dispositivo
    });

    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex Seguridad <seguridad@masitaprex.com>',
      to: email,
      subject: '⚠️ Alerta de seguridad: Inicio de sesión sospechoso detectado',
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo sospechoso enviado', { email, ip, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo sospechoso', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

export async function enviarCorreoRechazo(email, nombre, orderId, monto, descripcion, estado, resend) {
  const context = 'EMAIL_RECHAZO';
  try {
    const html = readHtmlTemplate('compra-rechazada.html', {
      nombre: nombre || email.split('@')[0],
      descripcion: descripcion || 'Suscripción Masitaprex',
      orderId: orderId,
      monto: monto.toString()
    });

    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex Facturación <facturacion@masitaprex.com>',
      to: email,
      subject: 'Problema con tu pago en Masitaprex',
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de rechazo enviado', { email, orderId, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de rechazo', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

export async function enviarCorreoExito(email, nombre, orderId, monto, descripcion, urlBoleta, resend) {
  const context = 'EMAIL_EXITO';
  try {
    const html = readHtmlTemplate('compra-exitosa.html', {
      nombre: nombre || email.split('@')[0],
      descripcion: descripcion || 'Compra de plan',
      orderId: orderId,
      monto: monto.toString(),
      url_boleta: urlBoleta || '#'
    });

    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex Facturación <facturacion@masitaprex.com>',
      to: email,
      subject: '¡Tu compra ha sido exitosa! - Masitaprex',
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de éxito enviado', { email, orderId, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de éxito', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

export async function enviarCorreoSoporte({ name, email, subject, message, timestamp }, resend) {
  const context = 'EMAIL_SOPORTE';
  try {
    const adminEmail = process.env.SUPPORT_EMAIL || 'soporte@masitaprex.com';
    const fecha = timestamp || new Date().toLocaleString('es-PE');
    
    const html = `
      <h2>Nuevo mensaje de contacto</h2>
      <p><strong>Nombre:</strong> ${name}</p>
      <p><strong>Correo:</strong> ${email}</p>
      <p><strong>Asunto:</strong> ${subject}</p>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Mensaje:</strong></p>
      <p>${message.replace(/\n/g, '<br>')}</p>
    `;

    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex Soporte <soporte@masitaprex.com>',
      to: adminEmail,
      replyTo: email,
      subject: `[Soporte] ${subject}`,
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de soporte enviado al administrador', { from: email, subject, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de soporte', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

// ================================================================
// 🚀 WEBHOOK DE MERCADO PAGO (VALIDACIÓN OBLIGATORIA)
// ================================================================

export async function handleMercadoPagoWebhook(req, res) {
  const context = 'MP_WEBHOOK';
  const { type, data } = req.body;

  if (type !== 'payment') {
    return res.status(200).send('OK');
  }

  const paymentId = data.id;
  logger.info(context, 'Recibido webhook de pago', { paymentId });

  try {
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const payment = new Payment(mpClient);
    const paymentData = await payment.get({ id: paymentId });

    if (paymentData.status === 'approved') {
      const { external_reference, transaction_amount, metadata } = paymentData;
      
      const uid = external_reference || metadata.user_id;
      const planId = metadata.plan_id;
      const email = paymentData.payer.email;

      if (!uid || !planId) {
        logger.error(context, 'Datos incompletos en el pago', { paymentId, uid, planId });
        return res.status(400).send('Incomplete payment data');
      }

      const result = await otorgarBeneficio(
        uid, 
        email, 
        transaction_amount, 
        'MercadoPago_Webhook', 
        paymentId.toString(), 
        null, // resend se pasa en el contexto del webhook? lo pasamos global
        planId
      );

      logger.info(context, 'Beneficio procesado vía Webhook', { paymentId, result });
      return res.status(200).json(result);
    }

    return res.status(200).send('Payment not approved');

  } catch (error) {
    logger.error(context, 'Error en Webhook Mercado Pago', error);
    return res.status(500).send('Internal Server Error');
  }
}
