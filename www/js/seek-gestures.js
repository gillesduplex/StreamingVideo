"use strict";

// Un maintien immobile sur les côtés avance ou recule par pas de dix secondes.
// Les balayages et les commandes restent gérés par le fil et ses boutons.
window.SVSeekGestures = class {
    constructor({ scene, feed }) {
        this.scene = scene;
        this.feed = feed;
        this.hold = null;
        this.suppressClick = false;
        this.badgeTimer = null;
        this.suppressionTimer = null;
        this.badge = document.createElement("div");
        this.badge.className = "seek-gesture-indicator";
        this.badge.setAttribute("role", "status");
        this.badge.setAttribute("aria-live", "polite");
        this.badge.hidden = true;
        scene.append(this.badge);
        scene.addEventListener("touchstart", event => this.start(event), { passive: true });
        scene.addEventListener("touchmove", event => this.move(event), { passive: false });
        scene.addEventListener("touchend", event => this.end(event), { passive: false });
        scene.addEventListener("touchcancel", event => this.end(event), { passive: false });
        scene.addEventListener("contextmenu", event => { if (this.hold) event.preventDefault(); });
        scene.addEventListener("click", event => {
            if (!this.suppressClick || !event.target.closest(".feed-card") || event.target.closest("button,a,input,select,textarea")) return;
            this.suppressClick = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        document.addEventListener("visibilitychange", () => { if (document.hidden) this.end(); });
        document.addEventListener("pause", () => this.end());
        window.addEventListener("orientationchange", () => this.end());
    }

    start(event) {
        // Un nouveau toucher doit rester disponible pour la pause et les likes.
        this.suppressClick = false;
        clearTimeout(this.suppressionTimer);
        if (this.hold) this.end();
        if (event.touches.length !== 1 || !event.target.closest(".feed-card") ||
            event.target.closest("button,a,input,select,textarea")) return;
        const video = this.feed.video;
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0 || !Number.isFinite(video.currentTime)) return;
        const touch = event.touches[0];
        const rect = this.scene.getBoundingClientRect();
        if (!rect.width) return;
        const x = (touch.clientX - rect.left) / rect.width;
        const direction = x < 0.38 ? -1 : x > 0.62 ? 1 : 0;
        const mode = direction ? "seek" : "speed";
        const hold = this.hold = { id: touch.identifier, x: touch.clientX, y: touch.clientY, direction, mode, video, total: 0, active: false };
        hold.timer = setTimeout(() => {
            if (this.hold !== hold || this.feed.video !== video) return;
            hold.active = true;
            clearTimeout(this.feed.clickTimer);
            if (mode === "speed") {
                hold.originalRate = Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1;
                video.playbackRate = 2;
                this.showSpeed();
                hold.interval = setInterval(() => {
                    if (this.hold !== hold || this.feed.video !== video) this.end();
                }, 100);
            } else {
                this.jump(hold);
                hold.interval = setInterval(() => this.jump(hold), 650);
            }
        }, 500);
    }

    move(event) {
        const hold = this.hold;
        if (!hold) return;
        const touch = [...event.touches].find(item => item.identifier === hold.id);
        if (!touch || event.touches.length !== 1) { this.end(); return; }
        if (hold.active) {
            if (event.cancelable) event.preventDefault();
        } else if (Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > 10) {
            this.end();
        }
    }

    jump(hold) {
        const video = this.feed.video;
        if (this.hold !== hold || video !== hold.video || !Number.isFinite(video.duration) || video.duration <= 0) { this.end(); return; }
        // Éviter de déclencher « vidéo terminée » seulement à cause du saut.
        const end = Math.max(0, video.duration - 0.25);
        const current = Math.max(0, Math.min(end, video.currentTime));
        const target = Math.max(0, Math.min(end, current + hold.direction * 10));
        hold.total += Math.abs(target - current);
        if (target !== current) this.feed.seek(target / video.duration);
        this.badge.classList.toggle("backward", hold.direction < 0);
        this.badge.classList.toggle("forward", hold.direction > 0);
        this.badge.classList.toggle("speed", false);
        this.badge.textContent = (hold.direction < 0 ? "−" : "+") + Math.round(hold.total) + " s";
        this.badge.hidden = false;
        clearTimeout(this.badgeTimer);
    }

    showSpeed() {
        this.badge.classList.toggle("backward", false);
        this.badge.classList.toggle("forward", false);
        this.badge.classList.toggle("speed", true);
        this.badge.textContent = "2×";
        this.badge.hidden = false;
        clearTimeout(this.badgeTimer);
    }

    end(event) {
        const hold = this.hold;
        if (!hold) return;
        if (event?.changedTouches && ![...event.changedTouches].some(touch => touch.identifier === hold.id)) return;
        this.hold = null;
        clearTimeout(hold.timer);
        clearInterval(hold.interval);
        if (!hold.active) return;
        if (hold.mode === "speed") hold.video.playbackRate = hold.originalRate;
        if (event?.cancelable) event.preventDefault();
        // Le clic synthétique issu du maintien ne doit pas mettre en pause.
        this.suppressClick = true;
        this.suppressionTimer = setTimeout(() => { this.suppressClick = false; }, 750);
        this.feed.suppressClickUntil = Date.now() + 600;
        this.badgeTimer = setTimeout(() => { this.badge.hidden = true; }, 700);
    }
};
