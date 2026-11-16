"use strict";

// Sessions conservées sur disque : un seul processus serveur doit gérer ce dossier.
// Un bloc n'est confirmé qu'après son écriture et la mise à jour atomique de la fiche.
const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 2 * 1024 * 1024 * 1024;
const BLOCK_LIMIT = 8 * 1024 * 1024;
const EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv", ".3gp", ".3gpp", ".m4v"]);
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const problem = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });

function creerUploads({ db, temporaires, originauxDir, enqueue }) {
    const router = express.Router();
    const directory = path.join(temporaires, "reprises");
    const locks = new Map();
    const metadataPath = id => path.join(directory, id + ".json");
    const partialPath = id => path.join(directory, id + ".part");
    const originalPath = session => path.join(originauxDir, session.videoId + session.extension);
    const relativePath = session => "storage/originaux/" + session.videoId + session.extension;
    const view = session => ({ id: session.id, offset: session.offset, size: session.size,
        status: session.status, videoId: session.status === "complete" ? session.videoId : null });

    async function locked(id, operation) {
        const previous = locks.get(id) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        locks.set(id, tail);
        await previous;
        try { return await operation(); }
        finally { release(); if (locks.get(id) === tail) locks.delete(id); }
    }

    async function save(session) {
        await fs.mkdir(directory, { recursive: true });
        const temporary = path.join(directory, session.id + "." + randomUUID() + ".tmp");
        let handle;
        try {
            handle = await fs.open(temporary, "wx");
            await handle.writeFile(JSON.stringify(session), "utf8");
            await handle.sync();
            await handle.close(); handle = null;
            await fs.rename(temporary, metadataPath(session.id));
        } finally {
            await handle?.close().catch(() => {});
            await fs.unlink(temporary).catch(() => {});
        }
    }

    async function read(id, owner) {
        if (!UUID.test(id)) throw problem(400, "Identifiant d'envoi invalide.");
        let session;
        try { session = JSON.parse(await fs.readFile(metadataPath(id), "utf8")); }
        catch (error) {
            if (error.code === "ENOENT") throw problem(404, "Envoi introuvable.");
            throw problem(500, "La fiche de cet envoi est illisible.");
        }
        if (session.id !== id || !UUID.test(session.videoId || "") || !UUID.test(session.owner || "") ||
            !Number.isSafeInteger(session.size) || session.size < 1 || session.size > LIMIT ||
            !Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > session.size ||
            !EXTENSIONS.has(session.extension) || !["uploading", "finalizing", "complete"].includes(session.status)) {
            throw problem(500, "La fiche de cet envoi est invalide.");
        }
        if (owner && session.owner !== owner) throw problem(404, "Envoi introuvable.");
        return session;
    }

    async function repairPartial(session) {
        let stat;
        try { stat = await fs.stat(partialPath(session.id)); }
        catch (error) {
            if (error.code === "ENOENT" && session.offset === 0) return;
            if (error.code === "ENOENT") throw problem(409, "Le fichier partiel de cet envoi est introuvable.");
            throw error;
        }
        if (!stat.isFile() || stat.size < session.offset) throw problem(409, "Le fichier partiel de cet envoi est incomplet.");
        // Un arrêt après écriture et avant confirmation laisse des octets non validés.
        if (stat.size > session.offset) {
            const handle = await fs.open(partialPath(session.id), "r+");
            try { await handle.truncate(session.offset); await handle.sync(); } finally { await handle.close(); }
        }
    }

    const identity = (req, res, next) => req.profile?.id
        ? next() : res.status(401).json({ message: "Ton profil n'a pas pu être identifié. Recharge la page." });
    router.use(identity);
    router.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

    router.post("/", route(async (req, res) => {
        const { clientId, filename, size, title = "", description = "" } = req.body || {};
        if (typeof clientId !== "string" || !UUID.test(clientId)) throw problem(400, "Identifiant local invalide.");
        if (typeof filename !== "string" || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(filename)) {
            throw problem(400, "Nom de fichier invalide.");
        }
        const extension = path.extname(filename).toLowerCase();
        if (!EXTENSIONS.has(extension)) throw problem(400, "Format vidéo non accepté.");
        if (!Number.isSafeInteger(size) || size < 1 || size > LIMIT) throw problem(413, "La vidéo doit faire au maximum 2 Gio.");
        if (typeof title !== "string" || title.length > 255 || typeof description !== "string" || description.length > 2000 ||
            /\u0000/.test(title + description)) throw problem(400, "Titre ou description invalide.");
        const result = await locked(clientId, async () => {
            let session;
            try { session = await read(clientId, req.profile.id); }
            catch (error) { if (error.status !== 404) throw error; }
            if (session) {
                if (session.size !== size || session.filename !== filename) throw problem(409, "Cet identifiant appartient à un autre fichier.");
                return session;
            }
            // Ne pas permettre à un autre profil de réutiliser un identifiant existant.
            try { await fs.access(metadataPath(clientId)); throw problem(404, "Envoi introuvable."); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            session = { id: clientId, owner: req.profile.id, videoId: randomUUID(), filename, extension,
                size, title: title.trim() || filename.replace(/\.[^.]+$/, "").replace(/_/g, " ").slice(0, 255),
                description: description.trim(), offset: 0, status: "uploading", createdAt: new Date().toISOString() };
            await save(session);
            return session;
        });
        res.status(200).json(view(result));
    }));

    router.get("/:id", route(async (req, res) => {
        const session = await locked(req.params.id, async () => {
            const found = await read(req.params.id, req.profile.id);
            if (found.status === "uploading") await repairPartial(found);
            return found;
        });
        res.json(view(session));
    }));

    router.patch("/:id", express.raw({ type: "application/octet-stream", limit: BLOCK_LIMIT }), route(async (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) throw problem(400, "Le bloc est vide ou son type est invalide.");
        const offsetHeader = req.get("Upload-Offset");
        if (!/^(0|[1-9]\d*)$/.test(offsetHeader || "")) throw problem(400, "Position de bloc invalide.");
        const offset = Number(offsetHeader);
        if (!Number.isSafeInteger(offset)) throw problem(400, "Position de bloc invalide.");
        const session = await locked(req.params.id, async () => {
            const current = await read(req.params.id, req.profile.id);
            if (current.status !== "uploading" || current.offset !== offset) {
                throw problem(409, "La position de l'envoi a changé.", { offset: current.offset });
            }
            if (req.body.length > current.size - current.offset) throw problem(413, "Le bloc dépasse la taille annoncée.");
            await fs.mkdir(directory, { recursive: true });
            await repairPartial(current);
            let handle;
            try { handle = await fs.open(partialPath(current.id), current.offset === 0 ? "a+" : "r+");
                let written = 0;
                while (written < req.body.length) {
                    const result = await handle.write(req.body, written, req.body.length - written, current.offset + written);
                    if (!result.bytesWritten) throw new Error("Écriture du bloc interrompue.");
                    written += result.bytesWritten;
                }
                await handle.sync();
            } finally { await handle?.close(); }
            current.offset += req.body.length;
            await save(current);
            return current;
        });
        res.json(view(session));
    }));

    async function finish(session) {
        if (session.status === "complete") return session;
        if (session.offset !== session.size) throw problem(409, "La vidéo n'est pas entièrement reçue.", { offset: session.offset });
        if (session.status === "uploading") {
            await repairPartial(session);
            session.status = "finalizing";
            await save(session);
        }
        const source = partialPath(session.id), destination = originalPath(session);
        let sourceStat, destinationStat;
        try { sourceStat = await fs.stat(source); } catch (error) { if (error.code !== "ENOENT") throw error; }
        try { destinationStat = await fs.stat(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (sourceStat && destinationStat) throw problem(409, "Deux fichiers existent pour cet envoi ; vérification nécessaire.");
        if (sourceStat) {
            if (!sourceStat.isFile() || sourceStat.size !== session.size) throw problem(409, "Taille du fichier reçu invalide.");
            await fs.mkdir(originauxDir, { recursive: true });
            await fs.rename(source, destination);
        } else if (!destinationStat?.isFile() || destinationStat.size !== session.size) {
            throw problem(409, "Fichier reçu introuvable ou incomplet.");
        }
        await db.query(`INSERT INTO public.videos (id, titre, statut, taille_originale, chemin_original, auteur_id, description)
            VALUES ($1, $2, 'en_attente', $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [session.videoId, session.title, session.size, relativePath(session), session.owner, session.description]);
        const { rows } = await db.query("SELECT id, statut, chemin_original, auteur_id, message_erreur FROM public.videos WHERE id = $1", [session.videoId]);
        const video = rows[0];
        if (!video || video.chemin_original !== relativePath(session) || video.auteur_id !== session.owner) {
            throw problem(409, "La publication associée à cet envoi est incohérente.");
        }
        if (video.statut === "erreur" && video.message_erreur === "Mise en attente interrompue par le serveur.") {
            await db.query("UPDATE public.videos SET statut = 'en_attente', message_erreur = NULL WHERE id = $1", [session.videoId]);
            video.statut = "en_attente";
        }
        if (video.statut === "en_attente") enqueue(session.videoId, destination);
        session.status = "complete";
        await save(session);
        return session;
    }

    router.post("/:id/complete", route(async (req, res) => {
        const session = await locked(req.params.id, async () => finish(await read(req.params.id, req.profile.id)));
        res.json(view(session));
    }));

    router.delete("/:id", route(async (req, res) => {
        await locked(req.params.id, async () => {
            const session = await read(req.params.id, req.profile.id);
            if (session.status !== "uploading") throw problem(409, "Cet envoi est déjà en cours de publication.");
            await fs.unlink(partialPath(session.id)).catch(error => { if (error.code !== "ENOENT") throw error; });
            await fs.unlink(metadataPath(session.id));
        });
        res.status(204).end();
    }));

    // Après un redémarrage du processus, une finalisation peut avoir déplacé
    // l'original ou créé la ligne avant de mettre à jour sa fiche. Reprendre ces
    // opérations idempotentes et remettre en file uniquement les conversions
    // qui n'avaient pas commencé à encoder. Un processus FFmpeg déjà lancé peut
    // survivre à Node ; le redémarrer automatiquement risquerait deux écritures.
    router.recover = async () => {
        let entries;
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            const id = entry.name.slice(0, -5);
            if (!UUID.test(id)) continue;
            try {
                await locked(id, async () => {
                    const session = await read(id);
                    if (session.status === "finalizing") { await finish(session); return; }
                    if (session.status !== "complete") return;
                    const { rows } = await db.query("SELECT id, statut, chemin_original, auteur_id, message_erreur FROM public.videos WHERE id = $1", [session.videoId]);
                    const video = rows[0];
                    if (!video || video.auteur_id !== session.owner || video.chemin_original !== relativePath(session) ||
                        video.statut !== "erreur" || video.message_erreur !== "Mise en attente interrompue par le serveur.") return;
                    const stat = await fs.stat(originalPath(session));
                    if (!stat.isFile() || stat.size !== session.size) throw new Error("Fichier original incomplet.");
                    await db.query("UPDATE public.videos SET statut = 'en_attente', message_erreur = NULL WHERE id = $1", [session.videoId]);
                    enqueue(session.videoId, originalPath(session));
                });
            } catch (error) { console.error("Récupération d'envoi impossible :", id, error.message); }
        }
    };

    router.use((error, req, res, next) => {
        if (!error.status || error.status >= 500) return next(error);
        res.status(error.status).json({ message: error.message, ...(Number.isSafeInteger(error.offset) ? { offset: error.offset } : {}) });
    });

    return router;
}

module.exports = { creerUploads, BLOCK_LIMIT, LIMIT };
