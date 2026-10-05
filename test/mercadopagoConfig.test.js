import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublicMercadoPagoConfig, resolveMercadoPagoConfig } from '../mercadopagoConfig.js';

const prodPair = {
  MERCADOPAGO_MODE: 'production',
  MERCADOPAGO_PUBLIC_KEY: 'APP_USR_PRODUCTION_PUBLIC_KEY_EXAMPLE',
  MERCADOPAGO_ACCESS_TOKEN: 'APP_USR_PRODUCTION_ACCESS_TOKEN_EXAMPLE'
};
const testPair = {
  MERCADOPAGO_MODE: 'test',
  MERCADOPAGO_TEST_PUBLIC_KEY: 'TEST-PUBLIC_KEY_EXAMPLE',
  MERCADOPAGO_TEST_ACCESS_TOKEN: 'TEST_ACCESS_TOKEN_EXAMPLE'
};

test('uses the production key pair when mode is production', () => {
  const config = resolveMercadoPagoConfig(prodPair);
  assert.equal(config.mode, 'production');
  assert.equal(config.configured, true);
  assert.equal(config.publicKey, prodPair.MERCADOPAGO_PUBLIC_KEY);
  assert.equal(config.accessToken, prodPair.MERCADOPAGO_ACCESS_TOKEN);
});

test('uses only the dedicated test key pair when mode is test', () => {
  const config = resolveMercadoPagoConfig({ ...prodPair, ...testPair });
  assert.equal(config.mode, 'test');
  assert.equal(config.configured, true);
  assert.equal(config.publicKey, testPair.MERCADOPAGO_TEST_PUBLIC_KEY);
  assert.equal(config.accessToken, testPair.MERCADOPAGO_TEST_ACCESS_TOKEN);
});

test('fails closed when production mode is served with a TEST public key', () => {
  const config = resolveMercadoPagoConfig({
    ...prodPair,
    MERCADOPAGO_PUBLIC_KEY: 'TEST-PUBLIC_KEY_EXAMPLE'
  });
  assert.equal(config.configured, false);
  assert.match(config.configurationError, /clave pública configurada es de prueba/i);
});

test('does not fall back to production credentials when the test pair is incomplete', () => {
  const config = resolveMercadoPagoConfig({
    ...prodPair,
    MERCADOPAGO_MODE: 'test',
    MERCADOPAGO_TEST_PUBLIC_KEY: 'TEST-PUBLIC_KEY_EXAMPLE'
  });
  assert.equal(config.configured, false);
  assert.match(config.configurationError, /MERCADOPAGO_TEST_ACCESS_TOKEN/);
});

test('rejects unknown modes and never returns the Access Token to the browser', () => {
  const invalid = resolveMercadoPagoConfig({
    MERCADOPAGO_MODE: 'sandbox',
    MERCADOPAGO_PUBLIC_KEY: prodPair.MERCADOPAGO_PUBLIC_KEY,
    MERCADOPAGO_ACCESS_TOKEN: prodPair.MERCADOPAGO_ACCESS_TOKEN
  });
  assert.equal(invalid.configured, false);
  assert.match(invalid.configurationError, /MERCADOPAGO_MODE/);

  const publicConfig = getPublicMercadoPagoConfig(resolveMercadoPagoConfig(prodPair));
  assert.equal(publicConfig.mercadopagoPublicKey, prodPair.MERCADOPAGO_PUBLIC_KEY);
  assert.equal('accessToken' in publicConfig, false);
  assert.equal(JSON.stringify(publicConfig).includes(prodPair.MERCADOPAGO_ACCESS_TOKEN), false);
});
