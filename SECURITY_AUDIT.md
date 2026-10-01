
## Incidente posterior: bucle login → actividad → login

Los logs de Fly.io mostraron repetidamente `LOGIN_SUCCESS_API: ID token de Firebase inválido o ausente` y, durante el arranque, `Cannot read properties of undefined (reading 'cert')`. La causa era la actualización a `firebase-admin@14.5.0`: la aplicación seguía usando la API namespaced antigua (`admin.credential`, `admin.auth`, `admin.firestore`), mientras que esa versión expone las APIs como módulos (`firebase-admin/app`, `/auth`, `/firestore`). Firebase Admin no se inicializaba, por lo que `/api/login-success` no podía verificar el ID token ni emitir las cookies de sesión.

Se añadió `firebaseCompat.js`, una fachada compatible basada en las APIs modulares actuales, y se migraron todos los módulos del servidor a ella. Además, `login.html` ahora espera y valida la respuesta de `/api/login-success`, incluye `credentials: 'same-origin'`, evita solicitudes duplicadas y no redirige a `actividad.html` si el backend no confirmó la sesión.

La prueba de runtime confirmó que el servidor inicia, `/api` responde `200` y un `/api/login-success` sin token responde `401` controladamente, sin errores de compatibilidad Firebase.
