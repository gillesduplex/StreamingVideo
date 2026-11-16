"use strict";

// Avis conservés localement jusqu'à leur consultation. Ce service ne prétend
// pas fournir des notifications système lorsque l'application est fermée.
window.SVPublicationNotifications = (() => {
    const KEY = "sv.publication.notifications.v1";
    let memory = { pending: [], seen: [] };
    let storageUsable = true;
    let box;

    function read() {
        if (!storageUsable) return memory;
        let raw;
        try {
            raw = localStorage.getItem(KEY);
        } catch { storageUsable = false; return memory; }
        try {
            const saved = JSON.parse(raw || "null");
            if (saved && Array.isArray(saved.pending) && Array.isArray(saved.seen)) return saved;
        } catch { /* Une donnée locale abîmée sera remplacée au prochain avis. */ }
        return memory;
    }

    function write(data) {
        memory = data;
        if (!storageUsable) return;
        try { localStorage.setItem(KEY, JSON.stringify(data)); }
        catch { storageUsable = false; }
    }

    function render() {
        if (!document.body) return;
        const notification = read().pending[0];
        if (!notification) { box?.remove(); box = null; return; }
        if (!box) {
            box = document.createElement("section");
            box.className = "publication-notice";
            box.setAttribute("role", "status");
            box.setAttribute("aria-live", "polite");
            document.body.append(box);
        }
        box.replaceChildren();
        const content = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = "Ta vidéo est publiée !";
        const description = document.createElement("p");
        description.textContent = (notification.title || notification.name || "Ta vidéo") + " est prête à être regardée.";
        const actions = document.createElement("div");
        actions.className = "publication-notice-actions";
        const view = document.createElement("a");
        const url = new URL("index.html", location.href);
        url.searchParams.set("video", notification.videoId);
        view.href = url.href;
        view.textContent = "Voir la vidéo";
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "Fermer";
        const dismiss = () => {
            const data = read();
            data.pending = data.pending.filter(item => item.id !== notification.id);
            write(data);
            render();
        };
        close.addEventListener("click", dismiss);
        view.addEventListener("click", event => {
            // Dans l'application, garder la page racine vivante : recharger
            // index.html interromprait les autres copies et envois en cours.
            try {
                const navigation = window.SVStudio || (window.parent !== window ? window.parent?.SVStudio : null);
                if (typeof navigation?.showVideo === "function") {
                    navigation.showVideo(notification.videoId);
                    event?.preventDefault();
                }
            } catch (error) { console.warn("Ouverture directe de la vidéo indisponible :", error); }
            dismiss();
        });
        actions.append(view, close);
        content.append(title, description, actions);
        box.append(content);
    }

    function complete(record) {
        // Aucune erreur d'affichage ou de stockage ne doit bloquer la publication.
        try {
            if (!record?.id || !record.videoId) return;
            const data = read();
            if (data.seen.includes(record.id)) return;
            data.pending.push({ id: record.id, videoId: record.videoId, title: record.title, name: record.name });
            data.seen.push(record.id);
            data.seen = data.seen.slice(-1000);
            write(data);
            render();
        } catch (error) { console.warn("Impossible d'afficher l'avis de publication.", error); }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
    else render();
    window.addEventListener("storage", event => { if (event.key === KEY) render(); });
    return { complete, render };
})();
