"use strict";

// Les limites concernent toute la page : une instance de transfert par vidéo.
window.SVUploadManager = class {
    constructor(options = {}) {
        this.transfers = [];
        this.listeners = options.onUpdate ? [options.onUpdate] : [];
        this.uploadActive = 0;
        this.uploadWaiting = [];
        this.copyActive = 0;
        this.copyWaiting = [];
        this.restored = false;
        this.restoring = null;
        this.confirmUnverified = options.confirmUnverified;
    }

    addListener(listener) { this.listeners.push(listener); }

    acquire(kind, signal) {
        const active = kind + "Active", waiting = kind + "Waiting";
        return new Promise((resolve, reject) => {
            const enter = () => {
                signal?.removeEventListener("abort", abort);
                if (signal?.aborted) { reject(Object.assign(new Error("Opération interrompue."), { name: "AbortError" })); return; }
                this[active]++;
                let released = false;
                resolve(() => {
                    if (released) return;
                    released = true;
                    this[active]--;
                    this[waiting].shift()?.();
                });
            };
            const abort = () => {
                const index = this[waiting].indexOf(enter);
                if (index >= 0) this[waiting].splice(index, 1);
                reject(Object.assign(new Error("Opération interrompue."), { name: "AbortError", aborted: true }));
            };
            if (signal?.aborted) { abort(); return; }
            signal?.addEventListener("abort", abort, { once: true });
            if (this[active] < 2) enter(); else this[waiting].push(enter);
        });
    }

    create() {
        const transfer = new SVResumableUpload({
            acquire: signal => this.acquire("upload", signal),
            acquireCopy: signal => this.acquire("copy", signal),
            onUpdate: (record, mesure) => {
                const visible = record?.hidden ? null : record;
                for (const listener of this.listeners) listener(visible, mesure, transfer);
                window.dispatchEvent(new CustomEvent("sv-upload-update", { detail: { record: visible, mesure } }));
            }
        });
        this.transfers.push(transfer);
        return transfer;
    }

    start(file, metadata) {
        // Une publication arrêtée conserve son identité et ses octets. La
        // sélection du même fichier lui rend l'accès à l'original si besoin.
        const matching = this.transfers.filter(transfer => {
            const record = transfer.record;
            return record && ["paused", "error"].includes(record.state) && !record.videoId &&
                record.name === file.name && record.size === file.size;
        });
        if (matching.length === 1) return this.continueWithFile(matching[0], file);
        if (matching.length > 1) return Promise.reject(new Error("Plusieurs publications arrêtées ont ce nom. Reprends la publication depuis son suivi."));
        const transfer = this.create();
        return transfer.start(file, metadata);
    }

    async continueWithFile(transfer, file) {
        try { return await transfer.continueWithFile(file); }
        catch (error) {
            if (error.code !== "SOURCE_NON_VERIFIEE" || !this.confirmUnverified || !await this.confirmUnverified()) throw error;
            return transfer.continueWithFile(file, { allowUnverified: true });
        }
    }

    async restore() {
        if (this.restoring) return this.restoring;
        if (this.restored) return this.transfers.filter(transfer => transfer.record && !transfer.record.hidden).length;
        this.restoring = (async () => {
            const stored = await SVUploadStore.list();
            // Une copie privée peut rester si le stockage était momentanément
            // indisponible. Réessayer sans bloquer la reprise des autres vidéos.
            for (const record of stored.filter(item => item.state === "done" && item.cleanupPending)) {
                Promise.resolve().then(() => SVUploadFile.remove(record.source))
                    .then(() => SVUploadStore.remove(record.id))
                    .catch(error => console.warn("Nettoyage de la copie locale reporté", error));
            }
            const records = stored
                .filter(record => !["done", "cancelled"].includes(record.state))
                .sort((a, b) => a.createdAt - b.createdAt);
            for (const record of records) await this.create().restore(record);
            this.restored = true;
            return records.filter(record => !record.hidden).length;
        })();
        try { return await this.restoring; }
        finally { this.restoring = null; }
    }
};
