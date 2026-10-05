# Mercado Pago: cambio entre pruebas y producción

## Flujo de credenciales

La integración usa los mismos dos secrets en ambos ambientes:

- `MERCADOPAGO_PUBLIC_KEY`
- `MERCADOPAGO_ACCESS_TOKEN`

Para probar, coloca en esos secrets el par de **credenciales de prueba** de la aplicación de Mercado Pago y redepliega. Cuando terminen las pruebas, reemplaza ambos valores por el par de **producción** y redepliega otra vez. No hacen falta variables `MERCADOPAGO_TEST_*` ni un secret `MERCADOPAGO_MODE`.

Actualiza **los dos valores juntos** y asegúrate de que sean del mismo ambiente y de la misma aplicación. En esta integración, el servidor identifica el modo de prueba por el prefijo `TEST-` de la Public Key; de lo contrario usa producción. No se intenta inferir el modo desde el Access Token: la documentación de Mercado Pago indica que un Access Token de prueba también puede comenzar con `APP_USR`, igual que uno productivo.

## Comandos de Fly.io

Usa estos comandos solo como plantillas; reemplaza los marcadores directamente en tu terminal y nunca compartas los valores por chat ni los guardes en el repositorio.

Para probar:

```sh
fly secrets set \
  MERCADOPAGO_PUBLIC_KEY='<Public Key de prueba>' \
  MERCADOPAGO_ACCESS_TOKEN='<Access Token de prueba>' \
  -a facilitotools
```

Al terminar las pruebas, volver a producción:

```sh
fly secrets set \
  MERCADOPAGO_PUBLIC_KEY='<Public Key de producción>' \
  MERCADOPAGO_ACCESS_TOKEN='<Access Token de producción>' \
  -a facilitotools
```

Solo un par está activo en cada despliegue. `NODE_ENV=production` describe el entorno de Node/Fly; no reemplaza las credenciales productivas de Mercado Pago.

## Diagnóstico y seguridad

En la revisión anterior, la configuración pública de `facilitotools.com` estaba entregando una Public Key `TEST-` en el host productivo. Eso significa que ese checkout estaba usando el entorno de prueba; si se esperaba cobrar compras reales, debía reemplazarse el par por el de producción.

El endpoint `/api/config` informa `mercadopagoMode` (`test` o `production`) y si hay un par configurado. El navegador recibe la Public Key, que Mercado Pago utiliza en el frontend, pero **nunca** recibe el Access Token. No compartas la respuesta completa de ese endpoint.

Si Mercado Pago vuelve a responder con error, Fly Logs ahora conserva `httpStatus`, `providerCode` y `providerCauses` asociados a `PAY_API`, sin registrar el Access Token, el token de tarjeta ni el correo del pagador.

## Pruebas

Las pruebas automatizadas del repositorio verifican que ambos ambientes se seleccionen con los mismos nombres de secrets, que el modo de prueba se tome de la Public Key y que el Access Token no se envíe al navegador. No se ejecutaron cobros reales ni una transacción end-to-end con las credenciales privadas de Fly.

Para probar el Brick de tarjetas, sigue el flujo oficial de pruebas de Mercado Pago: usa el par de prueba y una tarjeta de prueba; el proveedor también indica usar un correo de pagador distinto al correo utilizado en Mercado Pago. Verifica el estado de la operación antes de intentar nuevamente tras un error del servidor.

## Documentación oficial consultada

- [Credenciales: pares de prueba y producción](https://www.mercadopago.com.ar/developers/en/docs/vtex/resources/credentials)
- [Creación de aplicación y credenciales de prueba](https://www.mercadopago.com.mx/developers/en/docs/checkout-api-orders/create-application)
- [Prueba de compra con Checkout Bricks](https://www.mercadopago.com.ar/developers/en/docs/checkout-bricks/integration-test/test-payment-flow)
- [Envío de pagos del Card Payment Brick](https://www.mercadopago.com.mx/developers/en/docs/checkout-bricks/card-payment-brick/payment-submission)
