"use strict";

const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const { avecPlaceFFmpeg } = require("./videoProcessor");

const MAX_REQUEST_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_MULTIPART_SIZE = MAX_REQUEST_SIZE + 16 * 1024 * 1024;
const MAX_PHOTOS = 1000;
const MAX_PHOTO_SIZE = 50 * 1024 * 1024;
const PHOTO_SECONDS = 3;
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".webm"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv", ".3gp", ".3gpp", ".m4v"]);
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function executer(programme, args, options = {}) {
    return new Promise((resolve, reject) => {
        const processus = spawn(programme, args, { windowsHide: true, ...options });
        let erreurs = "";
        processus.stderr.on("data", data => { erreurs = (erreurs + data.toString()).slice(-4000); });
        processus.once("error", reject);
        processus.once("close", code => code === 0
            ? resolve()
            : reject(new Error(erreurs || "Le traitement des photos a échoué.")));
    });
}

async function supprimer(chemins) {
    await Promise.all(chemins.filter(Boolean).map(chemin => fs.rm(chemin, { force: true, recursive: true })));
}

async function verifierImage(fichier) {
    let sortie;
    try {
        sortie = await new Promise((resolve, reject) => {
            const processus = spawn(ffprobePath, [
                "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height", "-of", "json", fichier
            ], { windowsHide: true });
            let stdout = "";
            let stderr = "";
            processus.stdout.on("data", data => { stdout += data.toString(); });
            processus.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-2000); });
            processus.once("error", reject);
            processus.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || "Image invalide.")));
        });
    } catch (error) {
        throw Object.assign(new Error("Une photo n'a pas pu être lue : vérifie son format."), { status: 400, cause: error });
    }
    let stream;
    try { stream = JSON.parse(sortie).streams?.[0]; }
    catch (error) { throw Object.assign(new Error("Une photo est invalide ou illisible."), { status: 400, cause: error }); }
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (!(width > 0 && height > 0)) {
        throw Object.assign(new Error("Une photo est invalide ou illisible."), { status: 400 });
    }
    if (width > 20000 || height > 20000 || width * height > 100_000_000) {
        throw Object.assign(new Error("La résolution d'une photo dépasse la limite technique de 100 mégapixels."), { status: 413 });
    }
}

