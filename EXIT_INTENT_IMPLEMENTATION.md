# Exit-Intent de retención — FacilitoTools

## Archivos y ubicación

- `public/home.html`: carga `exit-intent.css` y `exit-intent.js`. Es la única interfaz que incluye el modal.
- `public/exit-intent.css`: estilos del overlay, panel superior full-width, CTA y responsive.
- `public/exit-intent.js`: marcado accesible, disparadores, cierre/supresión y navegación de redención.
- `public/planes.html`: muestra el aviso de promoción cuando la visita trae la oferta emitida y transporta el token solo al elegir una opción.
- `public/checkout.html`: presenta el total con 20% y envía el token únicamente para ese checkout.
- `index.js`: emite el token firmado de corta duración y valida firma, vigencia y monto oficial en `/api/pay`.

No se copia código entre plantillas: los assets del popup se importan exclusivamente desde `home.html`; no agregarlos a `planes.html`, `checkout.html` ni a una plantilla global.

## Flujo

1. Escritorio: se dispara al salir del documento por el borde superior. Móvil: tras 20 segundos sin interacción o ante un scroll rápido hacia arriba.
2. Cerrar, rechazar, reclamar, pulsar Escape o tocar el fondo cierra el modal y guarda en `localStorage` una supresión de siete días.
3. Solo el botón **RECLAMAR MI 20% DE DESCUENTO** pide un token firmado a `POST /api/promotions/exit-intent/redeem`.
4. El usuario elige una única opción en planes/recargas; el token acompaña ese checkout. El servidor coteja el precio del plan con la tabla oficial y acepta el precio normal o el 80% únicamente con un token auténtico y vigente.
5. Navegación y compras iniciadas desde otros botones no llevan el token ni reciben el descuento.

El token caduca a las 24 horas. El descuento cambia el importe del pago; los beneficios/cupos del plan no cambian.

## Comprobación manual

- En `home.html`, simular salida por arriba en escritorio; en móvil, esperar 20 segundos o hacer un gesto rápido hacia arriba.
- Cerrar con `X` o el enlace secundario, recargar e intentar disparar el modal; debe permanecer oculto durante siete días. Para repetir la prueba, borrar `facilitotools.exitIntent.dismissedUntil` de `localStorage`.
- Pulsar el CTA, elegir un plan o recarga y comprobar que checkout muestra el precio original tachado y el precio con 20% aplicado.
- Entrar directamente a planes y seleccionar una opción: checkout debe conservar el precio íntegro.
- Una manipulación del importe o un token vencido/alterado debe ser rechazada por `/api/pay`.
