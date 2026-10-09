/*
 * Exit-intent de FacilitoTools.
 * Este archivo se referencia exclusivamente desde public/home.html.
 * La promoción solo se solicita al endpoint cuando se pulsa el CTA verde.
 */
(() => {
    'use strict';

    const SUPPRESSION_KEY = 'facilitotools.exitIntent.dismissedUntil';
    const SUPPRESSION_DAYS = 7;
    const MOBILE_IDLE_MS = 20_000;
    const OFFER_CODE = 'EXIT20';
    const overlay = document.createElement('div');

    overlay.id = 'exit-intent-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
        <section id="exit-intent-dialog" role="dialog" aria-modal="true" aria-labelledby="exit-intent-title" aria-describedby="exit-intent-subtitle" tabindex="-1">
            <button class="exit-intent-close" type="button" aria-label="Cerrar oferta">&times;</button>
            <p class="exit-intent-kicker"><span aria-hidden="true">✦</span> OFERTA EXCLUSIVA</p>
            <h2 class="exit-intent-title" id="exit-intent-title">¡Espera! No te vayas con las manos vacías 🚀</h2>
            <p class="exit-intent-subtitle" id="exit-intent-subtitle">Aprovecha un <strong>20% DE DESCUENTO</strong> exclusivo en tu primera compra activa hoy.</p>
            <button class="exit-intent-cta" type="button"><span>RECLAMAR MI 20% DE DESCUENTO</span><span aria-hidden="true">→</span></button>
            <p class="exit-intent-error" role="status" aria-live="polite"></p>
            <button class="exit-intent-decline" type="button">No gracias, prefiero pagar el precio completo</button>
        </section>`;

    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('#exit-intent-dialog');
    const closeButton = overlay.querySelector('.exit-intent-close');
    const declineButton = overlay.querySelector('.exit-intent-decline');
    const claimButton = overlay.querySelector('.exit-intent-cta');
    const errorMessage = overlay.querySelector('.exit-intent-error');
    let isOpen = false;
    let idleTimer = null;
    let lastScrollY = window.scrollY;
    let upwardStartedAt = 0;
    let upwardDistance = 0;
    let lastScrollAt = 0;
    let lastFocusedElement = null;

    function isSuppressed() {
        try {
            const expiresAt = Number(localStorage.getItem(SUPPRESSION_KEY));
            if (!Number.isFinite(expiresAt)) return false;
            if (expiresAt > Date.now()) return true;
            localStorage.removeItem(SUPPRESSION_KEY);
        } catch (_) {
            // Si el navegador bloquea localStorage, el modal sigue funcionando.
        }
        return false;
    }

    function suppressForAWeek() {
        try {
            localStorage.setItem(SUPPRESSION_KEY, String(Date.now() + SUPPRESSION_DAYS * 24 * 60 * 60 * 1000));
        } catch (_) {
            // El cierre no debe fallar si el almacenamiento no está disponible.
        }
    }

    async function getPromotionStatus() {
        try {
            const response = await fetch('/api/promotions/exit-intent/status', {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const result = await response.json().catch(() => ({}));
            return response.ok ? result : { eligible: false, authenticated: false, used: false };
        } catch (_) {
            return { eligible: false, authenticated: false, used: false };
        }
    }

    function showUsedPromotionState() {
        errorMessage.textContent = 'Esta promoción es válida una sola vez por usuario y ya fue utilizada en tu cuenta. Puedes elegir cualquiera de los paquetes con su precio habitual.';
        claimButton.querySelector('span').textContent = 'VER PAQUETES A PRECIO HABITUAL';
        claimButton.dataset.usedPromotion = 'true';
    }

    async function showModal({ allowUsed = false, status = null } = {}) {
        if (isOpen || isSuppressed()) return;
        const promotionStatus = status || await getPromotionStatus();
        const canShow = promotionStatus.eligible === true
            || (allowUsed && promotionStatus.authenticated === true && promotionStatus.used === true);
        if (!canShow) return;
        errorMessage.textContent = '';
        claimButton.dataset.usedPromotion = 'false';
        claimButton.querySelector('span').textContent = 'RECLAMAR MI 20% DE DESCUENTO';
        if (allowUsed && promotionStatus.used === true) showUsedPromotionState();
        isOpen = true;
        lastFocusedElement = document.activeElement;
        overlay.classList.add('is-visible');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        window.clearTimeout(idleTimer);
        window.requestAnimationFrame(() => closeButton.focus({ preventScroll: true }));
    }

    function hideModal({ suppress = true } = {}) {
        if (!isOpen) return;
        isOpen = false;
        overlay.classList.remove('is-visible');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        if (suppress) suppressForAWeek();
        if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
            lastFocusedElement.focus({ preventScroll: true });
        }
    }

    function isMobileExperience() {
        return window.matchMedia('(max-width: 767px), (pointer: coarse)').matches;
    }

    function resetInactivityTimer() {
        if (!isMobileExperience() || isOpen || isSuppressed()) return;
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(showModal, MOBILE_IDLE_MS);
    }

    // Escritorio: solo abrir cuando el puntero abandona el documento por arriba.
    document.addEventListener('mouseout', (event) => {
        if (!isMobileExperience() && event.relatedTarget === null && event.clientY <= 0) {
            showModal();
        }
    });

    // Móvil: 20 s de inactividad (el reloj vuelve a empezar ante interacción).
    ['pointerdown', 'touchstart', 'keydown', 'scroll'].forEach((eventName) => {
        window.addEventListener(eventName, resetInactivityTimer, { passive: true });
    });
    resetInactivityTimer();

    // Móvil: gesto de desplazamiento rápido hacia arriba (mín. 110 px en 450 ms).
    window.addEventListener('scroll', () => {
        if (!isMobileExperience() || isOpen || isSuppressed()) {
            lastScrollY = window.scrollY;
            return;
        }
        const now = performance.now();
        const currentY = window.scrollY;
        const deltaUp = lastScrollY - currentY;

        if (deltaUp > 0) {
            if (!upwardStartedAt || now - lastScrollAt > 180) {
                upwardStartedAt = now;
                upwardDistance = 0;
            }
            upwardDistance += deltaUp;
            if (upwardDistance >= 110 && now - upwardStartedAt <= 450) {
                showModal();
                upwardStartedAt = 0;
                upwardDistance = 0;
            }
        } else if (deltaUp < 0) {
            upwardStartedAt = 0;
            upwardDistance = 0;
        }
        lastScrollAt = now;
        lastScrollY = currentY;
    }, { passive: true });

    closeButton.addEventListener('click', () => hideModal());
    declineButton.addEventListener('click', () => hideModal());

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) hideModal();
    });

    document.addEventListener('keydown', (event) => {
        if (!isOpen) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            hideModal();
            return;
        }
        if (event.key === 'Tab') {
            const focusable = [...dialog.querySelectorAll('button:not(:disabled)')];
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });

    function redirectToLoginForPromotion() {
        hideModal({ suppress: false });
        const returnTo = '/home.html?promoPending=EXIT20';
        window.location.assign(`/login.html?returnTo=${encodeURIComponent(returnTo)}`);
    }

    claimButton.addEventListener('click', async () => {
        if (claimButton.dataset.usedPromotion === 'true') {
            hideModal({ suppress: false });
            window.location.assign('/planes.html#planes-cards');
            return;
        }
        if (claimButton.disabled) return;
        claimButton.disabled = true;
        errorMessage.textContent = '';
        claimButton.querySelector('span').textContent = 'ACTIVANDO TU OFERTA…';

        try {
            const promotionStatus = await getPromotionStatus();
            if (promotionStatus.authenticated !== true) {
                redirectToLoginForPromotion();
                return;
            }
            if (promotionStatus.used === true) {
                claimButton.disabled = false;
                showUsedPromotionState();
                return;
            }

            const response = await fetch('/api/promotions/exit-intent/redeem', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ campaign: OFFER_CODE })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.token) {
                throw new Error(result.error || 'No pudimos activar el descuento. Inténtalo de nuevo.');
            }

            // El cupón se lleva únicamente por este camino de redención explícita.
            const destination = new URL('/planes.html', window.location.origin);
            destination.searchParams.set('promo', OFFER_CODE);
            destination.searchParams.set('offerToken', result.token);
            destination.hash = 'planes-cards';
            suppressForAWeek();
            window.location.assign(destination.toString());
        } catch (error) {
            errorMessage.textContent = error.message || 'No pudimos activar el descuento. Inténtalo de nuevo.';
            claimButton.querySelector('span').textContent = 'RECLAMAR MI 20% DE DESCUENTO';
            claimButton.disabled = false;
        }
    });

    const pendingPromotion = new URLSearchParams(window.location.search).get('promoPending') === OFFER_CODE;
    if (pendingPromotion) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('promoPending');
        window.history.replaceState({}, document.title, `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
        (async () => {
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const status = await getPromotionStatus();
                if (status.authenticated === true || attempt === 4) {
                    await showModal({ allowUsed: true, status });
                    return;
                }
                await new Promise(resolve => window.setTimeout(resolve, 250));
            }
        })();
    }
})();
