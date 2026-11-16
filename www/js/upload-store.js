"use strict";

// Registre local des publications. Une écriture n'est considérée réussie
// qu'après la fin de sa transaction IndexedDB, pas au succès de la requête seule.
window.SVUploadStore = (() => {
    const DB_NAME = "streamingvideo_uploads";
    const DB_VERSION = 1;
    let connection;

    function open() {
        if (connection) return connection;
        connection = new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error("Le stockage local IndexedDB n'est pas disponible sur cet appareil."));
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains("uploads")) db.createObjectStore("uploads", { keyPath: "id" });
                if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
            };
            request.onerror = () => reject(request.error || new Error("Impossible d'ouvrir les publications enregistrées."));
            request.onblocked = () => reject(new Error("Ferme les autres fenêtres de l'application puis réessaie."));
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); connection = null; };
                resolve(db);
            };
        }).catch(error => { connection = null; throw error; });
        return connection;
    }

    async function transaction(stores, mode, action) {
        const db = await open();
        return new Promise((resolve, reject) => {
            let result;
            let requestError;
            const tx = db.transaction(stores, mode);
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || requestError || new Error("L'enregistrement local a été interrompu."));
            // Certaines WebViews remontent le quota sur la requête plutôt que tx.error.
            tx.onerror = event => { requestError ||= event.target?.error; };
            try {
                action(tx, value => { result = value; });
            } catch (error) {
                try { tx.abort(); } catch {}
                reject(error);
            }
        });
    }

    function requestResult(request, setResult) {
        request.onsuccess = () => setResult(request.result);
    }

    return {
        open,
        put(record) {
            if (!record || typeof record.id !== "string" || !record.id) return Promise.reject(new Error("Identifiant local absent."));
            return transaction(["uploads"], "readwrite", (tx, done) => requestResult(tx.objectStore("uploads").put(record), done));
        },
        get(id) {
            return transaction(["uploads"], "readonly", (tx, done) => requestResult(tx.objectStore("uploads").get(id), done));
        },
        list() {
            return transaction(["uploads"], "readonly", (tx, done) => requestResult(tx.objectStore("uploads").getAll(), done));
        },
        update(id, changes) {
            return transaction(["uploads"], "readwrite", (tx, done) => {
                const store = tx.objectStore("uploads");
                const request = store.get(id);
                request.onsuccess = () => {
                    if (!request.result) { tx.abort(); return; }
                    const value = { ...request.result, ...changes, id };
                    store.put(value);
                    done(value);
                };
            });
        },
        // Supprime la fiche et son éventuelle vidéo Web dans une même transaction.
        remove(id) {
            return transaction(["uploads", "blobs"], "readwrite", tx => {
                tx.objectStore("uploads").delete(id);
                tx.objectStore("blobs").delete(id);
            });
        },
        async putBlob(id, blob) {
            try {
                return await transaction(["blobs"], "readwrite", (tx, done) => requestResult(tx.objectStore("blobs").put({ id, blob }), done));
            } catch (error) {
                if (error?.name === "QuotaExceededError") throw new Error("Espace de stockage insuffisant pour conserver la vidéo sur cet appareil.");
                throw error;
            }
        },
        async getBlob(id) {
            const entry = await transaction(["blobs"], "readonly", (tx, done) => requestResult(tx.objectStore("blobs").get(id), done));
            return entry?.blob || null;
        },
        removeBlob(id) {
            return transaction(["blobs"], "readwrite", tx => { tx.objectStore("blobs").delete(id); });
        }
    };
})();
