"use strict";

// Android : chaque document est rouvert via cordova-plugin-file après sélection SAF.
// Le droit de lecture content:// est conservé par Android entre les lancements.
window.SVPersistentPicker = (() => {
    function environment() {
        try {
            if (window.cordova?.plugins?.SVVideoPicker && window.resolveLocalFileSystemURL) return window;
            if (window.parent !== window && window.parent.cordova?.plugins?.SVVideoPicker && window.parent.resolveLocalFileSystemURL) return window.parent;
        } catch { /* Les fenêtres d'une autre origine restent inaccessibles. */ }
        return null;
    }

    function available() { return !!environment(); }

    async function select() {
        const host = environment();
        if (!host) throw new Error("Le sélecteur Android n'est pas disponible.");
        const fail = reject => error => reject(error instanceof Error ? error : new Error(String(error || "Accès à la vidéo impossible.")));
        const selected = await new Promise((resolve, reject) => host.cordova.plugins.SVVideoPicker.select(resolve, fail(reject)));
        if (!Array.isArray(selected)) throw new Error("Le téléphone n'a pas renvoyé de liste de vidéos valide.");
        return Promise.all(selected.map(item => new Promise((resolve, reject) => {
            if (!item || typeof item.uri !== "string" || !item.uri.startsWith("content://")) {
                reject(new Error("L'accès à une vidéo sélectionnée est invalide.")); return;
            }
            host.resolveLocalFileSystemURL(item.uri, entry => {
                entry.file(file => {
                    if (Number(file.size) !== Number(item.size) || typeof file.slice !== "function" || !file.localURL) {
                        reject(new Error("Impossible de relire une vidéo sélectionnée.")); return;
                    }
                    // ContentFilesystem ne fournit pas toujours le nom affichable.
                    file.name = item.name;
                    if (item.type && (!file.type || file.type === "application/octet-stream")) file.type = item.type;
                    file.previewURL = entry.toURL();
                    resolve(file);
                }, fail(reject));
            }, fail(reject));
        })));
    }

    return { available, select };
})();
