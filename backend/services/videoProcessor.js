
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

// Exécuter FFmpeg ou FFprobe
function executer(programme, args, options = {}) {
    return new Promise((resolve, reject) => {

        const processus = spawn(programme, args, {
            windowsHide: true,
            ...options
        });

        let sortie = "";
        let erreurs = "";

        processus.stdout.on("data", data => {
            sortie += data.toString();
        });

        processus.stderr.on("data", data => {
            erreurs = (erreurs + data.toString()).slice(-6000);
        });

        processus.once("error", reject);

        processus.once("close", code => {
            if (code === 0) {
                resolve(sortie);
            } else {
                reject(new Error(
                    erreurs || "Erreur FFmpeg, code " + code
                ));
            }
        });
    });
}

// Limiter la fréquence d'images à 30 FPS
function calculerFPS(valeur) {
    const [n, d] = String(valeur || "")
        .split("/")
        .map(Number);

    const fps = d ? n / d : n;

    return Number.isFinite(fps) && fps > 0
        ? Math.min(fps, 30)
        : 30;
}

// Choisir les qualités sans agrandir la source
function choisirQualites(resolutionCourte) {

    const debits = {
        240: 350,
        360: 650,
        480: 1200,
        720: 2500,
        1080: 4500
    };

    let cibles;

    if (resolutionCourte >= 720) {
        cibles = [480, 720, 1080];
    } else if (resolutionCourte >= 480) {
        cibles = [360, 480];
    } else {
        cibles = [240, 360];
    }

    const qualites = cibles
        .filter(q => q <= resolutionCourte)
        .map(q => ({
            nom: q + "p",
            court: q,
            debitMax: debits[q]
        }));

    // Conserver aussi une version adaptée à la
    // résolution originale quand elle ne correspond
    // pas à une qualité standard.
    const meilleure = qualites.at(-1);

    if (
        resolutionCourte <= 1080 &&
        (!meilleure ||
         resolutionCourte - meilleure.court >= 20)
    ) {
        qualites.push({
            nom: "source",
            court: resolutionCourte,
            debitMax: Math.min(
                4500,
                Math.round(
                    (meilleure?.debitMax || 350) * 1.4
                )
            )
        });
    }

    return qualites;
}

// Estimer le débit des segments réellement générés
async function mesurerDebits(dossier) {

    const contenu = await fs.readFile(
        path.join(dossier, "index.m3u8"),
        "utf8"
    );

    const lignes = contenu.split(/\r?\n/);

    let bits = 0;
    let secondes = 0;
    let debitPic = 0;

    for (let i = 0; i < lignes.length - 1; i++) {

        if (!lignes[i].startsWith("#EXTINF:")) {
            continue;
        }

        const duree = Number(
            lignes[i].split(":")[1].split(",")[0]
        );

        const segment = lignes[i + 1].trim();

        if (
            !(duree > 0) ||
            !/^segment_\d+\.m4s$/.test(segment)
        ) {
            continue;
        }

        const fichier = await fs.stat(
            path.join(dossier, segment)
        );

        const debit = fichier.size * 8 / duree;

        bits += fichier.size * 8;
        secondes += duree;

        debitPic = Math.max(debitPic, debit);
    }

    if (secondes === 0) {
        throw new Error(
            "Aucun segment valide dans la playlist."
        );
    }

    return {
        pic: Math.ceil(debitPic * 1.10),
        moyenne: Math.ceil(bits / secondes)
    };
}

