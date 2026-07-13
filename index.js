import express from "express";
import admin from "firebase-admin";
import crypto from "crypto";
import cors from "cors";
import cookieParser from "cookie-parser";
import { MercadoPagoConfig, Payment } from "mercadopago";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { Resend } from "resend";
import helmet from "helmet";
import { helmetConfig, corsAllowedOrigins } from './cspConfig.js';

// Importar módulos de seguridad y negocios
import { 
  logger, 
  getClientIp, 
  checkLoginBlock, 
  registerFailedLogin, 
  resetLoginAttempts, 
  validateRecaptcha,
  getLocationFromIP,
  RECAPTCHA_SITE_KEY
} from './seguridad.js';

import { 
  initFirebase, 
  buildServiceAccountFromEnv, 
  db, 
  enviarBienvenida, 
  enviarCorreoSospechoso, 
  enviarCorreoRechazo,
  enviarCorreoSoporte,
  buildInvoiceProxyUrl,
  resolveInvoiceStoragePath,
  downloadInvoiceBufferFromStorage,
  otorgarBeneficio,          // <--- Importamos la nueva función
  PLANES_CONFIG              // <--- Opcional, para validar planes
} from './negocios.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');

// ================================================================
// 🔒 CONFIGURACIÓN CORS
// ================================================================

const allowedOrigins = corsAllowedOrigins;

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      logger.warn('CORS', 'Origen bloqueado por CORS', { origin });
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json());
app.use(cookieParser());
app.use(helmet(helmetConfig));

// ================================================================
// ✉️ CONFIGURACIÓN DE RESEND
// ================================================================

const resend = new Resend(process.env.RESEND_API_KEY);

// ================================================================
// 🔥 INICIALIZACIÓN DE FIREBASE
// ================================================================

const serviceAccount = buildServiceAccountFromEnv();
if (serviceAccount) {
  initFirebase(serviceAccount).catch(err => {
    logger.error('FIREBASE', 'Error crítico en inicialización asíncrona', err);
  });
} else {
  logger.error('FIREBASE', 'No se pudo inicializar Firebase - Service account no disponible');
}

// ================================================================
// 💳 CONFIGURACIÓN DE MERCADO PAGO
// ================================================================

const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const HOST_URL = process.env.HOST_URL || `https://${process.env.FLY_APP_NAME}.fly.dev`;

const mpClient = MERCADOPAGO_ACCESS_TOKEN ? new MercadoPagoConfig({
  accessToken: MERCADOPAGO_ACCESS_TOKEN.trim(),
  options: { timeout: 10000 }
}) : null;

// ================================================================
// 🛣️ RUTAS DE LA API
// ================================================================

