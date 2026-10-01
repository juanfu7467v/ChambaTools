# Auditoría de seguridad de ChambaTools

**Fecha:** 2026-10-01  
**Repositorio:** `juanfu7467v/ChambaTools`  
**Base revisada:** clonación fresca de `main` en `b2ac08c`

## Resumen

Se revisaron el servidor Express, autenticación, cookies, autorización, APIs de comprobantes y validación, pagos Mercado Pago, webhooks, Firestore/Admin SDK, generación de HTML/PDF, cabeceras, CORS, Docker/Fly y dependencias npm.

Se corrigieron vulnerabilidades de autorización de alto impacto que permitían suplantar un `uid` mediante cookies o cuerpos de petición, además de exposición de datos de pagos, ausencia de límites globales y una condición de carrera al consumir comprobantes.

## Hallazgos corregidos

| Severidad | Hallazgo | Corrección |
|---|---|---|
| Crítica | `user_uid` era una cookie httpOnly pero **no firmada**; cualquier cliente podía fabricarla para acceder a otro usuario. | Se configuró `cookie-parser` con secreto de servidor, se firman las cookies y todas las rutas usan únicamente `req.signedCookies` mediante `getAuthenticatedUid`. |
| Crítica | IDOR en `/api/comprobantes/preview` y `/api/comprobantes/pdf`: el `uid` se aceptaba desde el body. | El usuario se obtiene exclusivamente de la cookie firmada; el `uid` del body ya no autoriza nada. |
| Alta | `/api/user/plan` consultaba el `uid` de la query y podía revelar plan, cupos y consumo de cualquier cuenta. | La ruta usa la identidad autenticada y responde `401` sin sesión válida. |
| Alta | Rutas de `/api/validar/*` y autogestión de API Keys confiaban en cookies sin firma. | Se migraron al mismo mecanismo de sesión firmada. |
| Alta | Endpoints de estado/detalle de pagos permitían consultar información por identificador sin comprobar propietario. | Se exige que el `uid` de la sesión coincida con `data.uid`; los recursos no pertenecientes responden `404`. |
| Alta | `/api/invoice/:paymentId` podía devolver la factura sin autenticación. | Se protege la variante `/api/invoice/*`; `/boleta/*` se conserva como URL pública intencional de compartir, sin cambios de comportamiento. |
| Alta | `/api/pay` aceptaba `uid` controlado por el cliente. | El `uid` se deriva de la sesión firmada; se eliminó el `uid` del body como fuente de autorización. También se validan monto, correo e installments. |
| Alta | Condición de carrera en el contador de comprobantes: solicitudes concurrentes podían superar el límite. | `incrementarRecibos` ahora verifica límite/estado y actualiza el contador en una transacción Firestore atómica. |
| Media | Ausencia de defensa CSRF explícita en mutaciones con cookies. | Se rechazan peticiones mutables con `Origin` no permitido cuando llevan sesión firmada; se mantienen webhooks y peticiones sin `Origin`. |
| Media | Sin rate limit global efectivo pese a existir la dependencia. | Se añadió límite global de 300 solicitudes/15 min y límite específico de autenticación de 30/15 min. |
| Media | Revocación de API Keys podía tardar hasta 5 minutos en reflejarse por caché. | TTL de caché reducido a 30 segundos. |
| Media | Confiar directamente en `X-Forwarded-For` permitía falsificar IP en logs y controles auxiliares. | Se usa `req.ip` con `trust proxy` configurado para el proxy de despliegue. |
| Media | `taxRate`, moneda y número de ítems no tenían límites de entrada suficientes. | Se validan tasa `0..1`, moneda ISO de tres letras, máximo 200 ítems y longitud de descripción. |
| Media | Instalación Docker no era reproducible y usaba `npm install`. | Se añadió `package-lock.json` y Docker usa `npm ci --omit=dev`. |
| Alta | `npm audit` reportaba vulnerabilidades críticas/moderadas en `jspdf`, Firebase Admin, Mercado Pago, `tar`, `uuid` y transitivas. | Se actualizaron `firebase-admin`, `jspdf`, `mercadopago`, se eliminó `firebase-tools` del runtime/dependencias del proyecto, se retiró el paquete npm innecesario `crypto` y se fijó un override seguro de `uuid`. |
| Media | `Resend` podía impedir el arranque completo si faltaba `RESEND_API_KEY`. | La inicialización ahora es tolerante: el servicio arranca y deja el correo deshabilitado con advertencia controlada. |
| Media | La inicialización usaba `admin.apps`, incompatible con Firebase Admin actualizado. | Se migró a `admin.getApps()`. |
| Media | El middleware de HTML construía rutas con `path.join` sin una comprobación explícita de confinamiento. | Se usa `path.resolve` y se rechazan rutas fuera de `public/`. |

## Validaciones ejecutadas

- `node --check` sobre todos los módulos JavaScript: **PASS**.
- `git diff --check`: **PASS**.
- `npm audit --omit=dev --audit-level=moderate`: **0 vulnerabilidades**.
- Pruebas de normalización/renderizado: escape de HTML, validación de impuestos y rechazo de entradas inválidas: **PASS**.
- Prueba HTTP de arranque en modo sin secretos: servidor inicia, `/api` responde `200`, `/api/user/plan?uid=...` responde `401` y comprobantes con `uid` falsificado responden `401`: **PASS**.
- La generación de PDF/HTML usa datos escapados y se mantienen los límites de plan existentes.

## Riesgos residuales y acciones de despliegue

1. **Configurar `SESSION_COOKIE_SECRET` como secreto persistente** en Fly.io. Si no se configura, se genera un secreto efímero y todas las sesiones se invalidan al reiniciar.
2. Configurar `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PROJECT_ID` y `FIREBASE_PRIVATE_KEY_ID` mediante secrets, nunca en Git.
3. `firestore.rules.new` es un fragmento aditivo y no está referenciado por `firebase.json`; debe integrarse y desplegarse con las reglas completas del proyecto tras revisar las reglas existentes. El backend usa Admin SDK y por ello las reglas no sustituyen la autorización de estas rutas.
4. Se recomienda configurar una política de precios en servidor para comparar el monto de Mercado Pago con el `planId`, ya que el código actual valida la forma y el resultado aprobado del procesador, pero no contiene un mapa de precios server-side.
5. La URL pública `/boleta/:paymentIdWithExt` se conserva por compatibilidad con enlaces compartibles; si las facturas no deben ser públicas, debe eliminarse esa ruta o migrarse a tokens de descarga aleatorios con expiración.

## Archivos modificados

- `index.js`
- `seguridad.js`
- `developerApi.js`
- `validarClientes.js`
- `plantillas.js`
- `negocios.js`
- `Dockerfile`
- `package.json`
- `package-lock.json`
- `.gitignore`
