"use strict";

// La copie Cordova reste dans un unique répertoire privé dont seul un UUID
// contrôlé constitue le nom. Le fichier original n'est jamais déplacé ni effacé.
window.SVUploadFile = (() => {
    const DIRECTORY = "streamingvideo-uploads";
    const COPY_SIZE = 1024 * 1024;

    function safeId(id) {
        if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Identifiant de copie locale invalide.");
        return id;
    }

    function abortError() { return new DOMException("Préparation annulée.", "AbortError"); }
    function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

    async function cordovaReady() {
        if (!window.cordova) return false;
        if (window.cordova.file?.dataDirectory && window.resolveLocalFileSystemURL) return true;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Le stockage du téléphone n'est pas disponible.")), 15000);
            document.addEventListener("deviceready", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (!window.cordova.file?.dataDirectory || !window.resolveLocalFileSystemURL) throw new Error("Le stockage privé du téléphone n'est pas disponible.");
        return true;
    }

    function resolveURL(uri) {
        return new Promise((resolve, reject) => window.resolveLocalFileSystemURL(uri, resolve, reject));
    }
    async function directory(create) {
        const base = await resolveURL(window.cordova.file.dataDirectory);
        return new Promise((resolve, reject) => base.getDirectory(DIRECTORY, { create }, resolve, reject));
    }
    async function entryFor(id, create = false) {
        const dir = await directory(create);
        return new Promise((resolve, reject) => dir.getFile(safeId(id) + ".upload", { create, exclusive: create }, resolve, reject));
    }
    function fileFor(entry) { return new Promise((resolve, reject) => entry.file(resolve, reject)); }
    function writerFor(entry) { return new Promise((resolve, reject) => entry.createWriter(resolve, reject)); }
    function deleteEntry(entry) { return new Promise((resolve, reject) => entry.remove(resolve, reject)); }

    function readSlice(file, start, end) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error("Impossible de lire la vidéo sur le téléphone."));
            reader.onabort = () => reject(abortError());
            try { reader.readAsArrayBuffer(file.slice(start, end)); } catch (error) { reject(error); }
        });
    }

    function sameBytes(first, second) {
        const left = new Uint8Array(first), right = new Uint8Array(second);
        if (left.length !== right.length) return false;
        for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
        return true;
    }

    function writeSlice(writer, data, position) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = error => {
                if (settled) return;
                settled = true;
                writer.onerror = writer.onwriteend = writer.onabort = null;
                if (error) reject(error); else resolve();
            };
            writer.onerror = () => finish(writer.error || new Error("Impossible de copier la vidéo sur le téléphone."));
            writer.onabort = () => finish(abortError());
            writer.onwriteend = () => finish(writer.error || null);
            try { writer.seek(position); writer.write(data); } catch (error) { finish(error); }
        });
    }

    // Démarrer la copie après avoir rendu son descripteur à l'appelant.
    // Le réseau peut alors lire seulement les octets dont l'écriture est achevée.
    async function begin(file, id, onProgress = () => {}, signal) {
        safeId(id);
        const size = Number(file?.size);
        if (!Number.isSafeInteger(size) || size <= 0 || typeof file?.slice !== "function") throw new Error("La vidéo sélectionnée est vide ou inaccessible.");
        checkAbort(signal);
        const source = { id, size, name: String(file.name || "video.mp4"), type: String(file.type || "application/octet-stream"),
            ...(Number.isFinite(file.lastModified) && file.lastModified > 0 ? { originalLastModified: file.lastModified } : {}) };

        if (await cordovaReady()) {
            let entry;
            try {
                entry = await entryFor(id, true);
                const writer = await writerFor(entry);
                const stored = { ...source, kind: "cordova", uri: entry.toURL(), ...(file.localURL ? { originalUri: file.localURL } : {}) };
                const complete = new Promise((resolve, reject) => setTimeout(async () => {
                    try {
                        onProgress(0, size);
                        for (let offset = 0; offset < size;) {
                            checkAbort(signal);
                            const end = Math.min(size, offset + COPY_SIZE);
                            // Une capture Cordova doit encore exister tant que sa copie n'est pas terminée.
                            let current = file;
                            if (file.localURL) {
                                try { current = await fileFor(await resolveURL(file.localURL)); }
                                catch { throw new Error("La vidéo d'origine a disparu avant la fin de la copie."); }
                                if (Number(current.size) !== size) throw new Error("La vidéo d'origine a changé pendant la copie.");
                            }
                            const data = await readSlice(current, offset, end);
                            if (!(data instanceof ArrayBuffer) || data.byteLength !== end - offset) throw new Error("La vidéo d'origine est inaccessible ou sa lecture est incomplète.");
                            checkAbort(signal);
                            await writeSlice(writer, data, offset);
                            offset = end;
                            onProgress(offset, size);
                        }
                        checkAbort(signal);
                        const saved = await fileFor(entry);
                        if (Number(saved.size) !== size) throw new Error("La copie de la vidéo est incomplète.");
                        resolve(stored);
                    } catch (error) {
                        if (error?.code === 10 || error?.name === "QuotaExceededError") reject(new Error("Espace insuffisant pour préparer la vidéo sur le téléphone."));
                        else reject(error);
                    }
                }, 0));
                return { source: stored, complete };
            } catch (error) {
                if (entry) await deleteEntry(entry).catch(() => {});
                if (error?.code === 10 || error?.name === "QuotaExceededError") throw new Error("Espace insuffisant pour préparer la vidéo sur le téléphone.");
                throw error;
            }
        }

        // La sélection peut provenir d'une iframe : instanceof Blob échoue
        // entre fenêtres alors que Blob.prototype.slice accepte ce même Blob.
        try { Blob.prototype.slice.call(file, 0, 0); }
        catch { throw new Error("Le navigateur ne peut pas conserver ce fichier pour une reprise."); }
        const stored = { ...source, kind: "blob" };
        const complete = new Promise((resolve, reject) => setTimeout(async () => {
            try {
                onProgress(0, size);
                await SVUploadStore.putBlob(id, file);
                checkAbort(signal);
                onProgress(size, size);
                resolve(stored);
            } catch (error) { reject(error); }
        }, 0));
        return { source: stored, complete };
    }

    // Reprendre uniquement lorsque Cordova peut encore rouvrir l'original.
    // La taille réelle de la copie, et non le dernier progrès affiché, fait foi.
    async function resumeCopy(source, onProgress = () => {}, signal, selectedFile = null) {
        safeId(source?.id);
        if (source.kind !== "cordova" || (!source.originalUri && !selectedFile) || !Number.isSafeInteger(source.size) || source.size <= 0) {
            throw new Error("La vidéo d'origine ne peut pas être retrouvée automatiquement.");
        }
        checkAbort(signal);
        if (!await cordovaReady()) throw new Error("Le stockage du téléphone n'est pas disponible.");
        const entry = await entryFor(source.id);
        const writer = await writerFor(entry);
        const initial = await fileFor(entry);
        if (!Number.isSafeInteger(initial.size) || initial.size > source.size) throw new Error("La copie locale de la vidéo est invalide.");
        const complete = new Promise((resolve, reject) => setTimeout(async () => {
            try {
                const originalFile = async () => {
                    let original;
                    if (selectedFile) original = selectedFile;
                    else {
                        try { original = await fileFor(await resolveURL(source.originalUri)); }
                        catch { throw new Error("La vidéo d'origine est inaccessible avant la fin de la copie."); }
                    }
                    if (Number(original.size) !== source.size ||
                        (source.originalLastModified && original.lastModified && original.lastModified !== source.originalLastModified) ||
                        (selectedFile && source.name && selectedFile.name !== source.name)) {
                        throw new Error("La vidéo sélectionnée est différente ou a changé depuis le début de la copie.");
                    }
                    return original;
                };
                // Comparer tous les octets déjà copiés avant de les réutiliser :
                // un même nom ou une même taille ne prouve pas que c'est le même fichier.
                const original = await originalFile();
                for (let position = 0; position < initial.size; position += COPY_SIZE) {
                    checkAbort(signal);
                    const end = Math.min(initial.size, position + COPY_SIZE);
                    const [savedBytes, originalBytes] = await Promise.all([
                        readSlice(initial, position, end), readSlice(original, position, end)
                    ]);
                    if (!sameBytes(savedBytes, originalBytes)) {
                        throw new Error("La vidéo sélectionnée ne correspond pas à la copie conservée.");
                    }
                }
                let offset = initial.size;
                onProgress(offset, source.size);
                while (offset < source.size) {
                    checkAbort(signal);
                    const original = await originalFile();
                    const end = Math.min(source.size, offset + COPY_SIZE);
                    const bytes = await readSlice(original, offset, end);
                    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== end - offset) throw new Error("La lecture de la vidéo d'origine est incomplète.");
                    checkAbort(signal);
                    await writeSlice(writer, bytes, offset);
                    offset = end;
                    onProgress(offset, source.size);
                }
                checkAbort(signal);
                if (Number((await fileFor(entry)).size) !== source.size) throw new Error("La copie de la vidéo est incomplète.");
                resolve(source);
            } catch (error) { reject(error); }
        }, 0));
        return { source, complete };
    }

    // Interface historique pour les appelants qui attendent une copie complète.
    async function persist(file, id, onProgress = () => {}, signal) {
        const started = await begin(file, id, onProgress, signal);
        try { return await started.complete; }
        catch (error) { await remove(started.source).catch(() => {}); throw error; }
    }

    // Après une fermeture avant l'enregistrement du descripteur, retrouver
    // une éventuelle copie privée par son UUID, jamais par son seul nom.
    async function findPartial(record) {
        safeId(record?.id);
        const source = { id: record.id, size: record.size, name: record.name, type: record.type,
            ...(record.originalUri ? { originalUri: record.originalUri } : {}),
            ...(record.originalLastModified ? { originalLastModified: record.originalLastModified } : {}) };
        if (await cordovaReady()) {
            try {
                const entry = await entryFor(record.id);
                return { ...source, kind: "cordova", uri: entry.toURL() };
            } catch (error) { if (error?.code === 1 || error?.name === "NotFoundError") return null; throw error; }
        }
        return await SVUploadStore.getBlob(record.id) ? { ...source, kind: "blob" } : null;
    }

    // IndexedDB stocke le Blob en une transaction complète : il n'existe pas
    // de préfixe partiel à réutiliser si cette transaction a été interrompue.
    async function compareBlobSelection(source, file) {
        const saved = await SVUploadStore.getBlob(safeId(source.id));
        if (!saved) return false;
        if (Number(saved.size) !== Number(file.size)) throw new Error("La vidéo choisie ne correspond pas à la copie conservée.");
        for (let start = 0; start < file.size; start += COPY_SIZE) {
            const end = Math.min(file.size, start + COPY_SIZE);
            const [leftBuffer, rightBuffer] = await Promise.all([readSlice(saved, start, end), readSlice(file, start, end)]);
            if (!sameBytes(leftBuffer, rightBuffer)) {
                throw new Error("La vidéo choisie ne correspond pas à la copie conservée.");
            }
        }
        return true;
    }

    // Dans la même session, comparer le fichier rechoisi à l'objet File
    // initial sur toute sa longueur, pas seulement sur le préfixe copié.
    async function compareFiles(original, selected) {
        if (!original || !selected || Number(original.size) !== Number(selected.size)) return false;
        if (original === selected) return true;
        for (let start = 0; start < original.size; start += COPY_SIZE) {
            const end = Math.min(original.size, start + COPY_SIZE);
            const [first, second] = await Promise.all([readSlice(original, start, end), readSlice(selected, start, end)]);
            if (!sameBytes(first, second)) return false;
        }
        return true;
    }

    // Une URI persistée permet de comparer toute la source après navigation.
    async function openOriginal(source) {
        if (!source?.originalUri || !await cordovaReady()) throw new Error("La vidéo d'origine n'est plus accessible.");
        const original = await fileFor(await resolveURL(source.originalUri));
        if (Number(original.size) !== Number(source.size) ||
            (source.originalLastModified && original.lastModified && source.originalLastModified !== original.lastModified)) {
            throw new Error("La vidéo d'origine a changé depuis le début de la copie.");
        }
        return original;
    }

    async function localFile(source) {
        safeId(source?.id);
        let file;
        if (source.kind === "cordova") {
            if (!await cordovaReady()) throw new Error("Cette vidéo est enregistrée dans l'application Android.");
            file = await fileFor(await entryFor(source.id));
        } else if (source.kind === "blob") {
            file = await SVUploadStore.getBlob(source.id);
        } else throw new Error("La copie locale de cette vidéo est introuvable.");
        if (!file || Number(file.size) !== Number(source.size)) throw new Error("La copie locale de la vidéo est absente ou incomplète.");
        return file;
    }

    async function read(source, start, end) {
        const file = await localFile(source);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.size) throw new Error("Plage de vidéo invalide.");
        const data = await readSlice(file, start, end);
        if (!(data instanceof ArrayBuffer) || data.byteLength !== end - start) throw new Error("La lecture de la vidéo est incomplète.");
        return data;
    }

    // Une nouvelle consultation de la taille évite de lire le bloc que le
    // FileWriter est encore en train d'écrire en parallèle.
    async function readAvailable(source, start, end) {
        safeId(source?.id);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.size) throw new Error("Plage de vidéo invalide.");
        let file;
        if (source.kind === "cordova") {
            if (!await cordovaReady()) throw new Error("Cette vidéo est enregistrée dans l'application Android.");
            file = await fileFor(await entryFor(source.id));
        } else if (source.kind === "blob") file = await SVUploadStore.getBlob(source.id);
        else throw new Error("La copie locale de cette vidéo est introuvable.");
        if (!file || Number(file.size) < end || Number(file.size) > Number(source.size)) throw new Error("Cette portion de la vidéo n'est pas encore copiée.");
        const data = await readSlice(file, start, end);
        if (!(data instanceof ArrayBuffer) || data.byteLength !== end - start) throw new Error("La lecture de la vidéo est incomplète.");
        return data;
    }

    async function remove(source) {
        if (!source) return;
        safeId(source.id);
        if (source.kind === "blob") { await SVUploadStore.removeBlob(source.id); return; }
        if (source.kind !== "cordova") throw new Error("Copie locale inconnue.");
        if (!await cordovaReady()) throw new Error("Le stockage du téléphone n'est pas disponible.");
        try { await deleteEntry(await entryFor(source.id)); }
        catch (error) { if (error?.code !== 1 && error?.name !== "NotFoundError") throw error; }
    }

    return { begin, resumeCopy, persist, findPartial, compareBlobSelection, compareFiles, openOriginal, read, readAvailable, remove, validate: localFile };
})();