// Fonction principale de conversion
async function traiterVideo(fichierSource, dossierSortie) {

    // 1. Analyser la vidéo originale
    const resultat = await executer(ffprobePath, [
        "-v", "error",
        "-show_entries",
        "stream=codec_type,width,height,avg_frame_rate:format=duration",
        "-of", "json",
        fichierSource
    ]);

    const infos = JSON.parse(resultat);

    const flux = infos.streams.find(
        s => s.codec_type === "video"
    );

    const largeur = Number(flux?.width);
    const hauteur = Number(flux?.height);
    const duree = Number(infos.format?.duration);

    const avecAudio = infos.streams.some(
        s => s.codec_type === "audio"
    );

    if (
        !Number.isSafeInteger(largeur) ||
        !Number.isSafeInteger(hauteur) ||
        largeur < 16 ||
        hauteur < 16 ||
        !Number.isFinite(duree) ||
        duree <= 0
    ) {
        throw new Error("Vidéo originale invalide.");
    }

    const fps = calculerFPS(flux.avg_frame_rate);

    const qualites = choisirQualites(
        Math.min(largeur, hauteur)
    );

    await fs.mkdir(dossierSortie, {
        recursive: true
    });

    // 2. Préparer la playlist principale
    let master = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-INDEPENDENT-SEGMENTS"
    ].join("\n") + "\n";

    const qualitesGenerees = [];

    // 3. Encoder chaque qualité séparément
    for (const q of qualites) {

        const echelle =
            q.court / Math.min(largeur, hauteur);

        // Garder le ratio de la vidéo originale
        // et des dimensions paires pour H.264
        const w = Math.max(
            2,
            Math.floor(largeur * echelle / 2) * 2
        );

        const h = Math.max(
            2,
            Math.floor(hauteur * echelle / 2) * 2
        );

        const dossierQualite = path.join(
            dossierSortie, q.nom
        );

        await fs.mkdir(dossierQualite, {
            recursive: true
        });

        console.log(
            "Encodage", q.nom, ":", w + "x" + h
        );

        // Chaque conversion travaille dans
        // son propre dossier de qualité.
        await executer(ffmpegPath, [
            "-hide_banner",
            "-loglevel", "error",
            "-y",

            "-i", fichierSource,

            "-map", "0:v:0",
            "-map", "0:a:0?",

            "-vf",
            `scale=${w}:${h}:flags=lanczos,fps=${fps.toFixed(3)}`,

            "-c:v", "libx264", //Encode la vidéo avec le codec H.264
            "-preset", "veryfast", // 	Accélère l'encodage au prix d'une efficacité de compression un peu moindre
            "-crf", "23", // 	Définit une qualité cible avec un compromis entre qualité visuelle et taille
            "-profile:v", "main", // 	Définit le profil H.264 pour la compatibilité avec les appareils
            "-level:v", "4.2",   // 	Définit le niveau H.264 pour la compatibilité avec les appareils
            "-pix_fmt", "yuv420p",  // 	Définit le format de pixel pour la compatibilité avec les appareils

            "-maxrate", q.debitMax + "k",  // 	Définit le débit binaire maximum pour la vidéo
            "-bufsize", (q.debitMax * 2) + "k",  // 	Définit la taille du tampon pour le contrôle du débit binaire sur une période de temps

            "-force_key_frames", 
            "expr:gte(t,n_forced*4)",
            "-sc_threshold", "0",

            "-c:a", "aac", // 	Encode l'audio avec le codec AAC
            "-b:a", "96k", // 	Définit le débit binaire pour l'audio
            "-ac", "2", // 	Définit le nombre de canaux pour l'audio

            "-f", "hls",  // 	Définit le format de sortie pour la playlist HLS
            "-hls_time", "4", // 	Définit la durée de chaque segment HLS en secondes
            "-hls_playlist_type", "vod", // 	Définit le type de playlist HLS pour la vidéo à la demande
            "-hls_segment_type", "fmp4", // 	Définit le type de segment HLS pour la vidéo à la demande
            "-hls_fmp4_init_filename", "init.m4s", // 	Définit le nom du fichier d'initialisation pour les segments HLS fMP4
            "-hls_flags", "independent_segments", // 	Définit les segments HLS comme indépendants pour permettre un démarrage rapide de la lecture
            "-hls_segment_filename", "segment_%04d.m4s", // 	Définit le modèle de nommage pour les segments HLS fMP4

            "index.m3u8" // indique au lecteur quels fragments lire et dans quel ordre, ainsi que les métadonnées associées à la vidéo

        ], {
            cwd: dossierQualite
        });

        // 4. Vérifier les fichiers obligatoires
        await Promise.all([
            "index.m3u8",
            "init.m4s",
            "segment_0000.m4s"
        ].map(nom => fs.access(
            path.join(dossierQualite, nom)
        )));

        const debits = await mesurerDebits(
            dossierQualite
        );

        // Les codecs correspondent à H.264 Main 4.2
        // et AAC-LC, si une piste audio existe.
        const codecs = avecAudio
            ? "avc1.4d402a,mp4a.40.2"
            : "avc1.4d402a";

        // Ajouter la qualité à master.m3u8
        master +=
            `#EXT-X-STREAM-INF:` +
            `BANDWIDTH=${debits.pic},` +
            `AVERAGE-BANDWIDTH=${debits.moyenne},` +
            `RESOLUTION=${w}x${h},` +
            `FRAME-RATE=${fps.toFixed(3)},` +
            `CODECS="${codecs}"\n` +
            `${q.nom}/index.m3u8\n`;

        qualitesGenerees.push({
            nom: q.nom,
            largeur: w,
            hauteur: h
        });
    }

    // 5. Publier la playlist après validation
    await fs.writeFile(
        path.join(dossierSortie, "master.m3u8"),
        master,
        "utf8"
    );

    const meilleure = qualitesGenerees.at(-1);

    let affiche = false;
    try {
        await executer(ffmpegPath, [
            "-hide_banner", "-loglevel", "error", "-y", "-ss", "0",
            "-i", fichierSource, "-frames:v", "1", "-vf", "scale=480:-2",
            "-q:v", "4", path.join(dossierSortie, "affiche.jpg")
        ]);
        affiche = true;
    } catch (erreur) {
        console.warn("Miniature indisponible :", erreur.message);
    }

    console.log("Streaming multiqualité terminé.");

    return {
        duree,
        largeur: meilleure.largeur,
        hauteur: meilleure.hauteur,
        affiche,
        qualites: qualitesGenerees
    };
}

module.exports = { traiterVideo };
