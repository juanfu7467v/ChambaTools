// ================================================================
// 🔒 CONFIGURACIÓN CSP (Content Security Policy) CORREGIDA
// ================================================================

const unique = (values) => [...new Set(values.filter(Boolean))];

export const corsAllowedOrigins = [
  'https://facilitoTools.com',
  'https://www.facilitoTools.com',
  'https://facilitotools.com',
  'https://www.facilitotools.com',
  'https://auth.facilitotools.com',
  'https://api.facilitotools.com',
  'https://facilitotools.firebaseapp.com',
  'https://facilitotools.firebasestorage.app',
  'https://facilitotools.fly.dev'
];

const appOrigins = [
  'https://facilitoTools.com',
  'https://www.facilitoTools.com',
  'https://facilitotools.com',
  'https://www.facilitotools.com',
  'https://auth.facilitotools.com',
  'https://api.facilitotools.com',
  'https://facilitotools.fly.dev',
  'https://facilitotools.firebaseapp.com',
  'https://facilitotools.firebasestorage.app'
];

const googleAndFirebaseOrigins = [
  'https://accounts.google.com',
  'https://apis.google.com',
  'https://firestore.googleapis.com',
  'https://firebase.googleapis.com',
  'https://firebasestorage.googleapis.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://generativelanguage.googleapis.com',
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://www.google.com',
  'https://google.com',
  'https://www.googleapis.com',
  'https://www.gstatic.com',
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://region1.google-analytics.com',
  'https://*.firebaseio.com',
  'https://*.firebaseapp.com',
  'https://*.googleapis.com',
  'https://www.recaptcha.net'
];

const cdnAndUiOrigins = [
  'https://cdn-icons-png.flaticon.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://cdn.plyr.io',
  'https://cdn.tailwindcss.com',
  'https://i.postimg.cc',
  'https://*.postimg.cc',
  'https://image.tmdb.org',
  'https://images.unsplash.com',
  'https://lh3.googleusercontent.com',
  'https://placehold.co',
  'https://remixicon.com',
  'https://unpkg.com',
  'https://via.placeholder.com',
  'https://1.bp.blogspot.com'
];

const paymentOrigins = [
  'https://api.mercadopago.com',
  'https://mercadopago.com',
  'https://pago.mercadopago.com.pe',
  'https://sdk.mercadopago.com',
  'https://www.mercadopago.com',
  'https://www.mercadopago.com.pe',
  'https://http2.mlstatic.com',
  'https://*.mercadopago.com',
  'https://*.mercadolibre.com'
];

const externalServiceOrigins = [
  'https://api.ipquery.io',
  'https://m.facebook.com',
  'https://www.facebook.com',
  'https://wa.me',
  'https://youtube.com',
  'https://www.youtube.com',
  'https://github.com',
  'https://www.github.com',
  'https://api.github.com',
  'https://img.utdstc.com',
  'https://stc.utdstc.com',
  'https://*.effectivegatecpm.com'
];

export const cspDomains = unique([
  "'self'",
  'data:',
  'blob:',
  ...appOrigins,
  ...googleAndFirebaseOrigins,
  ...cdnAndUiOrigins,
  ...paymentOrigins,
  ...externalServiceOrigins
]);

const commonRemoteSources = unique(cspDomains.filter(source => !['data:', 'blob:'].includes(source)));

const scriptSources = unique(["'self'", "'unsafe-inline'", "'unsafe-eval'", ...commonRemoteSources]);
const styleSources = unique(["'self'", "'unsafe-inline'", ...commonRemoteSources]);
const imageSources = unique(["'self'", 'data:', 'blob:', 'https:', ...commonRemoteSources]);
const fontSources = unique(["'self'", 'data:', 'https:', ...commonRemoteSources]);

// 💡 CORRECCIÓN DE REGISTRO / AUTH: Se agregan endpoints clave para peticiones Fetch/XHR y OAuth
const connectSources = unique([
  "'self'",
  'data:',
  'blob:',
  'wss:',
  'https://github.com',
  'https://api.github.com',
  ...commonRemoteSources
]);

// 💡 CORRECCIÓN DE AUTH: Permitir que los Popups/Iframes de Google y Firebase carguen
const frameSources = unique([
  "'self'",
  'https://accounts.google.com',
  'https://facilitotools.firebaseapp.com',
  ...commonRemoteSources
]);

// 💡 CORRECCIÓN DE AUDIO: 'data:' permite audios Base64 y 'https:' permite audios desde URLs externas / CDNs / Cloud Storage
const mediaSources = unique([
  "'self'",
  'data:',
  'blob:',
  'https:',
  ...commonRemoteSources
]);

export const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: scriptSources,
      scriptSrcElem: scriptSources,
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: styleSources,
      styleSrcElem: styleSources,
      styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: imageSources,
      fontSrc: fontSources,
      connectSrc: connectSources,
      frameSrc: frameSources,
      childSrc: frameSources,
      mediaSrc: mediaSources,
      objectSrc: ["'none'"],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'", ...commonRemoteSources],
      prefetchSrc: ["'self'", ...commonRemoteSources],
      formAction: ["'self'", ...commonRemoteSources],
      frameAncestors: ["'self'", ...corsAllowedOrigins],
      baseUri: ["'self'"],
      upgradeInsecureRequests: []
    },
    reportOnly: false
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'unsafe-none' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  originAgentCluster: false,
  dnsPrefetchControl: { allow: true },
  frameguard: { action: 'sameorigin' },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  ieNoOpen: true,
  noSniff: true,
  permittedCrossDomainPolicies: { permittedPolicies: 'all' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true
};
