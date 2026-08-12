/**
 * Floating panel geometry: drag, corner resize and viewport-clamped persistence.
 *
 * Adapted from the pointer-capture approach used by SillyTavern-MultihogDnDFramework
 * (ui-geometry.js), trimmed to the two corners this panel actually exposes.
 */

const MIN_WIDTH = 280;
const MIN_HEIGHT = 220;

export function isMobileLayout() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches;
}

export function canResize() {
    return !isMobileLayout();
}

/**
 * Clamp saved geometry so the header always stays grabbable, even after the
 * window moved to a smaller screen.
 *
 * @param {{left?:number, top?:number, width?:number, height?:number}|null|undefined} saved
 * @param {{defaultLeft?:number, defaultTop?:number, defaultWidth?:number, defaultHeight?:number}} [opts]
 * @returns {{left:number, top:number, width:number, height:number}}
 */
export function clampGeometry(saved, opts = {}) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let width = Math.max(MIN_WIDTH, Number(saved?.width) || opts.defaultWidth || 420);
    let height = Math.max(MIN_HEIGHT, Number(saved?.height) || opts.defaultHeight || 520);
    let left = typeof saved?.left === 'number' ? saved.left : (opts.defaultLeft ?? Math.max(12, vw - width - 32));
    let top = typeof saved?.top === 'number' ? saved.top : (opts.defaultTop ?? 64);

    left = Math.max(0, Math.min(Math.max(0, vw - 120), left));
    top = Math.max(0, Math.min(Math.max(0, vh - 48), top));
    width = Math.min(width, Math.max(MIN_WIDTH, vw - left - 8));
    height = Math.min(height, Math.max(MIN_HEIGHT, vh - top - 8));

    return { left, top, width, height };
}

/**
 * @param {string} key
 * @returns {{left?:number, top?:number, width?:number, height?:number}|null}
 */
export function loadGeometry(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/**
 * @param {HTMLElement} panel
 * @param {string} key
 */
export function saveGeometry(panel, key) {
    if (!panel || panel.style.display === 'none' || isMobileLayout()) return;
    const rect = panel.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const collapsed = panel.classList.contains('btw-collapsed');
    const previous = loadGeometry(key) || {};
    try {
        localStorage.setItem(key, JSON.stringify({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            // A collapsed panel is header-height only; keep the expanded height.
            height: collapsed ? (previous.height || rect.height) : rect.height,
        }));
    } catch { /* storage full or blocked — geometry is disposable */ }
}

/**
 * Apply stored (or default) geometry to the panel. On mobile the panel is a
 * near-fullscreen sheet, driven entirely by CSS.
 *
 * @param {HTMLElement} panel
 * @param {string} key
 */
export function applyGeometry(panel, key) {
    if (isMobileLayout()) {
        for (const prop of ['left', 'top', 'width', 'height', 'right', 'bottom', 'maxHeight']) {
            panel.style.removeProperty(prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
        }
        return;
    }
    const geo = clampGeometry(loadGeometry(key));
    panel.style.left = `${geo.left}px`;
    panel.style.top = `${geo.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.width = `${geo.width}px`;
    if (!panel.classList.contains('btw-collapsed')) panel.style.height = `${geo.height}px`;
}

/**
 * Keep the mobile sheet inside the *visual* viewport, so the virtual keyboard
 * cannot cover the composer.
 *
 * A fixed panel is laid out against the layout viewport, and the keyboard does
 * not reliably shrink that: iOS Safari ignores `interactive-widget` and only
 * shrinks the visual viewport, so `100dvh` stays full height and the bottom of
 * the sheet ends up behind the keyboard. Mirroring `visualViewport` into two
 * custom properties puts it back. Where the layout viewport *does* resize
 * (Android Chrome honouring `resizes-content`) the two agree, so this is a
 * no-op there rather than a second, competing rule.
 *
 * @param {HTMLElement} panel
 * @param {() => void} [onChange] runs after each apply, for scroll fix-ups
 * @returns {() => void} teardown
 */
export function trackVisualViewport(panel, onChange) {
    const viewport = window.visualViewport;
    if (!viewport) return () => { /* no API — CSS dvh fallback stands */ };

    let frame = 0;
    const apply = () => {
        frame = 0;
        if (!isMobileLayout()) {
            panel.style.removeProperty('--btw-vv-top');
            panel.style.removeProperty('--btw-vv-height');
            return;
        }
        // offsetTop is the visual viewport's offset *within* the layout viewport,
        // which is exactly the frame a fixed element is positioned against.
        panel.style.setProperty('--btw-vv-top', `${viewport.offsetTop}px`);
        panel.style.setProperty('--btw-vv-height', `${viewport.height}px`);
        onChange?.();
    };
    // Both events can fire per frame while the keyboard animates in.
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(apply);
    };

    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    apply();

    return () => {
        if (frame) cancelAnimationFrame(frame);
        viewport.removeEventListener('resize', schedule);
        viewport.removeEventListener('scroll', schedule);
        panel.style.removeProperty('--btw-vv-top');
        panel.style.removeProperty('--btw-vv-height');
    };
}

/**
 * @param {HTMLElement} panel
 * @param {HTMLElement} handle
 * @param {string} key
 * @returns {() => void} teardown
 */
export function makeDraggable(panel, handle, key) {
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const onPointerDown = (/** @type {PointerEvent} */ e) => {
        if (e.button !== 0 || isMobileLayout()) return;
        if (e.target instanceof Element && e.target.closest('button, input, select, textarea, a')) return;
        dragging = true;
        handle.setPointerCapture(e.pointerId);
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        panel.style.left = `${startLeft}px`;
        panel.style.top = `${startTop}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        e.preventDefault();
    };

    const onPointerMove = (/** @type {PointerEvent} */ e) => {
        if (!dragging) return;
        const left = Math.max(0, Math.min(window.innerWidth - 120, startLeft + (e.clientX - startX)));
        const top = Math.max(0, Math.min(window.innerHeight - 48, startTop + (e.clientY - startY)));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    };

    const onPointerUp = (/** @type {PointerEvent} */ e) => {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        saveGeometry(panel, key);
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);

    return () => {
        dragging = false;
        handle.removeEventListener('pointerdown', onPointerDown);
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerUp);
    };
}

