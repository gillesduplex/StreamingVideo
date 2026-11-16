"use strict";

// Une instance par publication ; le serveur fait toujours foi pour les octets reçus.
window.SVResumableUpload = class {
    constructor(callbacks = {}) {
        this.callbacks = callbacks;
        this.record = null;
        this.running = false;
        this.request = null;
        this.requestController = null;
        this.resumePending = false;
        this.timer = null;
        this.speed = 0;
        this.networkSlow = false;
        this.chunkSize = 5 * 1024 * 1024;
        this.copying = false;
        this.copyError = null;
        this.copyTask = null;
        this.copyController = null;
        this.slotController = null;
        this.saveQueue = Promise.resolve();
        this.pauseRequested = false;
        this.originalFile = null;
        this.identityGeneration = 0;
        this.sourceRecovery = null;
        window.addEventListener("online", () => {
            if (this.record?.state === "interrupted" && !this.pauseRequested) this.resume();
        });
        window.addEventListener("offline", () => { if (!this.pauseRequested) this.request?.abort(); });
        document.addEventListener("resume", () => {
            if (this.record && !this.pauseRequested && ["interrupted", "ready"].includes(this.record.state)) this.resume();
        });
    }

    display(extra = {}) { this.callbacks.onUpdate?.(this.record, { speed: this.speed, networkSlow: this.networkSlow, ...extra }); }
    async save(state) {
        if (state) this.record.state = state;
        this.record.updatedAt = Date.now();
        const snapshot = { ...this.record };
        this.saveQueue = this.saveQueue.catch(() => {}).then(() => SVUploadStore.put(snapshot));
        await this.saveQueue;
        this.display();
    }

    async start(file, metadata, retained = null) {
        if (this.record && this.record !== retained && !["done", "cancelled"].includes(this.record.state)) throw new Error("Une publication est déjà en cours.");
        const id = retained?.id || SV.uuid();
        this.originalFile = file;
        this.record = retained || { id, name: file.name, size: file.size, type: file.type || "video/mp4", title: metadata.title,
            description: metadata.description, offset: 0, sessionId: null, videoId: null, state: "preparing", createdAt: Date.now(),
            ...(typeof file.localURL === "string" && file.localURL ? { originalUri: file.localURL } : {}),
            ...(Number.isFinite(file.lastModified) && file.lastModified > 0 ? { originalLastModified: file.lastModified } : {}) };
        this.record.state = "preparing";
        this.pauseRequested = false;
        try { await this.save(); }
        catch (error) { this.record = null; this.display(); throw error; }
        let releaseCopy;
        try {
            if (this.callbacks.acquireCopy) releaseCopy = await this.callbacks.acquireCopy();
            this.copying = true;
            this.copyError = null;
            this.copyController = new AbortController();
            const copy = await SVUploadFile.begin(file, id, (copied, total) => {
                if (!this.record || this.record.id !== id) return;
                this.record.copiedBytes = copied;
                this.display({ copied, total });
            }, this.copyController.signal);
            this.record.source = copy.source;
            this.record.copyComplete = false;
            this.record.copiedBytes ||= 0;
            this.copyTask = copy.complete;
            // La copie peut échouer pendant que la fiche IndexedDB est encore écrite.
            this.copyTask.catch(() => {});
            await this.save("ready");
            this.resume();
            await this.copyTask;
            if (!this.record || this.record.id !== id) return;
            this.copying = false;
            this.record.copiedBytes = this.record.size;
            this.record.copyComplete = true;
            await this.save();
        } catch (error) {
            this.copying = false;
            this.copyError = error;
            if (!this.record || this.record.id !== id || error.name === "AbortError") return;
            this.pauseRequested = true;
            this.copyController?.abort();
            this.request?.abort();
            this.requestController?.abort();
            this.record.error = error.message || "Impossible de conserver cette vidéo sur l’appareil.";
            await this.save("error");
            throw error;
        } finally {
            releaseCopy?.();
            this.copying = false;
            this.copyTask = null;
            this.copyController = null;
        }
    }

    async restore(record) {
        const records = record ? [record] : await SVUploadStore.list();
        this.record = records.filter(r => !["done", "cancelled"].includes(r.state)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
        if (!this.record) return false;
        // Avant que le descripteur de copie ait été enregistré, l'URI du
        // document Android figure déjà dans la fiche de publication.
        if (this.record.source?.kind === "cordova" && !this.record.source.originalUri && this.record.originalUri) {
            this.record.source.originalUri = this.record.originalUri;
        }
        if (!this.record.source && !this.record.videoId && SVUploadFile.findPartial) {
            this.record.source = await SVUploadFile.findPartial(this.record).catch(() => null);
            if (this.record.source) this.record.copyComplete = false;
        }
        if (this.record.source && this.record.copyComplete === false) {
            try {
                await SVUploadFile.validate(this.record.source);
                this.record.copyComplete = true;
                this.record.copiedBytes = this.record.size;
                await this.save();
            } catch {
                if (this.record.source.kind !== "cordova" || !this.record.source.originalUri || !SVUploadFile.resumeCopy) this.record.needsFile = true;
            }
        }
        if (!this.record.source && this.record.state !== "processing") {
            if (this.record.originalUri && SVUploadFile.openOriginal) {
                this.record.needsFile = false;
                this.pauseRequested = this.record.state === "paused";
                this.display();
                if (!this.pauseRequested) this.resume();
                return true;
            }
            this.record.error = "La copie d'origine n'est plus accessible. Choisis à nouveau la même vidéo pour vérifier la reprise.";
            this.record.needsFile = true;
            await this.save(this.record.state === "paused" ? "paused" : "error");
            return true;
        }
        this.pauseRequested = this.record.state === "paused" || this.record.state === "error";
        this.display();
        if (!this.pauseRequested) this.resume();
        return true;
    }

    // Repartir de la copie privée existante après avoir vérifié ses octets.
    startCopyRecovery(file = this.originalFile) {
        if (this.copyTask || !this.record?.source) return;
        const record = this.record;
        const controller = this.copyController = new AbortController();
        this.copying = true;
        this.copyError = null;
        // La progression déjà visible reste affichée pendant la comparaison,
        // mais aucun octet n'est envoyé avant sa validation.
        record.copyVerifying = true;
        this.display();
        const task = (async () => {
            let release;
            try {
                if (this.callbacks.acquireCopy) release = await this.callbacks.acquireCopy(controller.signal);
                const copy = await SVUploadFile.resumeCopy(record.source, (copied, total) => {
                    if (this.record !== record) return;
                    record.copiedBytes = copied;
                    record.copyVerifying = false;
                    this.display({ copied, total });
                }, controller.signal, file);
                await copy.complete;
                if (this.record !== record) return;
                record.copiedBytes = record.size;
                record.copyComplete = true;
                record.needsFile = false;
                record.sourceUnavailable = false;
                record.copyVerifying = false;
                await this.save();
            } finally { release?.(); }
        })();
        this.copyTask = task;
        task.catch(async error => {
            this.copyError = error;
            record.copyVerifying = false;
            if (this.record !== record || error.name === "AbortError") return;
            this.pauseRequested = true;
            this.request?.abort();
            this.requestController?.abort();
            record.needsFile = true;
            // Une référence File ou URI peut devenir invalide pendant la copie.
            // Ne pas réessayer indéfiniment cette même référence inaccessible.
            this.originalFile = null;
            record.sourceUnavailable = true;
            record.error = error.message || "Impossible de reprendre la copie. Choisis à nouveau la vidéo.";
            await this.save("error");
        }).finally(() => {
            if (this.copyTask === task) { this.copyTask = null; this.copyController = null; this.copying = false; }
        });
    }

    async continueWithFile(file, { allowUnverified = false } = {}) {
        if (!this.record || !file) return;
        const record = this.record;
        const source = record.source;
        const generation = ++this.identityGeneration;
        record.hidden = false;
        record.copyVerifying = true;
        await this.save("paused");
        try {
            if (String(file.name) !== String(record.name) || Number(file.size) !== Number(record.size) ||
                (source?.originalLastModified && file.lastModified && source.originalLastModified !== file.lastModified)) {
                throw new Error("Choisis exactement la même vidéo pour reprendre cette publication.");
            }
            if (!source) {
                // Aucun fichier local : le serveur seul peut confirmer qu'aucun
                // octet d'une autre source n'est déjà enregistré.
                let session;
                try { session = await this.json("/uploads/" + encodeURIComponent(record.sessionId || record.id)); }
                catch (error) { if (error.status !== 404 || record.sessionId) throw error; }
                if ((Number(record.offset) || 0) !== 0 || (session && (session.status !== "uploading" || session.offset !== 0))) {
                    const error = new Error("La copie locale est absente et des octets existent déjà sur le serveur. Impossible de vérifier la reprise sans risquer de mélanger deux vidéos.");
                    error.status = 422;
                    throw error;
                }
                if (generation !== this.identityGeneration || this.record !== record) return;
                record.copyVerifying = false;
                record.needsFile = false;
                record.error = null;
                record.copyComplete = false;
                return this.start(file, { title: record.title, description: record.description }, record);
            }
            if (this.copyTask) await this.copyTask.catch(() => {});
            // Un même nom et le préfixe copié ne prouvent pas l'identité du suffixe.
            // Réutiliser seulement après comparaison complète à une source fiable.
            if (file !== this.originalFile) {
                let reference = this.originalFile;
                if (!reference && record.copyComplete) {
                    try { reference = await SVUploadFile.validate(source); } catch {}
                }
                if (!reference && source.originalUri && SVUploadFile.openOriginal) {
                    try { reference = await SVUploadFile.openOriginal(source); } catch {}
                }
                if (!reference) {
                    if (!allowUnverified) {
                        const error = new Error("Impossible de vérifier toute la vidéo d'origine. La copie partielle est conservée.");
                        error.code = "SOURCE_NON_VERIFIEE";
                        throw error;
                    }
                } else if (!SVUploadFile.compareFiles || !await SVUploadFile.compareFiles(reference, file)) {
                    throw new Error("La vidéo choisie ne correspond pas à la vidéo d'origine. La copie est conservée.");
                }
            }
            if (generation !== this.identityGeneration || this.record !== record) return;
        } catch (error) {
            if (generation !== this.identityGeneration || this.record !== record) return;
            record.copyVerifying = false;
            record.needsFile = true;
            record.error = error.message || "Impossible de vérifier la vidéo d'origine.";
            await this.save("error");
            throw error;
        }
        this.originalFile = file;
        this.record.sourceUnavailable = false;
        this.record.copyVerifying = false;
        if (source.kind === "blob" && this.record.copyComplete) {
            this.record.needsFile = false;
            this.record.error = null;
            await this.save("paused");
            return this.resume();
        }
        if (source.kind !== "cordova") throw new Error("La copie incomplète n'est pas disponible sur cet appareil.");
        this.record.copyComplete = false; // Même une copie complète est comparée à la sélection.
        this.record.needsFile = false;
        this.record.error = null;
        this.pauseRequested = false;
        await this.save("paused");
        this.startCopyRecovery(file);
        this.resume();
    }

    async json(path, options = {}) {
        const controller = new AbortController();
        this.requestController = controller;
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch(SV.base + path, { ...options, signal: controller.signal, cache: "no-store", headers: {
                "X-Visitor-Token": SV.token, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers
            } });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) { const error = new Error(data.message || "Le serveur ne répond pas."); error.status = response.status; throw error; }
            return data;
        } finally { clearTimeout(timeout); if (this.requestController === controller) this.requestController = null; }
    }

    sendChunk(start, bytes) {
        return new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();
            let stalled = false, watchdog, notice;
            const armWatchdog = () => {
                clearTimeout(watchdog); clearTimeout(notice); this.networkSlow = false;
                notice = setTimeout(() => { this.networkSlow = true; this.display(); }, 30000);
                watchdog = setTimeout(() => { stalled = true; request.abort(); }, 600000);
            };
            this.request = request;
            request.open("PATCH", SV.base + "/uploads/" + encodeURIComponent(this.record.sessionId));
            request.setRequestHeader("Content-Type", "application/octet-stream");
            request.setRequestHeader("X-Visitor-Token", SV.token);
            request.setRequestHeader("Upload-Offset", String(start));
            request.timeout = 900000;
            request.upload.onprogress = event => { armWatchdog(); if (event.lengthComputable) this.display({ sent: Math.min(this.record.size, start + event.loaded) }); };
            request.onerror = () => reject(new Error("Connexion interrompue."));
            request.ontimeout = () => reject(new Error("Le serveur met trop de temps à répondre."));
            request.onabort = () => reject(Object.assign(new Error(stalled ? "La connexion ne transmet plus de données." : "Envoi interrompu."), { aborted: this.pauseRequested }));
            request.onload = () => {
                let data = {}; try { data = JSON.parse(request.responseText || "{}"); } catch {}
                if (request.status >= 200 && request.status < 300) resolve(data);
                else { const error = new Error(data.message || "Envoi impossible."); error.status = request.status; reject(error); }
            };
            request.onloadend = () => { clearTimeout(watchdog); clearTimeout(notice); this.networkSlow = false; if (this.request === request) this.request = null; };
            armWatchdog();
            request.send(bytes);
        });
    }

    async resume() {
        if (!this.record) return;
        if (!this.record.source && !this.record.videoId) {
            if (this.record.originalUri && SVUploadFile.openOriginal) {
                if (this.sourceRecovery) return this.sourceRecovery;
                const record = this.record;
                this.pauseRequested = false;
                const recover = (async () => {
                    let original;
                    try {
                        original = await SVUploadFile.openOriginal(record);
                        original.name = record.name;
                    } catch {
                        if (this.record !== record) return;
                        record.needsFile = true;
                        record.error = "La vidéo d'origine n'est plus accessible. Choisis-la à nouveau pour vérifier la reprise.";
                        await this.save("error");
                        return;
                    }
                    try {
                        if (this.record !== record || this.pauseRequested) return;
                        await this.continueWithFile(original);
                    } catch (error) {
                        if (this.record !== record || this.pauseRequested) return;
                        if (!error.status || error.status === 408 || error.status === 429 || error.status >= 500) {
                            record.needsFile = false;
                            record.error = "Connexion interrompue. Nouvelle tentative de reprise…";
                            await this.save("interrupted");
                            this.timer = setTimeout(() => this.resume(), 5000);
                        }
                    }
                })();
                this.sourceRecovery = recover;
                try { return await recover; }
                finally { if (this.sourceRecovery === recover) this.sourceRecovery = null; }
            }
            this.record.needsFile = true;
            this.record.error = "La source n'est plus accessible. Choisis à nouveau la vidéo pour vérifier la copie.";
            await this.save("error");
            return;
        }
        if (this.running) { this.pauseRequested = false; this.resumePending = true; return; }
        clearTimeout(this.timer);
        this.pauseRequested = false;
        if (!this.record.videoId && this.record.copyComplete === false && !this.copying) {
            if (this.record.source.kind === "blob") {
                try {
                    await SVUploadFile.validate(this.record.source);
                    this.record.copyComplete = true;
                    this.record.copiedBytes = this.record.size;
                } catch {}
            }
        }
        if (!this.record.videoId && this.record.copyComplete === false && !this.copying) {
            if (this.record.source.kind !== "cordova" || (!this.originalFile && (!this.record.source.originalUri || this.record.sourceUnavailable))) {
                this.record.needsFile = true;
                this.record.error = "Le téléphone ne donne plus accès à la source. Choisis à nouveau la même vidéo pour vérifier la copie.";
                await this.save("error");
                return;
            }
            this.record.needsFile = false;
            this.record.error = null;
            this.startCopyRecovery();
        }
        this.running = true;
        let releaseSlot;
        try {
            if (this.record.videoId) { await this.watch(); return; }
            if (this.callbacks.acquire) {
                await this.save("queued");
                if (this.pauseRequested) return;
                this.slotController = new AbortController();
                releaseSlot = await this.callbacks.acquire(this.slotController.signal);
                this.slotController = null;
                if (this.pauseRequested) return;
            }
            await this.save("connecting");
            if (!this.record.sessionId) {
                const created = await this.json("/uploads", { method: "POST", body: JSON.stringify({ clientId: this.record.id,
                    filename: this.record.name, size: this.record.size, title: this.record.title, description: this.record.description }) });
                this.record.sessionId = created.id;
                await this.save();
            }
            if (this.pauseRequested) return;
            let session = await this.json("/uploads/" + encodeURIComponent(this.record.sessionId));
            if (this.pauseRequested) return;
            if (session.status === "complete") { this.record.videoId = session.videoId; await this.save("processing"); releaseSlot?.(); releaseSlot = null; await this.watch(); return; }
            if (!Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > this.record.size) throw new Error("Position reçue du serveur invalide.");
            this.record.offset = session.offset;
            await this.save("uploading");
            while (this.record.offset < this.record.size && !this.pauseRequested) {
                const start = this.record.offset;
                const end = Math.min(this.record.size, start + this.chunkSize);
                while ((this.record.copyVerifying || (this.record.copiedBytes ?? this.record.size) < end) && this.copying && !this.pauseRequested) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (this.pauseRequested) break;
                if (this.copyError || (this.record.copiedBytes ?? this.record.size) < end) {
                    const error = new Error("La vidéo source est inaccessible ou sa copie est incomplète."); error.status = 422; throw error;
                }
                let bytes;
                try { bytes = await SVUploadFile.readAvailable(this.record.source, start, end); }
                catch (cause) { const error = new Error(cause.message || "La copie locale de la vidéo est inaccessible."); error.status = 422; throw error; }
                if (this.pauseRequested) break;
                const started = performance.now();
                let conflict = false;
                try { session = await this.sendChunk(start, bytes); }
                catch (error) {
                    if (error.status !== 409) throw error;
                    conflict = true;
                    session = await this.json("/uploads/" + encodeURIComponent(this.record.sessionId));
                }
                if (!Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > this.record.size) throw new Error("Position reçue du serveur invalide.");
                if (session.offset === start || (!conflict && session.offset < start)) throw new Error("Le serveur n'a pas encore confirmé ce bloc.");
                const elapsed = Math.max(.001, (performance.now() - started) / 1000);
                const measured = Math.max(0, session.offset - start) / elapsed;
                if (measured > 0) this.speed = this.speed ? this.speed * .7 + measured * .3 : measured;
                this.chunkSize = Math.max(5 * 1024 * 1024, Math.min(8 * 1024 * 1024, Math.round(this.speed * 4 / (64 * 1024)) * 64 * 1024));
                this.record.offset = session.offset;
                await this.save();
            }
            if (this.pauseRequested) return;
            while (this.copying && !this.pauseRequested) await new Promise(resolve => setTimeout(resolve, 100));
            if (this.pauseRequested) return;
            if (this.copyError || this.record.copyComplete === false) { const error = new Error("La copie de la vidéo est incomplète."); error.status = 422; throw error; }
            await this.save("finalizing");
            session = await this.json("/uploads/" + encodeURIComponent(this.record.sessionId) + "/complete", { method: "POST" });
            this.record.videoId = session.videoId;
            if (!this.record.videoId) throw new Error("La finalisation est en attente. Réessaie dans un instant.");
            await this.save("processing");
            releaseSlot?.(); releaseSlot = null;
            await this.watch();
        } catch (error) {
            if (!this.record || this.pauseRequested || error.aborted) return;
            this.record.error = error.message;
            this.speed = 0;
            this.chunkSize = 5 * 1024 * 1024;
            if (error.status && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409 && error.status !== 429) {
                await this.save("error");
            } else {
                await this.save("interrupted");
                this.timer = setTimeout(() => this.resume(), 5000);
            }
        } finally {
            this.slotController = null;
            releaseSlot?.();
            this.running = false;
            const again = this.resumePending;
            this.resumePending = false;
            if (this.record && again && !this.pauseRequested) this.resume();
        }
    }

    async watch() {
        while (!this.pauseRequested && this.record?.videoId) {
            const video = await this.json("/videos/" + encodeURIComponent(this.record.videoId));
            if (video.statut === "prete") {
                try { await window.SVPublicationNotifications?.complete(this.record); } catch (error) { console.warn("Notification indisponible", error); }
                try { await SVUploadFile.remove(this.record.source); this.record.cleanupPending = false; }
                catch (error) { this.record.cleanupPending = true; console.warn("Nettoyage de la copie locale reporté", error); }
                await this.save("done");
                if (!this.record.cleanupPending) await SVUploadStore.remove(this.record.id);
                return;
            }
            if (video.statut === "erreur") { const error = new Error(video.erreur || "La préparation de la vidéo a échoué."); error.status = 422; throw error; }
            await this.save("processing");
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    async pause() {
        if (!this.record || ["preparing", "done"].includes(this.record.state)) return;
        ++this.identityGeneration;
        this.pauseRequested = true;
        this.resumePending = false;
        clearTimeout(this.timer);
        this.request?.abort();
        this.requestController?.abort();
        this.slotController?.abort();
        this.copyController?.abort();
        if (this.copyTask) await this.copyTask.catch(() => {});
        this.record.copyVerifying = false;
        this.speed = 0;
        await this.save("paused");
    }

    async cancel() {
        // Retirer de l'écran, mais conserver la copie et la session reprenable.
        await this.pause();
        if (!this.record) return;
        this.record.hidden = true;
        await this.save("paused");
    }

    async remove() {
        if (!this.record || this.record.state === "preparing") return;
        this.pauseRequested = true;
        this.resumePending = false;
        clearTimeout(this.timer);
        this.request?.abort();
        this.requestController?.abort();
        this.slotController?.abort();
        this.copyController?.abort();
        if (this.copyTask) await this.copyTask.catch(() => {});
        while (this.running) await new Promise(resolve => setTimeout(resolve, 50));
        const record = this.record;
        if (!record.videoId) await this.json("/uploads/" + encodeURIComponent(record.sessionId || record.id), { method: "DELETE" }).catch(() => {});
        if (record.source) await SVUploadFile.remove(record.source);
        else if (window.cordova) await SVUploadFile.remove({ id: record.id, kind: "cordova" }).catch(() => {});
        await SVUploadStore.remove(record.id);
        this.record = null;
        this.display();
    }
};
