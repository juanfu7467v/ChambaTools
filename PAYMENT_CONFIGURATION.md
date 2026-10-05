# Configuración y diagnóstico de pagos de Mercado Pago

## Hallazgo revisado

Al consultar la configuración pública del sitio productivo se observó que `NODE_ENV` reportaba `production`, pero la clave pública entregada al checkout tenía prefijo `TEST-`. Esto confirma que el dominio público estaba sirviendo una clave de pruebas. Si el Access Token del servidor seguía siendo de producción, las credenciales no correspondían entre sí; si ambos eran de prueba, ese despliegue no podía procesar cobros reales.

El archivo de logs compartido solo mostraba `internal_error`. La versión anterior registraba el mensaje y el stack, pero descartaba el estado HTTP y los `causes` de la respuesta SDK. La corrección registra esos campos de diagnóstico sin registrar el Access Token, el token de tarjeta, el correo del pagador ni el payload completo.

## Selección de ambiente

`MERCADOPAGO_MODE` define el único ambiente activo en cada instancia. `NODE_ENV` indica el entorno de Node/Fly, no el ambiente de pagos.

| Ambiente | Variables requeridas |
| --- | --- |
| Producción | `MERCADOPAGO_MODE=production`, `MERCADOPAGO_PUBLIC_KEY`, `MERCADOPAGO_ACCESS_TOKEN` |
| Pruebas | `MERCADOPAGO_MODE=test`, `MERCADOPAGO_TEST_PUBLIC_KEY`, `MERCADOPAGO_TEST_ACCESS_TOKEN` |

No mezcles claves de aplicaciones distintas ni combines Public Key de un ambiente con Access Token de otro. La configuración de prueba usa nombres separados y no toma como respaldo las credenciales de producción. El backend no entrega el Access Token al navegador.

## Configuración en Fly.io

Mantén las credenciales exclusivamente en Fly Secrets; no las agregues al repositorio, a un archivo `.env` versionado ni a mensajes. Los siguientes comandos son plantillas: sustituye los marcadores localmente, sin enviarlos por chat.

Producción:

```sh
fly secrets set \
  MERCADOPAGO_MODE=production \
  MERCADOPAGO_PUBLIC_KEY='<Public Key de producción>' \
  MERCADOPAGO_ACCESS_TOKEN='<Access Token de producción>' \
  -a facilitotools
```

Pruebas (preferiblemente en una app de staging separada):

```sh
fly secrets set \
  MERCADOPAGO_MODE=test \
  MERCADOPAGO_TEST_PUBLIC_KEY='<Public Key de prueba>' \
  MERCADOPAGO_TEST_ACCESS_TOKEN='<Access Token de prueba>' \
  -a <nombre-de-la-app-staging>
```

Una instancia procesa **un ambiente a la vez**. Si se cambia el modo en la app productiva para probar, mientras esté en `test` no se podrán hacer cobros reales; restablece `production` antes de recibir compras. Una app de staging evita interrumpir el checkout real.

## Prueba del flujo

1. Consulta `/api/config`. Debe informar `mercadopagoMode` y `mercadopagoConfigured: true`. No publiques la respuesta completa, pues incluye la clave pública.
2. Para el Brick de tarjeta, configura credenciales de prueba y usa una tarjeta de prueba de Mercado Pago. La guía del proveedor indica usar un correo de pagador distinto del correo de la cuenta de Mercado Pago y no usar un correo de “test buyer” en el campo del Brick cuando la guía del Brick lo prohíbe.
3. Para producción, utiliza el par de producción y verifica la aprobación en el panel de Mercado Pago. Una prueba productiva genera un cobro real; no se hizo ninguna desde este cambio.
4. Si vuelve a fallar, revisa en Fly Logs los campos `httpStatus`, `providerCode` y `providerCauses` asociados a `PAY_API`. No compartas valores de Access Token ni datos de tarjeta.

## Alcance de validación

Las pruebas automatizadas del repositorio comprueban la selección y aislamiento de los pares de credenciales, el bloqueo de una clave pública `TEST-` bajo modo producción y que el Access Token no se incluya en la configuración enviada al navegador. La validación end-to-end contra Mercado Pago requiere credenciales activas en Fly y una transacción de prueba con los datos de simulación oficiales; no equivale a una compra real.

## Referencias oficiales

- [Credenciales de Mercado Pago](https://www.mercadopago.com.ar/developers/en/docs/vtex/resources/credentials)
- [Envío de pagos del Card Payment Brick](https://www.mercadopago.com.mx/developers/en/docs/checkout-bricks/card-payment-brick/payment-submission)
- [Prueba de compra con Checkout Bricks](https://www.mercadopago.com.ar/developers/en/docs/checkout-bricks/integration-test/test-payment-flow)
- [Compra de prueba con Checkout API en Perú](https://www.mercadopago.com.pe/developers/en/docs/checkout-api-payments/integration-test/make-test-purchase)
- [Integración de Yape](https://www.mercadopago.com.pe/developers/en/docs/checkout-api-payments/integration-configuration/yape)
