"use strict";

// Deux décodeurs au maximum : la vidéo visible et le début de la suivante.
// Les couvertures sont indépendantes des éléments <video> et de leurs états réseau.
SV.VideoFeed = class VideoFeed {
    constructor(container, callbacks = {}) {
        this.container = container;
        this.viewport = container.parentElement;
        this.hud = document.getElementById("publicationCourante");
        this.callbacks = callbacks;
        this.items = [];
        this.cards = new Map();
        // Historique de session partagé entre les pages, effacé à l'actualisation.
        this.watchHistory = new Map();
        this.historyKey = "sv.watch-history.session.v1";
        this.historyLastSave = 0;
        this.restoreHistory();
        this.slots = [this.createSlot(), this.createSlot()];
        this.active = null;
        this.index = -1;
        this.wantPlayback = true;
        this.suspended = false;
        this.sound = false;
        this.scrolling = false;
        this.touching = false;
        this.scrollTarget = null;
        this.destroyed = false;
        this.mutating = false;
        this.status = "";
        this.bandwidth = null;
        this.events = new AbortController();
        const listen = (target, name, callback, options = {}) => target.addEventListener(name, callback, { ...options, signal: this.events.signal });
        listen(container, "scroll", () => this.handleScroll(), { passive: true });
        listen(container, "scrollend", () => this.settle());
        listen(container, "touchstart", event => {
            this.touching = true;
            this.scrollTarget = null;
            // Une nouvelle tape est une nouvelle intention, même juste après un swipe.
            this.suppressClickUntil = 0;
            const touch = event.changedTouches[0];
            this.gesture = { x: touch.clientX, y: touch.clientY, index: this.index, scrollTop: container.scrollTop };
        }, { passive: true });
        const endTouch = event => {
            this.touching = false;
            const gesture = this.gesture;
            this.gesture = null;
            clearTimeout(this.scrollTimer);
            if (gesture && event.type === "touchend") {
                const touch = event.changedTouches[0];
                const deltaY = touch.clientY - gesture.y;
                const deltaX = touch.clientX - gesture.x;
                const moved = Math.abs(deltaY) > 8 || Math.abs(deltaX) > 8 || Math.abs(container.scrollTop - gesture.scrollTop) > 2;
                // Une simple tape ne doit ni sélectionner à nouveau la carte ni
                // annuler le clic de pause différé pour reconnaître le double-tap.
                if (!moved && !this.scrolling) return;
                this.suppressClickUntil = Date.now() + 400;
                // Le navigateur suit le doigt. Au relâchement, un geste vertical
                // volontaire choisit la carte voisine même s'il couvre moins d'un demi-écran.
                if (Math.abs(deltaY) >= 60 && Math.abs(deltaY) > Math.abs(deltaX)) {
                    const target = Math.max(0, Math.min(this.items.length - 1, gesture.index + (deltaY < 0 ? 1 : -1)));
                    this.scrollTarget = target;
                    this.suppressClickUntil = Date.now() + 400;
                    requestAnimationFrame(() => {
                        if (this.destroyed || this.touching || this.scrollTarget !== target) return;
                        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                        this.container.scrollTo({ top: target * this.container.clientHeight, behavior: reduced ? "instant" : "smooth" });
                    });
                } else if (gesture.index === this.index && Math.abs(deltaX) >= 60 && Math.abs(deltaX) > Math.abs(deltaY) &&
                    this.items[gesture.index]?.media_type === "photo") {
                    this.navigatePhoto(deltaX < 0 ? 1 : -1);
                }
            }
            this.scrollTimer = setTimeout(() => this.settle(), 120);
        };
        listen(container, "touchend", endTouch, { passive: true });
        listen(container, "touchcancel", endTouch, { passive: true });
        listen(container, "wheel", () => { this.scrollTarget = null; }, { passive: true });
        listen(container, "click", event => {
            if (Date.now() < (this.suppressClickUntil || 0) || event.target.closest("button,a,input")) return;
            clearTimeout(this.clickTimer);
            if (event.detail < 2) this.clickTimer = setTimeout(() => this.callbacks.onTap?.(), 240);
        });
        listen(container, "dblclick", event => {
            if (Date.now() < (this.suppressClickUntil || 0)) return;
            event.preventDefault();
            clearTimeout(this.clickTimer);
            this.callbacks.onDoubleTap?.();
        });
        listen(window, "offline", () => this.checkHealth());
        listen(window, "online", () => this.recover());
        listen(window, "pagehide", () => { this.remember(this.active, true); this.persistHistory(); });
        // Une rotation redimensionne le fil avant que son ancienne position en
        // pixels soit recalculée. Elle ne représente pas un geste utilisateur.
        listen(window, "resize", () => this.protectLayout());
        listen(window, "orientationchange", () => this.protectLayout());
        listen(document, "sv:feed-layout-change", () => this.protectLayout());
        this.resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.protectLayout()) : null;
        this.resizeObserver?.observe(container);
        this.healthTimer = setInterval(() => this.checkHealth(), 400);
    }

    createSlot() {
        const video = document.createElement("video");
        video.className = "feed-video";
        video.playsInline = true;
        video.setAttribute("webkit-playsinline", "");
        video.preload = "auto";
        video.muted = true;
        video.controls = false;
        video.disablePictureInPicture = true;
        return { video, generation: 0, item: null, hls: null, card: null, events: null, frameCallback: null };
    }

    get video() { return this.active?.video || null; }

    navigatePhoto(direction) {
        const slot = this.active;
        const item = slot?.item;
        const count = Number(item?.photo_count);
        const interval = Number(item?.photo_interval_seconds) || 3;
        if (item?.media_type !== "photo" || !Number.isInteger(count) || count < 1 || !slot.video) return false;
        const current = Math.min(count - 1, Math.max(0, Math.floor(slot.video.currentTime / interval)));
        const next = Math.max(0, Math.min(count - 1, current + Math.sign(direction)));
        if (next === current) return false;
        const end = Number.isFinite(slot.video.duration) ? slot.video.duration - 0.05 : Infinity;
        slot.video.currentTime = Math.min(next * interval + 0.05, end);
        this.callbacks.onPhotoIndex?.(next, count);
        return true;
    }

    restoreHistory() {
        try {
            const navigation = window.performance?.getEntriesByType?.("navigation")?.[0]?.type;
            const reloaded = navigation === "reload" || (!navigation && window.performance?.navigation?.type === 1);
            if (reloaded) window.sessionStorage.removeItem(this.historyKey);
            else {
                const saved = JSON.parse(window.sessionStorage.getItem(this.historyKey) || "[]");
                if (Array.isArray(saved)) for (const entry of saved.slice(-100)) {
                    if (entry?.item?.id && Number.isFinite(entry.position) && entry.position >= 0) this.watchHistory.set(entry.item.id, entry);
                }
            }
        } catch { /* Lecture possible même si le stockage de session est désactivé. */ }
    }

    persistHistory() {
        try { window.sessionStorage.setItem(this.historyKey, JSON.stringify([...this.watchHistory.values()])); }
        catch { /* L'historique reste disponible pendant la vie de ce lecteur. */ }
        this.historyLastSave = Date.now();
    }

    remember(slot = this.active, force = false) {
        if (!slot?.item || !slot.video || slot.resumePosition != null) return;
        const position = Number(slot.video.currentTime);
        if (!Number.isFinite(position) || position < 0) return;
        const duration = Number(slot.video.duration) || Number(slot.item.duree) || 0;
        const finished = duration > 0 && position >= duration - 0.15;
        this.watchHistory.delete(slot.item.id);
        const item = { id: slot.item.id, titre: slot.item.titre, duree: slot.item.duree };
        this.watchHistory.set(item.id, { item, position: finished ? 0 : position, duration, finished });
        if (this.watchHistory.size > 100) this.watchHistory.delete(this.watchHistory.keys().next().value);
        if (force || Date.now() - this.historyLastSave >= 1500) this.persistHistory();
    }

    historyItems() { return [...this.watchHistory.values()].reverse(); }
    clearHistory() { this.watchHistory.clear(); this.persistHistory(); }

    setItems(items, selectedId) {
        const changed = this.items.length !== items.length || items.some((item, i) => this.items[i]?.id !== item.id);
        this.items = items;
        if (!changed) return;
        this.remember(this.active, true);
        this.mutating = true;
        this.container.style.scrollSnapType = "none";
        const ids = new Set(items.map(item => item.id));
        for (const slot of this.slots) if (slot.item && !ids.has(slot.item.id)) this.release(slot);
        if (this.active && !this.active.item) this.active = null;
        for (const [id, card] of this.cards) if (!ids.has(id)) {
            if (this.hud && card.contains(this.hud)) this.viewport.append(this.hud);
            card.remove(); this.cards.delete(id);
        }
        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            let card = this.cards.get(item.id);
            if (!card) {
                card = document.createElement("article");
                card.className = "feed-card";
                card.dataset.videoId = item.id;
                card.setAttribute("aria-label", item.titre || "Vidéo");
                const fallback = document.createElement("div");
                fallback.className = "card-fallback";
                fallback.setAttribute("aria-hidden", "true");
                fallback.append(SV.icon("mark"));
                const cover = document.createElement("div");
                cover.className = "card-cover";
                cover.hidden = true;
                const image = document.createElement("img");
                image.className = "video-cover";
                image.alt = "";
                image.decoding = "async";
                image.draggable = false;
                cover.append(image);
                card.append(fallback, cover);
                this.cards.set(item.id, card);
            }
            card.dataset.index = String(index);
            this.callbacks.onCard?.(item, card);
            // Ne déplace pas les cartes quand seul un compteur social change.
            if (this.container.children[index] !== card) this.container.insertBefore(card, this.container.children[index] || null);
        }
        const selected = items.findIndex(item => item.id === selectedId);
        const index = selected >= 0 ? selected : 0;
        this.index = items.length ? index : -1;
        this.align(index);
        requestAnimationFrame(() => {
            if (this.destroyed) return;
            this.mutating = false;
            this.container.style.scrollSnapType = "";
        });
        if (!items.length) {
            this.active = null;
            this.setStatus("");
            this.callbacks.onState?.(this.state());
        }
    }

    align(index) {
        this.container.scrollTo({ top: Math.max(0, index) * this.container.clientHeight, behavior: "instant" });
    }

    // Conserver exactement le lecteur actif pendant les changements de taille.
    // Les scrolls provoqués par le navigateur pendant la rotation sont ignorés,
    // puis la carte active est replacée sans redémarrer ni changer de vidéo.
    protectLayout() {
        if (this.destroyed || this.index < 0 || !this.items.length) return;
        const generation = this.layoutGeneration = (this.layoutGeneration || 0) + 1;
        this.layoutLocked = true;
        // La WebView peut mettre la vidéo en pause après l'événement de taille.
        // Garder une courte fenêtre pour reprendre si elle jouait déjà.
        this.layoutRecoveryUntil = Date.now() + 8000;
        this.layoutRetryCount = 0;
        clearTimeout(this.layoutResumeTimer);
        this.scrolling = false;
        this.scrollTarget = null;
        clearTimeout(this.scrollTimer);
        clearTimeout(this.layoutTimer);
        this.align(this.index);
        if (!this.active?.video.ended) this.startActive();
        this.layoutTimer = setTimeout(() => {
            if (this.destroyed || this.index < 0 || generation !== this.layoutGeneration) return;
            this.align(this.index);
            // Le scroll programmatique peut être livré à la frame suivante.
            requestAnimationFrame(() => {
                if (this.destroyed || generation !== this.layoutGeneration) return;
                if (!this.active?.video.ended) this.startActive();
                this.scheduleLayoutResume(this.active);
                this.layoutTimer = setTimeout(() => {
                    if (generation === this.layoutGeneration) {
                        this.layoutLocked = false;
                        if (!this.active?.video.ended) this.startActive();
                        this.scheduleLayoutResume(this.active);
                    }
                }, 80);
            });
        }, 500);
    }

    // Une pause involontaire due à la rotation ne doit pas devenir une pause
    // utilisateur. Une pause demandée, une application suspendue ou une fin de
    // vidéo restent prioritaires ; une interdiction d'autoplay reste visible.
    scheduleLayoutResume(slot) {
        if (!slot || slot !== this.active || this.destroyed || Date.now() > (this.layoutRecoveryUntil || 0) ||
            !this.wantPlayback || this.suspended || this.scrolling || slot.fatal || slot.blocked ||
            slot.rebuffering || !slot.manifestReady || slot.video.ended || !slot.video.paused || slot.playPromise) return;
        if ((this.layoutRetryCount || 0) >= 15) {
            slot.blocked = true;
            this.callbacks.onState?.(this.state());
            return;
        }
        const generation = slot.generation;
        clearTimeout(this.layoutResumeTimer);
        this.layoutResumeTimer = setTimeout(() => {
            if (slot !== this.active || slot.generation !== generation || Date.now() > this.layoutRecoveryUntil ||
                !this.wantPlayback || this.suspended || !slot.video.paused || slot.video.ended) return;
            this.layoutRetryCount = (this.layoutRetryCount || 0) + 1;
            this.startActive();
        }, 200);
    }

    select(index, { behavior = "instant", scroll = true, position } = {}) {
        if (index < 0 || index >= this.items.length || this.destroyed) return;
        if (behavior === "smooth" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) behavior = "instant";
        const item = this.items[index];
        const same = this.active?.item?.id === item.id;
        this.index = index;
        this.scrolling = false;
        if (!same) {
            clearTimeout(this.clickTimer);
            const old = this.active;
            if (old) {
                this.remember(old, true);
                old.video.muted = true; old.video.pause(); old.video.removeAttribute("id");
                old.video.setAttribute("aria-hidden", "true");
                old.hls?.stopLoad(); old.loading = false;
                old.card?.classList.remove("is-active");
            }
            const resumeAt = Number.isFinite(position) ? Math.max(0, position) : (this.watchHistory.get(item.id)?.position || 0);
            let slot = this.slots.find(candidate => candidate.item?.id === item.id);
            if (!slot || slot.fatal) {
                slot ||= this.slots.find(candidate => candidate !== old) || this.slots[0];
                this.prepare(slot, item, resumeAt);
            }
            this.active = slot;
            // Un lecteur préchargé peut déjà exister à 0 : il doit lui aussi
            // reprendre la position mémorisée quand il devient actif.
            slot.resumePosition = resumeAt;
            this.restorePosition(slot);
            this.wantPlayback = true;
            slot.blocked = false;
            slot.waitingSince = Date.now();
            slot.lastTime = slot.video.currentTime;
            slot.lastProgressAt = Date.now();
            slot.preloadAfter = Date.now() + 250;
            slot.video.id = "lecteur";
            slot.video.setAttribute("aria-hidden", "false");
            slot.video.setAttribute("aria-label", item.titre || "Vidéo du fil");
            slot.card.classList.add("is-active");
            if (this.hud) slot.card.append(this.hud);
            // Une vidéo seulement préparée n'a pas encore été montrée à l'utilisateur.
            if (!slot.shown) slot.card.classList.remove("has-frame");
            this.callbacks.onSelect?.(item, index);
            this.reportLevels(slot);
            if (slot.fatal) this.callbacks.onError?.(slot.failureText || "Cette vidéo ne peut pas être lue.");
        }
        this.preloadCovers(index);
        if (scroll) {
            this.scrollTarget = index;
            this.container.scrollTo({ top: index * this.container.clientHeight, behavior });
            clearTimeout(this.scrollTimer);
            this.scrollTimer = setTimeout(() => this.settle(), behavior === "smooth" ? 450 : 30);
        }
        this.setStatus("");
        this.startActive();
        this.callbacks.onState?.(this.state());
    }

    preloadCovers(index) {
        for (const [id, card] of this.cards) {
            const position = Number(card.dataset.index);
            const cover = card.querySelector(".card-cover");
            const image = cover.querySelector("img");
            if (position < index - 1 || position > index + 2) {
                image.removeAttribute("src");
                cover.hidden = true;
                delete cover.dataset.source;
                continue;
            }
            const item = this.items[position];
            if (!item?.poster) continue;
            let source;
            try { source = new URL(item.poster, SV.origin).href; } catch { continue; }
            if (cover.dataset.source === source) continue;
            cover.dataset.source = source;
            image.src = source;
            image.onload = async () => {
                try { if (image.decode) await image.decode(); } catch {}
                if (cover.dataset.source === source && image.naturalWidth) cover.hidden = false;
            };
            image.onerror = () => { if (cover.dataset.source === source) cover.hidden = true; };
            if (image.complete && image.naturalWidth) cover.hidden = false;
        }
    }

    prepare(slot, item, position = 0) {
        this.release(slot);
        const generation = slot.generation;
        const card = this.cards.get(item.id);
        if (!card) return;
        Object.assign(slot, { item, card, ready: false, shown: false, blocked: false, fatal: false,
            networkError: false, prefetched: false, rebuffering: false,
            retries: 0, retryAt: 0, mediaRetries: 0, playPromise: null,
            waitingSince: 0, lastProgressAt: Date.now(), lastTime: 0, resumePosition: position });
        slot.events = new AbortController();
        const valid = () => slot.generation === generation && !this.destroyed;
        const listen = (name, callback) => slot.video.addEventListener(name, () => { if (valid()) callback(); }, { signal: slot.events.signal });
        slot.video.muted = true;
        slot.video.setAttribute("aria-hidden", "true");
        try {
            if (item.poster) slot.video.poster = new URL(item.poster, SV.origin).href;
            else slot.video.removeAttribute("poster");
        } catch { slot.video.removeAttribute("poster"); }
        card.prepend(slot.video);
        listen("loadeddata", () => {
            slot.ready = true;
            if (slot === this.active) this.startActive();
        });
        listen("loadedmetadata", () => { if (slot === this.active) this.restorePosition(slot); });
        listen("playing", () => {
            if (slot !== this.active || this.suspended || !this.wantPlayback || this.scrolling || slot.rebuffering) {
                slot.video.pause(); slot.video.muted = true; return;
            }
            slot.blocked = false;
            this.requestFrame(slot);
            this.callbacks.onState?.(this.state());
        });
        listen("pause", () => {
            if (slot !== this.active) return;
            this.callbacks.onState?.(this.state());
            this.scheduleLayoutResume(slot);
        });
        listen("waiting", () => this.waitForData(slot));
        listen("stalled", () => this.waitForData(slot));
        listen("timeupdate", () => {
            if (slot !== this.active) return;
            if (slot.resumePosition == null) this.remember(slot);
            if (Math.abs(slot.video.currentTime - slot.lastTime) > 0.03) {
                slot.lastTime = slot.video.currentTime;
                slot.lastProgressAt = Date.now();
                if (!slot.rebuffering) {
                    slot.waitingSince = 0;
                    if (slot.shown) this.setStatus("");
                }
            }
            this.callbacks.onProgress?.(slot.video.currentTime, slot.video.duration);
        });
        listen("ended", () => {
            if (slot === this.active) this.remember(slot, true);
            if (slot === this.active && !this.suspended && this.wantPlayback && !this.scrolling) this.callbacks.onEnd?.();
        });
        listen("error", () => {
            if (!slot.video.getAttribute("src") || slot.hls) return;
            if (slot.video.error?.code === 2) this.waitForData(slot);
            else this.fail(slot, "Cette vidéo ne peut pas être lue.");
        });
        let source;
        try { source = new URL(item.url_hls, SV.origin).href; }
        catch { this.fail(slot, "L’adresse de cette vidéo est invalide."); return; }
        if (window.Hls && Hls.isSupported()) {
            const estimate = this.bandwidth && Date.now() - this.bandwidth.at < 75000
                ? this.bandwidth.value : 500000;
            const instance = new Hls({
                enableWorker: true, autoStartLoad: true, startFragPrefetch: true,
                lowLatencyMode: false, startPosition: position,
                startLevel: -1, testBandwidth: false, abrEwmaDefaultEstimate: estimate,
                capLevelToPlayerSize: true, maxBufferLength: 4,
                maxMaxBufferLength: 6, maxBufferSize: 4 * 1024 * 1024,
                backBufferLength: 8,
                // Une marge supplémentaire aide à garder une lecture continue
                // quand le débit disponible est proche du débit d'une variante.
                abrBandWidthFactor: 0.75,
                abrBandWidthUpFactor: 0.65
            });
            slot.hls = instance;
            slot.loading = true;
            instance.on(Hls.Events.MEDIA_ATTACHED, () => { if (valid()) instance.loadSource(source); });
            instance.on(Hls.Events.MANIFEST_PARSED, () => {
                if (!valid()) return;
                slot.manifestReady = true;
                if (slot === this.active) { this.reportLevels(slot); this.startActive(); }
            });
            instance.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
                if (valid() && slot === this.active) this.callbacks.onLevel?.(instance, data.level);
            });
            instance.on(Hls.Events.FRAG_BUFFERED, (_, data) => {
                if (!valid() || data.frag?.type !== "main") return;
                slot.prefetched = true;
                slot.networkError = false;
                slot.retries = 0;
                slot.retryAt = 0;
                if (slot === this.active) {
                    const measured = instance.bandwidthEstimate;
                    if (Number.isFinite(measured) && measured > 0) this.bandwidth = { value: measured, at: Date.now() };
                    this.resumeAfterBuffer(slot);
                }
                // Le lecteur de réserve s'arrête après le premier fragment réellement préparé.
                if (slot !== this.active) { instance.stopLoad(); slot.loading = false; }
            });
            instance.on(Hls.Events.ERROR, (_, error) => {
                if (!valid() || !error.fatal) return;
                if (error.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    if (error.response?.code === 404) { this.fail(slot, "Cette vidéo est introuvable sur le serveur."); return; }
                    slot.networkError = true;
                    slot.loading = false;
                    this.waitForData(slot);
                    this.scheduleRetry(slot);
                } else if (error.type === Hls.ErrorTypes.MEDIA_ERROR && slot.mediaRetries++ < 1) {
                    instance.recoverMediaError();
                } else this.fail(slot, "Cette vidéo ne peut pas être lue. Passe à la suivante ou réessaie.");
            });
            instance.attachMedia(slot.video);
        } else if (slot.video.canPlayType("application/vnd.apple.mpegurl")) {
            slot.video.preload = "metadata";
            slot.video.src = source;
            listen("loadedmetadata", () => {
                slot.manifestReady = true;
                if (slot === this.active) this.restorePosition(slot);
                if (slot === this.active) this.startActive();
            });
            slot.video.load();
        } else this.fail(slot, "Ce navigateur ne prend pas en charge la lecture HLS.");
    }

    restorePosition(slot) {
        const position = slot?.resumePosition;
        if (!Number.isFinite(position)) { if (slot) slot.resumePosition = null; return; }
        if (position === 0 && (slot.video.readyState < 1 || slot.video.currentTime < 0.1)) { slot.resumePosition = null; return; }
        if (slot.video.readyState < 1) return;
        const duration = slot.video.duration;
        const target = Number.isFinite(duration) && duration > 0 ? Math.min(position, Math.max(0, duration - 0.1)) : position;
        try { slot.video.currentTime = target; slot.resumePosition = null; }
        catch { /* La prochaine métadonnée permettra une nouvelle tentative. */ }
    }

    reportLevels(slot) {
        this.callbacks.onLevels?.(slot.hls);
        if (slot.hls) this.callbacks.onLevel?.(slot.hls, slot.hls.currentLevel);
    }

    startActive() {
        const slot = this.active;
        if (!slot?.item || slot.fatal || this.suspended || !this.wantPlayback || this.scrolling || slot.blocked) return;
        for (const other of this.slots) if (other !== slot) { other.video.muted = true; other.video.pause(); }
        if (slot.hls) {
            // Une réserve VOD se remplit pendant la lecture, sans retarder le premier play.
            slot.hls.config.maxBufferLength = 30;
            slot.hls.config.maxMaxBufferLength = 45;
            slot.hls.config.maxBufferSize = 8 * 1024 * 1024;
            if (!slot.loading && Date.now() >= slot.retryAt) this.resumeLoad(slot);
        }
        if (slot.rebuffering) return;
        slot.video.preload = "auto";
        slot.video.muted = !this.sound;
        this.requestFrame(slot);
        if (!slot.manifestReady || slot.playPromise || !slot.video.paused) return;
        const generation = slot.generation;
        const attempt = slot.video.play();
        slot.playPromise = attempt;
        Promise.resolve(attempt).catch(error => {
            if (slot.generation !== generation || slot !== this.active || this.suspended || !this.wantPlayback || this.scrolling) return;
            if (error.name === "NotAllowedError" && Date.now() > (this.layoutRecoveryUntil || 0)) { slot.blocked = true; this.setStatus(""); }
            else if (error.name === "NotAllowedError") slot.blocked = false;
            else if (error.name !== "AbortError") this.fail(slot, "La lecture n’a pas pu démarrer. Réessaie.");
        }).finally(() => {
            if (slot.generation !== generation) return;
            slot.playPromise = null;
            if (slot === this.active) {
                this.callbacks.onState?.(this.state());
                this.scheduleLayoutResume(slot);
            }
        });
    }

    requestFrame(slot) {
        if (slot.frameCallback !== null || slot !== this.active) return;
        const generation = slot.generation;
        const reveal = () => {
            slot.frameCallback = null;
            if (generation !== slot.generation || slot !== this.active || this.destroyed || slot.video.readyState < 2) return;
            slot.shown = true;
            slot.card.classList.add("has-frame");
            slot.waitingSince = 0;
            slot.lastProgressAt = Date.now();
            this.setStatus("");
            this.callbacks.onState?.(this.state());
            this.scheduleNext();
        };
        if (slot.video.requestVideoFrameCallback) slot.frameCallback = slot.video.requestVideoFrameCallback(reveal);
        else if (slot.video.readyState >= 2 && !slot.video.paused) {
            slot.frameCallback = "fallback";
            requestAnimationFrame(() => requestAnimationFrame(reveal));
        }
    }

    scheduleNext() {
        clearTimeout(this.nextTimer);
        this.nextTimer = setTimeout(() => this.managePrefetch(), 250);
    }

    bufferedAhead(video) {
        if (!video) return 0;
        for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime + 0.15 && video.buffered.end(i) > video.currentTime) {
                return video.buffered.end(i) - video.currentTime;
            }
        }
        return 0;
    }

    managePrefetch() {
        const active = this.active;
        const spare = this.slots.find(slot => slot !== active);
        const ahead = this.bufferedAhead(active?.video);
        const video = active?.video;
        const complete = video && Number.isFinite(video.duration) && video.duration > 0 && ahead > 0 &&
            ahead >= video.duration - video.currentTime - 0.25;
        const unavailable = !active?.shown || active.fatal || active.blocked || active.rebuffering || this.suspended || this.scrolling ||
            navigator.onLine === false || navigator.connection?.saveData;
        // Suspendre le téléchargement de réserve avant qu'il puisse vider le tampon visible.
        if (unavailable || (!complete && ahead < 4) || active?.waitingSince) {
            if (spare?.hls && spare.loading && !spare.prefetched) {
                spare.hls.stopLoad(); spare.loading = false;
            }
            return;
        }
        if (!complete && (Date.now() < active.preloadAfter || ahead < 6)) return;
        const next = this.items[this.index + 1];
        if (!next || !spare) return;
        if (spare.item?.id === next.id) {
            if (!spare.prefetched && !spare.fatal && !spare.loading && spare.hls && Date.now() >= spare.retryAt) {
                this.resumeLoad(spare);
            }
            return;
        }
        this.prepare(spare, next);
    }

    waitForData(slot) {
        if (slot !== this.active || slot.fatal || !this.wantPlayback || this.suspended) return;
        slot.waitingSince ||= Date.now();
        // Garder l'image et l'horloge à leur place pendant une vraie interruption.
        // Le démarrage initial reste immédiat dès la première image disponible.
        if (slot.shown && !this.scrolling && slot.video.readyState < 3 && this.bufferedAhead(slot.video) < 0.3) {
            slot.rebuffering = true;
            slot.video.pause();
            this.callbacks.onState?.(this.state());
        }
    }

    resumeAfterBuffer(slot) {
        if (slot !== this.active || slot.fatal || !slot.rebuffering || this.suspended || !this.wantPlayback || this.scrolling) return;
        const video = slot.video;
        const ahead = this.bufferedAhead(video);
        const remaining = Number.isFinite(video.duration) ? video.duration - video.currentTime : Infinity;
        if (ahead < 1.5 && !(ahead > 0 && ahead >= remaining - 0.1)) return;
        slot.rebuffering = false;
        slot.waitingSince = 0;
        this.setStatus("");
        this.startActive();
    }

    setStatus(state) {
        if (this.status === state) return;
        this.status = state;
        const texts = {
            unstable: "Connexion instable",
            offline: "Hors connexion · Chargement…",
            loading: "Chargement… Connexion instable"
        };
        this.callbacks.onStatus?.(state, texts[state] || "");
    }

    checkHealth() {
        if (this.active) this.resumeAfterBuffer(this.active);
        this.managePrefetch();
        const slot = this.active;
        if (!slot || this.suspended || this.scrolling || slot.fatal) {
            this.setStatus(""); return;
        }
        if (navigator.onLine === false) { this.setStatus("offline"); return; }
        if (!this.wantPlayback || slot.blocked || slot.video.ended) { this.setStatus(""); return; }
        // Signaler la coupure même si le tampon permet encore une lecture momentanée.
        const progressing = slot.shown && !slot.video.paused && Date.now() - slot.lastProgressAt < 1800;
        if (progressing) { this.setStatus(""); return; }
        if (!slot.waitingSince) return;
        const waiting = Date.now() - slot.waitingSince;
        this.setStatus(waiting >= 10000 ? "loading" : waiting >= 2500 ? "unstable" : "");
    }

    scheduleRetry(slot) {
        clearTimeout(slot.retryTimer);
        if (navigator.onLine === false) return;
        const generation = slot.generation;
        // Une coupure réseau n'est pas une vidéo terminée : garder le lecteur
        // et sa position, et réessayer avec un délai borné jusqu'au retour des données.
        const delay = Math.min(8000, 1000 * 2 ** slot.retries);
        slot.retries = Math.min(slot.retries + 1, 3);
        slot.retryAt = Date.now() + delay;
        slot.retryTimer = setTimeout(() => {
            if (slot.generation !== generation || !slot.item || navigator.onLine === false) return;
            if (slot === this.active) this.startActive();
            else this.managePrefetch();
        }, delay);
    }

    resumeLoad(slot) {
        if (!slot.hls) return;
        // Un échec du manifeste exige de le recharger ; startLoad seul ne suffit pas.
        if (slot.networkError && !slot.manifestReady) slot.hls.loadSource(new URL(slot.item.url_hls, SV.origin).href);
        else slot.hls.startLoad(-1);
        slot.loading = true;
    }

    recover() {
        const slot = this.active;
        if (!slot || this.suspended || !this.wantPlayback || slot.fatal) return;
        slot.retries = 0;
        slot.retryAt = 0;
        slot.waitingSince = Date.now();
        if (slot.hls && !slot.loading) this.resumeLoad(slot);
        if (!slot.hls && slot.video.readyState === 0) slot.video.load();
        this.setStatus("");
        this.startActive();
        this.scheduleNext();
    }

    retry() {
        if (!this.items[this.index]) return;
        const slot = this.active;
        if (slot?.hls && !slot.fatal && (slot.networkError || slot.rebuffering || slot.waitingSince)) {
            slot.retries = 0;
            slot.retryAt = 0;
            this.wantPlayback = true;
            this.recover();
            return;
        }
        const position = slot?.video.currentTime || 0;
        const index = this.index;
        if (this.active) this.release(this.active);
        this.active = null;
        this.select(index, { scroll: false, position });
    }

    fail(slot, text) {
        slot.fatal = true;
        slot.failureText = text;
        slot.video.pause();
        if (slot === this.active) { this.setStatus(""); this.callbacks.onError?.(text); this.callbacks.onState?.(this.state()); }
    }

    state() {
        const slot = this.active;
        return {
            hasVideo: !!slot?.item,
            userPaused: !!slot && !this.wantPlayback,
            blocked: !!slot?.blocked,
            playing: !!slot && !slot.video.paused,
            shown: !!slot?.shown,
            suspended: this.suspended,
            fatal: !!slot?.fatal
        };
    }

    togglePlayback() {
        if (!this.active) return;
        if (this.wantPlayback && !this.active.blocked) {
            this.wantPlayback = false;
            this.active.rebuffering = false;
            this.active.video.pause();
            this.active.waitingSince = 0;
            this.setStatus("");
        } else {
            this.wantPlayback = true;
            this.active.rebuffering = false;
            this.active.blocked = false;
            this.active.waitingSince = Date.now();
            this.startActive();
        }
        this.callbacks.onState?.(this.state());
    }

    setSuspended(value) {
        this.suspended = value;
        if (value) {
            clearTimeout(this.nextTimer);
            for (const slot of this.slots) slot.video.pause();
            const spare = this.slots.find(slot => slot !== this.active);
            if (spare?.hls && spare.loading && !spare.prefetched) { spare.hls.stopLoad(); spare.loading = false; }
            this.setStatus("");
        } else {
            if (this.active) this.active.waitingSince = Date.now();
            this.startActive(); this.scheduleNext();
        }
        this.callbacks.onState?.(this.state());
    }

    setSound(value) {
        this.sound = value;
        for (const slot of this.slots) slot.video.muted = slot !== this.active || !value;
    }

    setQuality(index) {
        if (this.active?.hls) {
            // Changer les prochains téléchargements sans jeter la réserve déjà reçue.
            this.active.hls.loadLevel = index;
            this.callbacks.onLevel?.(this.active.hls, this.active.hls.currentLevel);
        }
    }

    seek(fraction) {
        const video = this.video;
        if (video && Number.isFinite(video.duration) && video.duration > 0) {
            this.active.rebuffering = false;
            video.currentTime = Math.max(0, Math.min(1, fraction)) * video.duration;
            this.startActive();
        }
    }

    restart() {
        if (!this.active) return;
        this.active.video.currentTime = 0;
        this.active.lastTime = 0;
        this.startActive();
    }

    handleScroll() {
        if (this.mutating || this.layoutLocked || !this.items.length) return;
        const height = this.container.clientHeight;
        if (!height) return;
        const position = this.container.scrollTop / height;
        if (Math.abs(position - this.index) > 0.08) {
            this.scrolling = true;
            this.suppressClickUntil = Date.now() + 400;
            clearTimeout(this.clickTimer);
            this.active?.video.pause();
            this.setStatus("");
        }
        const near = Math.max(0, Math.min(this.items.length - 1, Math.round(position)));
        this.preloadCovers(near);
        clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => this.settle(), 130);
    }

    settle() {
        if (this.destroyed || this.touching || this.mutating || this.layoutLocked || !this.items.length || !this.container.clientHeight) return;
        const position = this.container.scrollTop / this.container.clientHeight;
        if (this.scrollTarget !== null && Math.abs(position - this.scrollTarget) > 0.015) return;
        this.scrollTarget = null;
        const index = Math.max(0, Math.min(this.items.length - 1, Math.round(position)));
        this.scrolling = false;
        this.select(index, { scroll: false });
    }

    release(slot) {
        if (slot === this.active && slot.resumePosition == null) this.remember(slot, true);
        if (this.hud && slot.card?.contains(this.hud)) this.viewport.append(this.hud);
        slot.generation++;
        slot.events?.abort();
        clearTimeout(slot.retryTimer);
        if (slot.frameCallback !== null && slot.frameCallback !== "fallback") slot.video.cancelVideoFrameCallback?.(slot.frameCallback);
        slot.frameCallback = null;
        slot.video.muted = true;
        slot.video.pause();
        slot.hls?.destroy();
        slot.hls = null;
        slot.video.removeAttribute("src");
        slot.video.removeAttribute("id");
        slot.video.load();
        slot.video.remove();
        slot.card?.classList.remove("has-frame", "is-active");
        slot.item = null;
        slot.card = null;
        slot.manifestReady = false;
        slot.playPromise = null;
    }

    clear() {
        clearTimeout(this.nextTimer);
        clearTimeout(this.clickTimer);
        clearTimeout(this.scrollTimer);
        clearTimeout(this.layoutTimer);
        clearTimeout(this.layoutResumeTimer);
        this.layoutRecoveryUntil = 0;
        this.layoutGeneration = (this.layoutGeneration || 0) + 1;
        this.layoutLocked = false;
        if (this.hud) this.viewport.append(this.hud);
        for (const slot of this.slots) this.release(slot);
        this.active = null;
        this.items = [];
        this.index = -1;
        this.cards.clear();
        this.container.replaceChildren();
        this.setStatus("");
    }

    destroy() {
        this.destroyed = true;
        this.clear();
        clearInterval(this.healthTimer);
        this.events.abort();
        this.resizeObserver?.disconnect();
    }
};