/**
 * Corner resizer. `corner` picks which edges follow the pointer.
 *
 * @param {HTMLElement} panel
 * @param {HTMLElement} handle
 * @param {string} key
 * @param {'br'|'bl'} corner
 */
export function makeResizable(panel, handle, key, corner) {
    let startX = 0, startY = 0, startWidth = 0, startHeight = 0, startLeft = 0, startTop = 0;

    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !canResize()) return;
        handle.setPointerCapture(e.pointerId);
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startWidth = rect.width; startHeight = rect.height;
        startLeft = rect.left; startTop = rect.top;
        panel.style.left = `${startLeft}px`;
        panel.style.top = `${startTop}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.maxHeight = 'none';
        e.preventDefault();
        e.stopPropagation();
    });

    handle.addEventListener('pointermove', (e) => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        panel.style.height = `${Math.max(MIN_HEIGHT, startHeight + dy)}px`;

        if (corner === 'br') {
            panel.style.width = `${Math.max(MIN_WIDTH, startWidth + dx)}px`;
            return;
        }
        const width = startWidth - dx;
        if (width > MIN_WIDTH) {
            panel.style.width = `${width}px`;
            panel.style.left = `${startLeft + dx}px`;
        }
    });

    const release = (/** @type {PointerEvent} */ e) => {
        try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        saveGeometry(panel, key);
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
}

/**
 * Debounced geometry persistence for programmatic resizes.
 *
 * @param {HTMLElement} panel
 * @param {string} key
 * @returns {ResizeObserver|null}
 */
export function observeResize(panel, key) {
    const Observer = globalThis.ResizeObserver;
    if (typeof Observer !== 'function') return null;
    let timer;
    let firstFired = false;
    const observer = new Observer(() => {
        // The first callback fires before restored geometry is painted; ignoring it
        // stops the CSS default from overwriting the saved position.
        if (!firstFired) { firstFired = true; return; }
        clearTimeout(timer);
        timer = setTimeout(() => saveGeometry(panel, key), 300);
    });
    observer.observe(panel);
    return observer;
}