function creerPhotoPosts({ db, temporaires, originauxDir, sonsDir, enqueue, analyser }) {
    const router = express.Router();
    const stockage = multer.diskStorage({
        destination: temporaires,
        filename: (req, file, callback) => callback(null, randomUUID() + path.extname(file.originalname).toLowerCase())
    });
    const recevoirFichiers = multer({
        storage: stockage,
        limits: { fileSize: MAX_REQUEST_SIZE, files: MAX_PHOTOS + 2, fields: 8, fieldSize: 16 * 1024 },
        fileFilter: (req, file, callback) => {
            const extension = path.extname(file.originalname).toLowerCase();
            const allowed = file.fieldname === "photos" ? PHOTO_EXTENSIONS.has(extension)
                : file.fieldname === "audio" ? AUDIO_EXTENSIONS.has(extension)
                    : file.fieldname === "sourceVideo" && VIDEO_EXTENSIONS.has(extension);
            callback(allowed ? null : Object.assign(new Error("Format de photo, de son ou de vidéo non accepté."), { status: 400 }), allowed);
        }
    }).fields([{ name: "photos" }, { name: "audio", maxCount: 1 }, { name: "sourceVideo", maxCount: 1 }]);

    router.get("/sounds", route(async (req, res) => {
        const entries = await fs.readdir(sonsDir, { withFileTypes: true });
        const sounds = await Promise.all(entries
            .filter(entry => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
            .map(async entry => {
                await fs.access(path.join(sonsDir, entry.name));
                const title = path.basename(entry.name, path.extname(entry.name)).replace(/[_-]+/g, " ").trim();
                return { id: entry.name, title: title || "Son du catalogue", url: "/sounds/" + encodeURIComponent(entry.name) };
            }));
        res.json(sounds.sort((a, b) => a.title.localeCompare(b.title, "fr")));
    }));

    router.post("/", (req, res, next) => {
        if (!req.profile?.id) {
            return res.status(401).json({ message: "Ton profil n'a pas pu être identifié. Recharge la page." });
        }
        const length = Number(req.get("Content-Length"));
        if (!Number.isSafeInteger(length) || length < 1) {
            return res.status(411).json({ message: "La taille totale de la publication doit être connue avant l'envoi." });
        }
        if (length > MAX_MULTIPART_SIZE) {
            return res.status(413).json({ message: "La publication photo dépasse la limite technique de 2 Gio." });
        }
        recevoirFichiers(req, res, error => {
            if (error) {
                const partial = Object.values(req.files || {}).flat();
                supprimer(partial.map(file => file.path)).catch(cleanupError => console.error("Nettoyage upload photo :", cleanupError));
                return next(error);
            }
            next();
        });
    }, route(async (req, res) => {
        const files = Object.values(req.files || {}).flat();
        const photos = req.files?.photos || [];
        const audio = req.files?.audio?.[0] || null;
        const sourceVideo = req.files?.sourceVideo?.[0] || null;
        const temporaryPaths = files.map(file => file.path);
        const id = randomUUID();
        const montage = path.join(temporaires, id + "-montage.mp4");
        const listePhotos = path.join(temporaires, id + "-photos.ffconcat");
        const originalPath = path.join(originauxDir, id + ".mp4");
        let postSaved = false;
        let audioPath = null;
        let extractedAudioPath = null;

        try {
            if (!photos.length) throw Object.assign(new Error("Sélectionne au moins une photo."), { status: 400 });
            if (photos.length > MAX_PHOTOS) throw Object.assign(new Error("Une publication ne peut pas dépasser 1 000 photos."), { status: 413 });
            if (photos.some(file => file.size > MAX_PHOTO_SIZE)) throw Object.assign(new Error("Chaque photo doit faire 50 Mio maximum."), { status: 413 });
            if ([audio, sourceVideo, req.body.soundId].filter(Boolean).length > 1) {
                throw Object.assign(new Error("Choisis une seule source sonore."), { status: 400 });
            }
            if (files.reduce((sum, file) => sum + file.size, 0) > MAX_REQUEST_SIZE) {
                throw Object.assign(new Error("La publication photo dépasse la limite technique de 2 Gio."), { status: 413 });
            }
            const titre = (typeof req.body.titre === "string" && req.body.titre.trim()) ||
                path.basename(photos[0].originalname, path.extname(photos[0].originalname)).replace(/[_-]+/g, " ").slice(0, 255);
            const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
            if (titre.length > 255 || description.length > 2000 || /\u0000/.test(titre + description)) {
                throw Object.assign(new Error("Le titre est limité à 255 caractères et la description à 2 000 caractères."), { status: 400 });
            }

            for (const photo of photos) await verifierImage(photo.path);

            if (sourceVideo) {
                let sourceAnalysis;
                try { sourceAnalysis = await analyser(sourceVideo.path); }
                catch (error) {
                    throw Object.assign(new Error("La vidéo choisie ne peut pas être lue pour en extraire le son."), { status: 400, cause: error });
                }
                if (!sourceAnalysis.avecAudio) {
                    throw Object.assign(new Error("La vidéo choisie ne contient pas de piste sonore."), { status: 400 });
                }
                extractedAudioPath = path.join(temporaires, id + "-extrait.m4a");
                audioPath = extractedAudioPath;
                await avecPlaceFFmpeg(() => executer(ffmpegPath, [
                    "-hide_banner", "-loglevel", "error", "-y", "-i", sourceVideo.path,
                    "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k", audioPath
                ]));
            } else if (req.body.soundId) {
                const soundId = path.basename(String(req.body.soundId));
                if (soundId !== req.body.soundId || !AUDIO_EXTENSIONS.has(path.extname(soundId).toLowerCase())) {
                    throw Object.assign(new Error("Son du catalogue invalide."), { status: 400 });
                }
                audioPath = path.join(sonsDir, soundId);
                const stat = await fs.stat(audioPath).catch(() => null);
                if (!stat?.isFile()) throw Object.assign(new Error("Son du catalogue introuvable."), { status: 404 });
            } else if (audio) {
                audioPath = audio.path;
            }

            const lines = ["ffconcat version 1.0"];
            for (const photo of photos) lines.push(`file '${path.basename(photo.path)}'`, `duration ${PHOTO_SECONDS}`);
            lines.push(`file '${path.basename(photos.at(-1).path)}'`);
            await fs.writeFile(listePhotos, lines.join("\n") + "\n", "utf8");

            const duree = photos.length * PHOTO_SECONDS;
            const args = [
                "-hide_banner", "-loglevel", "error", "-y",
                "-f", "concat", "-safe", "0", "-i", listePhotos
            ];
            if (audioPath) args.push("-stream_loop", "-1", "-i", audioPath);
            args.push(
                "-map", "0:v:0",
                ...(audioPath ? ["-map", "1:a:0", "-af", "apad"] : ["-an"]),
                "-vf", "scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
                "-r", "30", "-t", String(duree + 0.1), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
                ...(audioPath ? ["-c:a", "aac", "-b:a", "128k"] : []),
                "-movflags", "+faststart", montage
            );
            await avecPlaceFFmpeg(() => executer(ffmpegPath, args, { cwd: temporaires }));

            const analyse = await analyser(montage);
            await fs.rename(montage, originalPath);
            const cheminRelatif = "storage/originaux/" + id + ".mp4";
            const audioTitle = sourceVideo
                ? (path.basename(sourceVideo.originalname, path.extname(sourceVideo.originalname)) + " · son extrait").slice(0, 120)
                : audio ? path.basename(audio.originalname, path.extname(audio.originalname)).slice(0, 120)
                    : req.body.soundId ? path.basename(req.body.soundId, path.extname(req.body.soundId)).replace(/[_-]+/g, " ").slice(0, 120)
                        : null;

            await db.query(`
                INSERT INTO public.videos (
                    id, titre, statut, taille_originale, chemin_original,
                    auteur_id, description, media_type, photo_count,
                    photo_interval_seconds, audio_title, duree_secondes
                )
                VALUES ($1, $2, 'en_attente', $3, $4, $5, $6, 'photo', $7, $8, $9, $10)
            `, [id, titre, (await fs.stat(originalPath)).size, cheminRelatif, req.profile.id,
                description, photos.length, PHOTO_SECONDS, audioTitle, analyse.duree]);
            postSaved = true;
            enqueue(id, originalPath);
            res.status(202).json({ id, titre, statut: "en_attente", media_type: "photo", photo_count: photos.length });
        } finally {
            await supprimer([...temporaryPaths, montage, listePhotos, extractedAudioPath,
                !postSaved ? originalPath : null]);
        }
    }));

    return router;
}

module.exports = { creerPhotoPosts, PHOTO_SECONDS, MAX_PHOTOS };
