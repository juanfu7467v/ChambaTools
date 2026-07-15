/**
 * returnConfig.js
 * Centraliza la lógica para el manejo de redirecciones y parámetros returnTo.
 * Configuración de rutas protegidas.
 */

const ReturnConfig = {
    /**
     * Lista de rutas que requieren autenticación para ser accedidas.
     * - api-key.html ha sido eliminada de la protección.
     * - Se han asegurado las rutas: generar-boletas.html, validar-clientes.html,
     *   planes.html, checkout.html, verificacion.html.
     */
    PROTECTED_PAGES: [
        'generar-boletas.html',
        'validar-clientes.html',
        'planes.html',
        'checkout.html',
        'verificacion.html'
    ],

    /**
     * Verifica si una ruta pertenece a las páginas protegidas.
     * @param {string} path - Ruta (absoluta o relativa, con o sin parámetros).
     * @returns {boolean} true si la página está en la lista de protección.
     */
    isProtectedPage: function(path) {
        // Normaliza la ruta: elimina barra inicial y query string
        const normalizedPath = path.replace(/^\//, '').split('?')[0];
        return this.PROTECTED_PAGES.includes(normalizedPath);
    },

    /**
     * Obtiene un parámetro de la URL por su nombre.
     * @param {string} name - Nombre del parámetro.
     * @returns {string|null} - Valor del parámetro o null si no existe.
     */
    getUrlParameter: function(name) {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(name);
    },

    /**
     * Obtiene la ruta de retorno válida (returnTo) priorizando la URL y luego el sessionStorage.
     * @returns {string|null} - La ruta de retorno decodificada o null.
     */
    getReturnPath: function() {
        let returnTo = this.getUrlParameter('returnTo');
        
        if (!returnTo || returnTo === 'null' || returnTo === 'undefined') {
            returnTo = sessionStorage.getItem('returnTo');
        }

        if (returnTo) {
            try {
                const decodedUrl = decodeURIComponent(returnTo);
                // Validar que sea una ruta relativa para evitar redirecciones abiertas (Open Redirect)
                if (decodedUrl.startsWith('/') && !decodedUrl.includes('//')) {
                    return decodedUrl;
                }
            } catch (e) {
                console.warn('URL de retorno inválida:', e);
            }
        }
        return null;
    },

    /**
     * Guarda el parámetro returnTo de la URL en el sessionStorage si existe.
     */
    saveReturnToSession: function() {
        const returnTo = this.getUrlParameter('returnTo');
        if (returnTo && returnTo !== 'null' && returnTo !== 'undefined') {
            sessionStorage.setItem('returnTo', returnTo);
        }
    },

    /**
     * Limpia el parámetro returnTo del sessionStorage.
     */
    clearReturnToSession: function() {
        sessionStorage.removeItem('returnTo');
    },

    /**
     * Ejecuta la redirección después de la autenticación.
     * @param {Object} user - Objeto de usuario de Firebase.
     * @param {string} defaultPath - Ruta por defecto si no hay returnTo.
     */
    redirectAfterAuth: function(user, defaultPath = '/actividad') {
        if (user && !user.emailVerified) {
            const returnTo = this.getUrlParameter('returnTo') || sessionStorage.getItem('returnTo');
            const verifyUrl = returnTo ? `verificacion.html?returnTo=${encodeURIComponent(returnTo)}` : "verificacion.html";
            window.location.href = verifyUrl;
            return;
        }

        const returnPath = this.getReturnPath();
        if (returnPath) {
            this.clearReturnToSession();
            window.location.href = returnPath;
        } else {
            window.location.href = defaultPath;
        }
    },

    /**
     * Redirige al login incluyendo la ruta actual como returnTo.
     */
    redirectToLogin: function() {
        // Aseguramos que la ruta comience con / para que login.html la acepte como relativa
        let currentPath = window.location.pathname + window.location.search;
        if (!currentPath.startsWith('/')) {
            currentPath = '/' + currentPath;
        }
        window.location.href = "login.html?returnTo=" + encodeURIComponent(currentPath);
    }
};

// Exportar para uso en módulos si es necesario, o dejar disponible globalmente
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReturnConfig;
}