// Endpoint de login exitoso
app.post("/api/login-success", async (req, res) => {
  const context = 'LOGIN_SUCCESS_API';
  try {
    const { email, uid, displayName, isNewUser, idToken, deviceModel } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    try {
      if (db && uid) {
        const userRef = db.collection("usuarios").doc(uid);
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
          const userData = userDoc.data();
          const lastDevice = userData.lastDeviceModel;
          
          if (lastDevice && deviceModel && lastDevice !== deviceModel) {
            const ip = getClientIp(req);
            const location = await getLocationFromIP(ip);
            const nombre = displayName || userData.name || email.split('@')[0];
            
            logger.warn(context, '⚠️ Inicio de sesión sospechoso detectado (cambio de dispositivo)', {
              email, uid, oldDevice: lastDevice, newDevice: deviceModel, ip
            });
            
            enviarCorreoSospechoso(email, nombre, location, ip, req.headers['user-agent'], resend)
              .catch(err => logger.error(context, 'Error enviando correo sospechoso', err));
          }
          
          if (deviceModel) {
            await userRef.update({ 
              lastDeviceModel: deviceModel,
              lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
    } catch (deviceError) {
      logger.error(context, 'Error verificando dispositivo sospechoso', deviceError);
    }

    await resetLoginAttempts(email);

    // Garantizar documento en "usuarios" con los campos del plan gratis
    if (uid) {
      let waitAttempts = 0;
      while (!db && waitAttempts < 10) {
        await new Promise(r => setTimeout(r, 500));
        waitAttempts++;
      }

      if (db) {
        const nombre = displayName || email.split('@')[0];
        const userRef = db.collection("usuarios").doc(uid);
        const userDoc = await userRef.get();
        const userData = userDoc.exists ? userDoc.data() : null;

        // Datos base del plan gratis (según PLANES_CONFIG)
        const gratisConfig = PLANES_CONFIG.gratis;
        const defaultPlanData = {
          tipoPlan: "gratis",
          planStatus: "active",
          planExpiration: null,
          comprobantesEmitidos: 0,
          comprobantesLimite: gratisConfig.comprobantesLimite,
          consultasConsumidas: 0,
          consultasLimite: gratisConfig.consultasLimite,
          consultasTelefonosConsumidas: 0,
          consultasTelefonosLimite: gratisConfig.consultasTelefonosLimite,
          planActivationDate: admin.firestore.FieldValue.serverTimestamp()
        };

        const updateData = {
          email,
          lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (!userDoc.exists) {
          updateData.createdAt = admin.firestore.FieldValue.serverTimestamp();
          if (isNewUser) {
            const welcomeResult = await enviarBienvenida(email, nombre, resend);
            if (welcomeResult.success) {
              updateData.welcomeEmailSent = true;
              updateData.welcomeEmailSentAt = admin.firestore.FieldValue.serverTimestamp();
            }

            const empresaRef = db.collection("empresas").doc(uid);
            const secureToken = crypto.randomBytes(32).toString('hex');
            await empresaRef.set({
              uid,
              email,
              nombre,
              apiToken: secureToken,
              token: secureToken,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              status: 'active'
            }, { merge: true });
            logger.info(context, 'Datos guardados en colección empresas', { uid, email });
          }
        }

        if (userDoc.exists) {
          // Verificar que todos los campos del plan existan, si no, agregarlos
          for (const [key, value] of Object.entries(defaultPlanData)) {
            if (!(key in userData) || userData[key] === undefined) {
              updateData[key] = value;
            }
          }
        } else {
          Object.assign(updateData, defaultPlanData);
        }

        await userRef.set(updateData, { merge: true });
        logger.info(context, 'Documento en "usuarios" sincronizado correctamente', { uid, email, isNewUser: !!isNewUser });
      }
    }

    const cookieOptions = {
      httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/'
    };
    res.cookie('user_email', email, cookieOptions);
    res.cookie('user_uid', uid, cookieOptions);

    res.json({ success: true, message: 'Login success', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error(context, 'Error procesando login exitoso', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Endpoint de notificación de verificación
app.post("/api/notify-verification", async (req, res) => {
  const context = 'NOTIFY_VERIFICATION';
  try {
    const { uid, email, displayName } = req.body;
    if (!uid || !email) return res.status(400).json({ success: false, error: 'Se requiere uid y email' });

    let waitAttempts = 0;
    while (!db && waitAttempts < 10) {
      await new Promise(r => setTimeout(r, 500));
      waitAttempts++;
    }

    let alreadySent = false;
    if (db) {
      const userDoc = await db.collection("usuarios").doc(uid).get();
      if (userDoc.exists && userDoc.data().welcomeEmailSent) alreadySent = true;
    }

    if (!alreadySent) {
      const result = await enviarBienvenida(email, displayName || email.split('@')[0], resend);
      if (result.success && db) {
        await db.collection("usuarios").doc(uid).set({
          welcomeEmailSent: true,
          welcomeEmailSentAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        // Asegurar que el documento tenga los campos del plan gratis
        const userDoc = await db.collection("usuarios").doc(uid).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        const gratisConfig = PLANES_CONFIG.gratis;
        const defaultPlanData = {
          tipoPlan: "gratis",
          planStatus: "active",
          planExpiration: null,
          comprobantesEmitidos: 0,
          comprobantesLimite: gratisConfig.comprobantesLimite,
          consultasConsumidas: 0,
          consultasLimite: gratisConfig.consultasLimite,
          consultasTelefonosConsumidas: 0,
          consultasTelefonosLimite: gratisConfig.consultasTelefonosLimite,
          planActivationDate: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const updateData = {};
        for (const [key, value] of Object.entries(defaultPlanData)) {
          if (!(key in userData) || userData[key] === undefined) {
            updateData[key] = value;
          }
        }
        if (Object.keys(updateData).length > 0) {
          await db.collection("usuarios").doc(uid).set(updateData, { merge: true });
        }

        const empresaRef = db.collection("empresas").doc(uid);
        const secureToken = crypto.randomBytes(32).toString('hex');
        await empresaRef.set({
          uid,
          email,
          nombre: displayName || email.split('@')[0],
          apiToken: secureToken,
          token: secureToken,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'active'
        }, { merge: true });
        logger.info(context, 'Datos guardados en colección empresas tras verificación', { uid, email });
      }
      return res.json({ success: result.success, message: result.success ? 'Correo enviado' : 'Error enviando correo' });
    }
    res.json({ success: true, message: 'Ya enviado' });
  } catch (error) {
    logger.error(context, 'Error en notificación', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ================================================================
// (Eliminados completamente: endpoints de películas, PeliPREX, créditos, etc.)
// ================================================================

// Endpoint de configuración
app.get("/api/config", (req, res) => {
  res.json({
    mercadopagoPublicKey: process.env.MERCADOPAGO_PUBLIC_KEY,
    recaptchaSiteKey: RECAPTCHA_SITE_KEY,
    firebaseConfig: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID
    },
    environment: process.env.NODE_ENV || 'production',
    timestamp: new Date().toISOString()
  });
});

// ================================================================
// RESTO DE ENDPOINTS (webhooks, pagos, facturas, etc.)
// ================================================================

// Endpoint de validación de reCAPTCHA
app.post("/api/validate-recaptcha", async (req, res) => {
  try {
    const { recaptchaResponse } = req.body;
    const result = await validateRecaptcha(recaptchaResponse, process.env.RECAPTCHA_CLAVE_SECRETA);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Endpoint de login con bloqueo
app.post("/api/login", async (req, res) => {
  const context = 'LOGIN_API';
  try {
    const { email, recaptchaResponse, deviceId, deviceModel } = req.body;
    if (!email || !deviceId) return res.status(400).json({ success: false, error: 'Email and deviceId required' });

    const blockStatus = await checkLoginBlock(email);
    if (blockStatus.isBlocked) {
      return res.status(403).json({ success: false, error: 'account_blocked', remainingMinutes: blockStatus.remainingMinutes });
    }

    if (recaptchaResponse) {
      await validateRecaptcha(recaptchaResponse, process.env.RECAPTCHA_CLAVE_SECRETA);
    }

    res.json({ success: true, message: 'Login allowed' });
  } catch (error) {
    logger.error(context, 'Error en login', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Endpoint para reportar login fallido
app.post("/api/report-failed-login", async (req, res) => {
  const context = 'REPORT_FAILED_LOGIN';
  try {
    const { email, deviceModel, errorType } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    const result = await registerFailedLogin(email, req, deviceModel);
    if (result.blocked) {
      const ip = getClientIp(req);
      const location = await getLocationFromIP(ip);
      await enviarCorreoSospechoso(email, null, location, ip, req.headers['user-agent'], resend);
    }
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(context, 'Error reportando fallo', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Endpoint de pago (actualizado para usar planId)
app.post("/api/pay", async (req, res) => {
  const context = 'PAY_API';
  try {
    const { transaction_amount, token, description, installments, payment_method_id, payer, uid, planId } = req.body;
    if (!mpClient) return res.status(503).json({ error: 'Mercado Pago not configured' });
    if (!payer || !payer.email) {
      logger.error(context, 'Payer email missing in request body');
      return res.status(400).json({ error: 'Payer email is required' });
    }

    // Validar que planId sea válido
    if (!planId || !PLANES_CONFIG[planId]) {
      logger.error(context, 'planId inválido o no proporcionado', { planId });
      return res.status(400).json({ error: 'Invalid planId' });
    }

    const payment = new Payment(mpClient);
    const result = await payment.create({
      body: {
        transaction_amount: Number(transaction_amount),
        token,
        description,
        installments: Number(installments),
        payment_method_id,
        payer,
        notification_url: `${HOST_URL}/api/webhook/mercadopago`,
        metadata: { 
          uid, 
          email: payer.email, 
          amount: transaction_amount, 
          plan_id: planId
        }
      }
    });

    if (result.status === 'rejected' || result.status === 'cancelled') {
      let userName = payer.email.split('@')[0];
      try {
        if (db) {
          let userSnap = await db.collection("usuarios").doc(uid).get();
          if (!userSnap.exists) {
            userSnap = await db.collection("empresas").doc(uid).get();
          }
          if (userSnap.exists) {
            const userData = userSnap.data();
            userName = userData.name || userData.displayName || userData.nombre || userName;
          }
        }
      } catch (err) {}
      
      enviarCorreoRechazo(
        payer.email, 
        userName, 
        result.id.toString(), 
        transaction_amount, 
        description || `Compra del plan ${planId}`, 
        result.status_detail || result.status, 
        resend
      ).catch(err => logger.error(context, 'Error enviando correo de rechazo', err));
    }
    res.json(result);
  } catch (error) {
    logger.error(context, 'Error en pago', error);
    res.status(400).json({ error: error.message });
  }
});

// Webhook de Mercado Pago (sin otorgar beneficios directamente, se maneja en otorgarBeneficio)
app.post("/api/webhook/mercadopago", async (req, res) => {
  const context = 'WEBHOOK_MP';
  const webhookData = req.body;
  res.sendStatus(200);

  if (!mpClient) return;
  const isPaymentEvent = webhookData.action?.includes('payment') || webhookData.type === 'payment';
  if (isPaymentEvent) {
    try {
      const paymentId = webhookData.data?.id || webhookData.id;
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: paymentId });

      if (paymentInfo.status === "approved") {
        const metadata = paymentInfo.metadata || {};
        const uid = metadata.uid || paymentInfo.external_reference;
        const planId = metadata.plan_id;
        const email = metadata.email || paymentInfo.payer?.email;

        if (uid && planId && email) {
          await otorgarBeneficio(
            uid,
            email,
            paymentInfo.transaction_amount,
            'MercadoPago_Webhook',
            paymentId.toString(),
            resend,
            planId
          );
        } else {
          logger.error(context, 'Datos insuficientes en webhook aprobado', { paymentId, uid, planId });
        }
      } else if (paymentInfo.status === "rejected" || paymentInfo.status === "cancelled") {
        const metadata = paymentInfo.metadata || {};
        const email = metadata.email || paymentInfo.payer?.email;
        const uid = metadata.uid;
        
        if (email && uid) {
          let userName = email.split('@')[0];
          try {
            if (db) {
              let userSnap = await db.collection("usuarios").doc(uid).get();
              if (!userSnap.exists) {
                userSnap = await db.collection("empresas").doc(uid).get();
              }
              if (userSnap.exists) {
                const userData = userSnap.data();
                userName = userData.name || userData.displayName || userData.nombre || userName;
              }
            }
          } catch (err) {}

          enviarCorreoRechazo(
            email,
            userName,
            paymentId.toString(),
            metadata.amount || paymentInfo.transaction_amount,
            paymentInfo.description || 'Compra de plan',
            paymentInfo.status_detail || paymentInfo.status,
            resend
          ).catch(err => logger.error(context, 'Error enviando correo de rechazo desde webhook', err));
        }
      }
    } catch (error) {
      logger.error(context, 'Error en webhook', error);
    }
  }
});

// ================================================================
// ENDPOINTS PARA CONSULTAR ESTADO DE PAGO
// ================================================================

app.get("/api/payment-status/:paymentId", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    if (!paymentId) return res.status(400).json({ error: 'paymentId requerido' });

    if (!db) return res.status(503).json({ error: 'Database no disponible' });

    const pagoDoc = await db.collection("pagos_registrados").doc(paymentId).get();
    if (!pagoDoc.exists) {
      return res.json({ status: 'pending', processed: false });
    }

    const data = pagoDoc.data();
    res.json({
      status: data.estado || 'pending',
      processed: data.procesado || false,
      paymentId: paymentId
    });
  } catch (error) {
    logger.error('PAYMENT_STATUS', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get("/api/payment-reference/:externalRef", async (req, res) => {
  try {
    const externalRef = req.params.externalRef;
    if (!externalRef) return res.status(400).json({ error: 'externalRef requerido' });

    if (!db) return res.status(503).json({ error: 'Database no disponible' });

    const pagosQuery = await db.collection("pagos_registrados")
      .where("externalReference", "==", externalRef)
      .limit(1)
      .get();

    if (pagosQuery.empty) {
      return res.json({ status: 'pending', processed: false, paymentId: null });
    }

    const doc = pagosQuery.docs[0];
    const data = doc.data();
    res.json({
      status: data.estado || 'pending',
      processed: data.procesado || false,
      paymentId: doc.id
    });
  } catch (error) {
    logger.error('PAYMENT_REFERENCE', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ================================================================
// 🧾 MANEJADOR DE DESCARGA DE BOLETAS
// ================================================================
const handleInvoiceDownload = async (req, res) => {
  const context = 'INVOICE_DOWNLOAD';

  try {
    const rawPaymentId = req.params.paymentId || req.params.paymentIdWithExt;
    const paymentId = (rawPaymentId || '').replace(/\.pdf$/i, '');

    if (!paymentId) {
      return res.status(400).json({ error: 'paymentId requerido' });
    }

    if (!db) {
      return res.status(503).json({ error: 'Database no disponible' });
    }

    const pagoDoc = await db.collection("pagos_registrados").doc(paymentId).get();
    if (!pagoDoc.exists) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const data = pagoDoc.data();
    const storagePath = resolveInvoiceStoragePath(paymentId, data);
    const invoiceFile = await downloadInvoiceBufferFromStorage(storagePath);

    if (!invoiceFile?.buffer) {
      return res.status(404).json({ error: 'La boleta aún no está disponible. Intenta en unos segundos.' });
    }

    const fileName = `boleta-${paymentId}.pdf`;

    res.setHeader('Content-Type', invoiceFile.contentType || 'application/pdf');
    res.setHeader('Content-Length', invoiceFile.size);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

    return res.send(invoiceFile.buffer);
  } catch (error) {
    logger.error(context, error);
    return res.status(500).json({ error: 'Error al obtener la boleta' });
  }
};

app.get("/api/invoice/:paymentId", handleInvoiceDownload);
app.get("/boleta/:paymentIdWithExt", handleInvoiceDownload);

// Endpoint para obtener información del pago
app.get("/api/payment/:paymentId", async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const pagoDoc = await db.collection("pagos_registrados").doc(req.params.paymentId).get();
    if (!pagoDoc.exists) return res.status(404).json({ error: 'Payment not found' });
    
    const data = pagoDoc.data();
    const fecha = data.fechaRegistro?.toDate() || new Date();
    res.json({
      id: req.params.paymentId,
      email: data.email,
      monto: data.monto,
      descripcion: data.descripcion,
      fecha: fecha.toLocaleDateString('es-PE'),
      hora: fecha.toLocaleTimeString('es-PE'),
      estado: data.estado,
      procesado: data.procesado,
      tipoPlan: data.tipoPlanNuevo || 'gratis',
      pdfUrl: (data.pdfUrl || data.pdfStoragePath || data.pdfPublicUrl) ? buildInvoiceProxyUrl(req.params.paymentId) : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ================================================================
// SERVICIO DE ARCHIVOS ESTÁTICOS Y GA
// ================================================================

const PUBLIC_ROUTES = ['/login', '/register', '/verify', '/reset-password', '/disclaimer-apis', '/API-Docs'];

const injectGA = (html) => {
  const gaId = process.env.GOOGLE_ANALYTICS_ID;
  if (!gaId) return html;

  const gaScript = `
    <!-- Google Analytics 4 (GA4) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', '${gaId}', {
        page_path: window.location.pathname,
      });
    </script>
  `;
  
  if (html.includes('</head>')) {
    return html.replace('</head>', `${gaScript}</head>`);
  }
  return gaScript + html;
};

// Middleware para servir HTML con inyección de GA
const serveHtmlWithGA = (req, res, next) => {
  let fileName = '';
  if (req.path === '/') {
    fileName = 'home.html';
  } else if (PUBLIC_ROUTES.includes(req.path)) {
    fileName = `${req.path.substring(1)}.html`;
  } else if (req.path.endsWith('.html')) {
    fileName = req.path.substring(1);
  } else {
    const potentialFile = `${req.path.substring(1)}.html`;
    if (fs.existsSync(path.join(__dirname, 'public', potentialFile))) {
      fileName = potentialFile;
    }
  }

  if (fileName) {
    const filePath = path.join(__dirname, 'public', fileName);
    if (fs.existsSync(filePath)) {
      try {
        let html = fs.readFileSync(filePath, 'utf8');
        html = injectGA(html);
        return res.send(html);
      } catch (err) {
        logger.error('GA_INJECTION', `Error inyectando GA en ${fileName}`, err);
        return res.sendFile(filePath);
      }
    }
  }
  next();
};

app.use(serveHtmlWithGA);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get("/api", (req, res) => res.json({ status: "ok" }));

app.post("/api/support/send", async (req, res) => {
  const context = 'SUPPORT_SEND_API';
  try {
    const { name, email, subject, message, timestamp } = req.body;
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }

    logger.info(context, 'Recibida nueva consulta de soporte', { email, subject });

    const result = await enviarCorreoSoporte({ name, email, subject, message, timestamp }, resend);

    if (result.success) {
      res.json({ success: true, message: 'Consulta enviada correctamente' });
    } else {
      res.status(500).json({ success: false, error: 'Error al enviar el correo de soporte' });
    }
  } catch (error) {
    logger.error(context, 'Error procesando envío de soporte', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.use((err, req, res, next) => {
  logger.error('GLOBAL_ERROR', 'Error no manejado', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

//  SOLUCIÓN: Esperar la inicialización de Firebase antes de abrir el puerto
const PORT = process.env.PORT || 8080;

async function arrancarServidor() {
  try {
    await initFirebase(serviceAccount); 
    
    if (!db) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    app.listen(PORT, "0.0.0.0", () => {
      logger.info('SERVER', `🚀 Servidor iniciado con base de datos vinculada en puerto ${PORT}`, { version: '3.6.1' });
    });
  } catch (error) {
    logger.error('SERVER', '❌ Fallo crítico: No se pudo arrancar el servidor por error en Firebase', error);
    process.exit(1);
  }
}

arrancarServidor();
