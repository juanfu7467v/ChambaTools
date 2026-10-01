
## Baja de cuenta desde actividad.html

Se corrigió el botón **Darme de baja**, que apuntaba a `/api/user/deactivate` aunque esa ruta no existía. Ahora el backend:

- Exige la sesión firmada y un ID token Firebase del mismo usuario.
- Comprueba que `auth_time` sea inferior a cinco minutos.
- Devuelve `auth/requires-recent-login` cuando se necesita reautenticación.
- Elimina los documentos de usuario, empresa, emisor, logos, API Keys y pagos asociados.
- Elimina finalmente la cuenta de Firebase Authentication.

El frontend reautentica automáticamente según el proveedor:

- Correo/contraseña: solicita la contraseña actual.
- Google: abre reautenticación Google.
- GitHub: abre reautenticación GitHub.

Después de una reautenticación exitosa, reintenta la baja una sola vez y cierra correctamente la sesión. Los errores ya no muestran una instrucción genérica de contactar soporte cuando pueden resolverse desde la interfaz.
