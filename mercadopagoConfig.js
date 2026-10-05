/**
 * Resolución de credenciales de Mercado Pago por ambiente.
 *
 * Producción conserva los nombres históricos:
 *   MERCADOPAGO_PUBLIC_KEY / MERCADOPAGO_ACCESS_TOKEN
 *
 * Pruebas usan un par separado:
 *   MERCADOPAGO_TEST_PUBLIC_KEY / MERCADOPAGO_TEST_ACCESS_TOKEN
 *
 * MERCADOPAGO_MODE selecciona un único par para esta instancia. Nunca se
 * devuelven ni se registran los Access Tokens desde las funciones públicas.
 */
const readTrimmed = (value) => typeof value === 'string' ? value.trim() : '';

export function resolveMercadoPagoConfig(env = process.env) {
  const mode = readTrimmed(env.MERCADOPAGO_MODE || 'production').toLowerCase();
  const issues = [];
  let publicKey = '';
  let accessToken = '';
  let publicKeyVariable = '';
  let accessTokenVariable = '';

  if (!['production', 'test'].includes(mode)) {
    issues.push("MERCADOPAGO_MODE debe ser 'production' o 'test'.");
  } else if (mode === 'test') {
    publicKeyVariable = 'MERCADOPAGO_TEST_PUBLIC_KEY';
    accessTokenVariable = 'MERCADOPAGO_TEST_ACCESS_TOKEN';
    publicKey = readTrimmed(env[publicKeyVariable]);
    accessToken = readTrimmed(env[accessTokenVariable]);
  } else {
    publicKeyVariable = 'MERCADOPAGO_PUBLIC_KEY';
    accessTokenVariable = 'MERCADOPAGO_ACCESS_TOKEN';
    publicKey = readTrimmed(env[publicKeyVariable]);
    accessToken = readTrimmed(env[accessTokenVariable]);

    // Las claves públicas TEST- son inequívocamente de prueba. No permitir
    // que el checkout de producción las use por accidente.
    if (publicKey.startsWith('TEST-')) {
      issues.push('La clave pública configurada es de prueba, pero MERCADOPAGO_MODE está en production.');
    }
  }

  if (['production', 'test'].includes(mode)) {
    const missing = [];
    if (!publicKey) missing.push(publicKeyVariable);
    if (!accessToken) missing.push(accessTokenVariable);
    if (missing.length) issues.push(`Faltan credenciales de Mercado Pago: ${missing.join(' y ')}.`);
  }

  return {
    mode,
    publicKey,
    accessToken,
    publicKeyVariable,
    accessTokenVariable,
    configured: issues.length === 0 && Boolean(publicKey && accessToken),
    configurationError: issues.join(' ')
  };
}

/** Construye la parte segura que puede recibir el navegador; nunca incluye el Access Token. */
export function getPublicMercadoPagoConfig(config) {
  return {
    mercadopagoPublicKey: config.configured ? config.publicKey : null,
    mercadopagoMode: config.mode,
    mercadopagoConfigured: config.configured,
    mercadopagoConfigurationError: config.configurationError || null
  };
}
