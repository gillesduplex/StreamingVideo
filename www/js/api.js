"use strict";

// Partagé par le lecteur et le studio, sans dépendance externe.
window.SV = (() => {
    const base = String(window.APP_CONFIG?.API_BASE_URL || "").replace(/\/+$/, "");
    const origin = base ? new URL(base).origin : location.origin;
    function uuid() {
        if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(v => v.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    let token;
    try {
        token = localStorage.getItem("sv.visitor");
        if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token || "")) {
            token = uuid();
            localStorage.setItem("sv.visitor", token);
        }
    } catch { token = token || uuid(); }

    async function api(path, options = {}) {
        if (!base) throw new Error("Le serveur vidéo n'est pas configuré.");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(base + path, {
                cache: "no-store", ...options, signal: options.signal || controller.signal,
                headers: { "X-Visitor-Token": token, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || "Cette action n'a pas pu être enregistrée.");
            return result;
        } catch (error) {
            if (error.name === "AbortError") throw new Error("Le serveur met trop de temps à répondre. Réessaie.");
            if (error instanceof TypeError) throw new Error("Connexion au serveur impossible. Vérifie ta connexion.");
            throw error;
        } finally { clearTimeout(timer); }
    }
    const number = value => new Intl.NumberFormat("fr-FR", { notation: Number(value) >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(Number(value) || 0);
    const duration = value => {
        const seconds = Math.max(0, Math.floor(Number(value) || 0));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    };
    const initials = name => String(name || "V").trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join("").toUpperCase();
    function icon(name) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("icon");
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", "#i-" + name);
        svg.append(use);
        return svg;
    }
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const emit = (name, detail) => document.dispatchEvent(new CustomEvent("stream:" + name, { detail }));
    return { api, base, origin, token, uuid, number, duration, initials, icon, element, emit };
})();
