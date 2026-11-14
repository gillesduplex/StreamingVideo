"use strict";

// Génère uniquement les miniatures manquantes, sans réencoder les vidéos.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const ffmpeg = require("ffmpeg-static");
const db = require("../config/db");
const { initialiserSocial } = require("../services/social");
const run = promisify(execFile);

async function genererAffiches() {
    await initialiserSocial(db);
    const { rows } = await db.query("SELECT id, chemin_original, chemin_hls FROM public.videos WHERE statut = 'prete' AND chemin_affiche IS NULL");
    let total = 0;
    for (const video of rows) {
        const root = path.resolve(__dirname, "..");
        const storage = path.join(root, "storage") + path.sep;
        const folder = path.join(root, "storage", "videos", video.id);
        try {
            const candidates = [];
            if (video.chemin_original) candidates.push({ path: path.resolve(root, video.chemin_original), hls: false });
            if (video.chemin_hls?.startsWith("/hls/")) candidates.push({
                path: path.resolve(root, "storage", "videos", video.chemin_hls.slice(5)), hls: true
            });
            let source;
            for (const candidate of candidates) {
                if (!candidate.path.startsWith(storage)) continue;
                try { await fs.access(candidate.path); source = candidate; break; } catch {}
            }
            if (!source) throw new Error("Aucun original ni flux HLS local disponible.");
            await fs.mkdir(folder, { recursive: true });
            const hlsOptions = source.hls ? ["-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL"] : [];
            const output = path.join(folder, "affiche.jpg");
            await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...hlsOptions, "-i", source.path,
                "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", output], { windowsHide: true });
            if (!(await fs.stat(output)).size) throw new Error("La miniature est vide.");
            await db.query("UPDATE public.videos SET chemin_affiche = $1 WHERE id = $2", ["/hls/" + video.id + "/affiche.jpg", video.id]);
            total++;
        } catch (error) { console.warn("Miniature ignorée pour " + video.id + " : " + error.message); }
    }
    console.log(total + " miniature(s) créée(s).");
}

if (require.main === module) genererAffiches().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.end());
module.exports = { genererAffiches };
