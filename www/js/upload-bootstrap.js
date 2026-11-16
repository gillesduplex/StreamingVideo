"use strict";

// Dans la vue intégrée, un seul pont Cordova vit dans la page parente. Les
// appels natifs et leurs callbacks restent donc rattachés à la bonne WebView.
(() => {
    let parentWindow;
    try {
        if (window.parent !== window && window.parent.SVStudio) parentWindow = window.parent;
    } catch { /* Page ouverte dans un cadre d'une autre origine. */ }
    if (!parentWindow) {
        // Le studio continue à fonctionner lorsqu'il est ouvert directement.
        document.write('<script src="cordova.js"><\/script>');
        return;
    }
    window.SVParentStudio = parentWindow.SVStudio;
    if (!parentWindow.cordova) return; // Navigateur sans Cordova.
    window.cordova = parentWindow.cordova;
    Object.defineProperty(window, "CameraPreview", { configurable: true, get: () => parentWindow.CameraPreview });
    for (const name of ["resolveLocalFileSystemURL", "requestFileSystem", "LocalFileSystem"]) {
        Object.defineProperty(window, name, { configurable: true, get: () => parentWindow[name] });
    }
    for (const name of ["pause", "resume"]) {
        parentWindow.document.addEventListener(name, () => document.dispatchEvent(new Event(name)));
    }
    document.addEventListener("DOMContentLoaded", () => {
        const ready = () => document.dispatchEvent(new Event("deviceready"));
        try {
            // Les canaux Cordova mémorisent deviceready même s'il a déjà eu lieu.
            const channel = parentWindow.cordova.require("cordova/channel").onDeviceReady;
            channel.subscribe(ready);
        } catch {
            parentWindow.document.addEventListener("deviceready", ready, { once: true });
        }
    }, { once: true });
})();
