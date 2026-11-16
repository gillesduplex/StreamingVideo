"use strict";

// La navigation recharge la WebView : le gestionnaire reprend depuis les copies
// privées et les positions confirmées par le serveur, sans créer une 2e session.
(() => {
    async function restore() {
        try {
            if (!window.SVUploadManager || !window.SVUploadStore) return;
            window.SVBackgroundUploads = new SVUploadManager();
            await window.SVBackgroundUploads.restore();
        } catch (error) {
            console.warn("Impossible de reprendre les publications sur cette page.", error);
        }
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restore, { once: true });
    else restore();
})();
