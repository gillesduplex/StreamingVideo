"use strict";

// Le plein écran conserve le lecteur actif : seul son conteneur change de taille.
window.SVFullscreenPlayer = class {
    constructor({ scene, button, icon, toast }) {
        this.scene = scene;
        this.button = button;
        this.icon = icon;
        this.toast = toast;
        this.duration = 0;
        this.active = false;
        this.opening = false;
        this.closing = false;
        this.nativeFullscreen = false;
        this.orientationMode = null;
        this.previousLandscape = null;
        this.releaseOrientation = null;
        this.generation = 0;
        button.addEventListener("click", () => this.active ? this.close() : this.open());
        document.addEventListener("fullscreenchange", () => {
            if (this.nativeFullscreen && document.fullscreenElement !== this.scene) this.close();
        });
        this.backButton = event => {
            event.preventDefault();
            this.close();
        };
        window.addEventListener("pagehide", () => this.close());
        this.render();
    }

    setDuration(duration) {
        this.duration = Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : 0;
        this.render();
    }

    render() {
        this.button.hidden = !this.active && this.duration <= 60;
        this.button.setAttribute("aria-label", this.active ? "Quitter le plein écran" : "Passer en plein écran");
        this.button.setAttribute("aria-pressed", String(this.active));
        this.button.replaceChildren(this.icon(this.active ? "collapse" : "expand"));
    }

    async lockLandscape() {
        const native = window.cordova?.plugins?.SVScreenOrientation;
        if (native?.landscape && native?.restore) {
            try {
                await new Promise((resolve, reject) => native.landscape(resolve, reject));
                return () => new Promise((resolve, reject) => native.restore(resolve, reject));
            } catch (error) { console.warn("Orientation Android indisponible :", error); }
        }
        if (typeof screen.orientation?.lock === "function") {
            try {
                await screen.orientation.lock("landscape");
                return () => screen.orientation.unlock();
            } catch (error) { console.warn("Orientation navigateur indisponible :", error); }
        }
        return null;
    }

    waitForOrientation(landscape) {
        const query = window.matchMedia("(orientation: landscape)");
        if (query.matches === landscape) return Promise.resolve(true);
        return new Promise(resolve => {
            let timer;
            const finish = changed => {
                clearTimeout(timer);
                window.removeEventListener("orientationchange", check);
                window.removeEventListener("resize", check);
                window.screen?.orientation?.removeEventListener?.("change", check);
                resolve(changed);
            };
            const check = () => {
                if (query.matches === landscape) finish(true);
            };
            window.addEventListener("orientationchange", check);
            window.addEventListener("resize", check);
            window.screen?.orientation?.addEventListener?.("change", check);
            timer = setTimeout(() => finish(query.matches === landscape), 1500);
            check();
        });
    }

    async open() {
        if (this.active || this.opening || this.closing || this.duration <= 60) return;
        const generation = ++this.generation;
        const nativeOrientation = !!window.cordova?.plugins?.SVScreenOrientation?.landscape;
        const previousLandscape = window.matchMedia("(orientation: landscape)").matches;
        this.orientationMode = nativeOrientation ? "native" : "browser";
        this.previousLandscape = previousLandscape;
        this.active = true;
        this.opening = true;
        document.addEventListener("backbutton", this.backButton);
        this.render();
        try {
            if (nativeOrientation) {
                const release = await this.lockLandscape();
                this.releaseOrientation = release;
                if (generation !== this.generation || !this.active) {
                    if (this.releaseOrientation === release) {
                        this.releaseOrientation = null;
                        try { await release?.(); } catch (error) { console.warn("Restauration de l'orientation impossible :", error); }
                    }
                    await this.waitForOrientation(previousLandscape);
                    return;
                }
                const rotated = release ? await this.waitForOrientation(true) : false;
                if (generation !== this.generation || !this.active) {
                    if (this.releaseOrientation === release) {
                        this.releaseOrientation = null;
                        try { await release?.(); } catch (error) { console.warn("Restauration de l'orientation impossible :", error); }
                    }
                    await this.waitForOrientation(previousLandscape);
                    return;
                }
                this.scene.classList.add("video-fullscreen");
                document.dispatchEvent?.(new Event("sv:feed-layout-change"));
                if (!release || !rotated) this.toast("Tourne ton téléphone en paysage pour agrandir la vidéo.");
                return;
            }

            this.scene.classList.add("video-fullscreen");
            document.dispatchEvent?.(new Event("sv:feed-layout-change"));
            if (typeof this.scene.requestFullscreen === "function") {
                try {
                    await this.scene.requestFullscreen({ navigationUI: "hide" });
                    this.nativeFullscreen = document.fullscreenElement === this.scene;
                    if (generation !== this.generation || !this.active) {
                        if (this.nativeFullscreen) await document.exitFullscreen().catch(() => {});
                        this.nativeFullscreen = false;
                        return;
                    }
                    // L'utilisateur peut avoir quitté le plein écran système
                    // pendant que sa demande était encore en cours.
                    if (!this.nativeFullscreen) { this.close(); return; }
                } catch (error) { console.warn("Plein écran système indisponible :", error); }
            }
            if (generation !== this.generation || !this.active) return;
            const release = await this.lockLandscape();
            if (generation !== this.generation || !this.active) {
                try { await release?.(); } catch (error) { console.warn("Restauration de l'orientation impossible :", error); }
                await this.waitForOrientation(previousLandscape);
                return;
            }
            this.releaseOrientation = release;
            document.dispatchEvent?.(new Event("sv:feed-layout-change"));
            if (!release && window.matchMedia("(orientation: portrait)").matches) {
                this.toast("Tourne ton téléphone en paysage pour agrandir la vidéo.");
            }
        } finally {
            this.opening = false;
            this.render();
        }
    }

    async close() {
        if (this.closing) return;
        if (!this.active && !this.opening && !this.releaseOrientation) return;
        this.closing = true;
        this.active = false;
        ++this.generation;
        document.removeEventListener("backbutton", this.backButton);
        this.render();
        const release = this.releaseOrientation;
        this.releaseOrientation = null;
        const nativeOrientation = this.orientationMode === "native";
        if (!nativeOrientation) {
            document.dispatchEvent?.(new Event("sv:feed-layout-change"));
            this.scene.classList.remove("video-fullscreen");
            if (document.fullscreenElement === this.scene && typeof document.exitFullscreen === "function") {
                try { await document.exitFullscreen(); }
                catch (error) { console.warn("Sortie du plein écran impossible :", error); }
            }
            this.nativeFullscreen = false;
        }
        if (release) {
            try { await release(); }
            catch (error) { console.warn("Restauration de l'orientation impossible :", error); }
        }
        if (this.previousLandscape !== null) await this.waitForOrientation(this.previousLandscape);
        if (nativeOrientation) {
            this.scene.classList.remove("video-fullscreen");
        }
        document.dispatchEvent?.(new Event("sv:feed-layout-change"));
        this.orientationMode = null;
        this.previousLandscape = null;
        this.closing = false;
        this.render();
    }
};
