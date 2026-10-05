import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublicMercadoPagoConfig, resolveMercadoPagoConfig } from '../mercadopagoConfig.js';

const productionPair = {
  MERCADOPAGO_PUBLIC_KEY: 'APP_USR_PRODUCTION_PUBLIC_KEY_EXAMPLE',
  MERCADOPAGO_ACCESS_TOKEN: 'APP_USR_PRODUCTION_ACCESS_TOKEN_EXAMPLE'
};
const testPair = {
  MERCADOPAGO_PUBLIC_KEY: 'TEST-PUBLIC_KEY_EXAMPLE',
  // Mercado Pago documenta que un Access Token de prueba también puede
  // empezar con APP_USR; el modo se toma de la Public Key, no de este token.
  MERCADOPAGO_ACCESS_TOKEN: 'APP_USR_TEST_ACCESS_TOKEN_EXAMPLE'
};

test('uses the two generic secrets and resolves a production Public Key as production', () => {
  const config = resolveMercadoPagoConfig(productionPair);
  assert.equal(config.mode, 'production');
  assert.equal(config.configured, true);
  assert.equal(config.publicKey, productionPair.MERCADOPAGO_PUBLIC_KEY);
  assert.equal(config.accessToken, productionPair.MERCADOPAGO_ACCESS_TOKEN);
});

test('resolves a TEST Public Key as test while keeping the same generic secret names', () => {
  const config = resolveMercadoPagoConfig(testPair);
  assert.equal(config.mode, 'test');
  assert.equal(config.configured, true);
  assert.equal(config.publicKey, testPair.MERCADOPAGO_PUBLIC_KEY);
  assert.equal(config.accessToken, testPair.MERCADOPAGO_ACCESS_TOKEN);
});

test('does not require or honor an extra MERCADOPAGO_MODE variable', () => {
  const config = resolveMercadoPagoConfig({
    ...testPair,
    MERCADOPAGO_MODE: 'production'
  });
  assert.equal(config.configured, true);
  assert.equal(config.mode, 'test');
});

test('reports missing generic credential names without returning a partial configuration', () => {
  const config = resolveMercadoPagoConfig({
    MERCADOPAGO_PUBLIC_KEY: 'TEST-PUBLIC_KEY_EXAMPLE'
  });
  assert.equal(config.configured, false);
  assert.equal(config.mode, 'test');
  assert.match(config.configurationError, /MERCADOPAGO_ACCESS_TOKEN/);
  assert.equal(getPublicMercadoPagoConfig(config).mercadopagoPublicKey, null);
});

test('never sends the Access Token in the browser configuration', () => {
  const config = resolveMercadoPagoConfig(productionPair);
  const publicConfig = getPublicMercadoPagoConfig(config);
  assert.equal(publicConfig.mercadopagoPublicKey, productionPair.MERCADOPAGO_PUBLIC_KEY);
  assert.equal(publicConfig.mercadopagoMode, 'production');
  assert.equal('accessToken' in publicConfig, false);
  assert.equal(JSON.stringify(publicConfig).includes(productionPair.MERCADOPAGO_ACCESS_TOKEN), false);
});
