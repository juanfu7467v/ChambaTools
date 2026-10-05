/**
 * Lee el par genérico de credenciales de Mercado Pago.
 *
 * Los mismos nombres se usan para ambos ambientes en Fly.io:
 *   MERCADOPAGO_PUBLIC_KEY
 *   MERCADOPAGO_ACCESS_TOKEN
 *
 * El ambiente de la integración se identifica por la Public Key: el prefijo
 * TEST- selecciona pruebas; las claves productivas y otros formatos conservan
 * producción como valor por defecto. No se infiere el ambiente desde el
 * Access Token: Mercado Pago indica que un test Access Token también puede
 * comenzar con APP_USR, igual que uno productivo.
 */
const readTrimmed = (value) => typeof value === 'string' ? value.trim() : '';

export function resolveMercadoPagoConfig(env = process.env) {
  const publicKey = readTrimmed(env.MERCADOPAGO_PUBLIC_KEY);
  const accessToken = readTrimmed(env.MERCADOPAGO_ACCESS_TOKEN);
  const mode = publicKey.startsWith('TEST-') ? 'test' : 'production';
  const missing = [];

  if (!publicKey) missing.push('MERCADOPAGO_PUBLIC_KEY');
  if (!accessToken) missing.push('MERCADOPAGO_ACCESS_TOKEN');

  return {
    mode,
    publicKey,
    accessToken,
    configured: missing.length === 0,
    configurationError: missing.length
      ? `Faltan credenciales de Mercado Pago: ${missing.join(' y ')}.`
      : ''
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
