
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("node:path");
const fs = require("node:fs");
const fichiers = require("node:fs/promises");

const { randomUUID, createHash } = require("node:crypto");

const db = require("./config/db");
const { traiterVideo } = require("./services/videoProcessor");
const { initialiserSocial, enrichirVideos, creerSocial } = require("./services/social");

const app = express();

const PORT = Number(process.env.PORT || 3001);

const temporaires = path.join(
    __dirname, "uploads", "temporaires"
);

const videosDir = path.join(
    __dirname, "storage", "videos"
);

const originauxDir = path.join(
    __dirname, "storage", "originaux"
);

fs.mkdirSync(originauxDir, { recursive: true });

// Créer les dossiers si nécessaire
fs.mkdirSync(temporaires, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });

app.use(express.json({ limit: "16kb" }));

// Pour les tests de développement local uniquement
app.use(cors());
app.use("/api", creerSocial(db));

// Une seule interface de publication pour le navigateur et Cordova.
app.get("/", (req, res) => res.redirect("/app/"));
app.get("/upload.html", (req, res) => res.redirect("/app/upload.html"));
app.get("/app/cordova.js", (req, res) => res.type("application/javascript").send("// Le navigateur utilise les API Web ; Cordova fournit ce fichier sur Android.\n"));

// Interface d'ajout des vidéos
app.use(express.static(
    path.join(__dirname, "public")
));

// Interface de lecture façon TikTok
app.use("/app", express.static(
    path.join(__dirname, "../www")
));

// Diffusion des playlists et segments HLS/fMP4
app.use("/hls", express.static(videosDir, {
    setHeaders: (res, fichier) => {
        if (fichier.endsWith(".m3u8")) {
            // Ces playlists sont des vidéos publiées, pas des fenêtres de direct.
            res.setHeader("Cache-Control", "public, max-age=60");
            res.setHeader(
                "Content-Type",
                "application/vnd.apple.mpegurl"
            );
        }

        if (fichier.endsWith(".m4s")) {
            res.setHeader("Content-Type", "video/mp4");
            // Les segments publiés sous un UUID ne changent pas : un retour
            // sur une vidéo peut réutiliser les octets déjà téléchargés.
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
    }
}));

// Calculer le SHA-256 sans charger tout le MP4 en mémoire
async function calculerSHA256(chemin) {
    const hash = createHash("sha256");

    for await (const morceau of fs.createReadStream(chemin)) {
        hash.update(morceau);
    }

    return hash.digest("hex");
}

// Configuration de réception des MP4

const stockage = multer.diskStorage({
    destination: temporaires,

    filename: (req, fichier, callback) => {
        const extension = path.extname(
            fichier.originalname
        ).toLowerCase();

        callback(null, randomUUID() + extension);
    }
});


const upload = multer({
    storage: stockage,

    limits: {
        fileSize: 2 * 1024 * 1024 * 1024,
        files: 1
    },

   
fileFilter: (req, fichier, callback) => {

    const extension = path.extname(
        fichier.originalname
    ).toLowerCase();

    const extensionsAutorisees = [
        ".mp4",
        ".webm",
        ".mov",
        ".mkv",
        ".3gp",
        ".3gpp",
        ".m4v"
    ];

    if (!extensionsAutorisees.includes(extension)) {
        return callback(
            Object.assign(new Error("Formats acceptés : MP4, WebM, MOV, MKV, M4V et 3GP."), { status: 400 })
        );
    }

    callback(null, true);
}

});

// Vérifier le backend et PostgreSQL
app.get("/api/test", async (req, res) => {
    try {
        const resultat = await db.query(
            "SELECT current_database() AS base"
        );

        res.json({
            message: "Backend StreamingVideo opérationnel",
            base: resultat.rows[0].base
        });

    } catch (erreur) {
        console.error(erreur);

        res.status(500).json({
            message: "Erreur de connexion PostgreSQL."
        });
    }
});

// Liste des vidéos prêtes pour le lecteur
app.get("/api/videos", async (req, res) => {
    try {
        const resultat = await db.query(`
            SELECT
                id,
                titre,
                statut,
                chemin_hls AS url_hls,
                hash_sha256,
                duree_secondes AS duree,
                largeur,
                hauteur,
                date_ajout
            FROM public.videos
            WHERE statut = 'prete'
            ORDER BY date_ajout DESC
        `);

        res.json(await enrichirVideos(db, resultat.rows, req.profile?.id));

    } catch (erreur) {
        console.error(erreur);

        res.status(500).json({
            message: "Impossible de charger les vidéos."
        });
    }
});

// Voir les informations et le statut d'une vidéo
app.get("/api/videos/:id", async (req, res) => {

    const id = req.params.id;

    const uuidValide =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!uuidValide.test(id)) {
        return res.status(400).json({
            message: "Identifiant invalide."
        });
    }

    try {
        const resultat = await db.query(`
            SELECT
                id,
                titre,
                statut,
                chemin_hls AS url_hls,
                hash_sha256,
                taille_originale,
                duree_secondes AS duree,
                largeur,
                hauteur,
                message_erreur AS erreur,
                date_ajout
            FROM public.videos
            WHERE id = $1
        `, [id]);

        if (!resultat.rowCount) {
            return res.status(404).json({
                message: "Vidéo introuvable."
            });
        }

        const [video] = await enrichirVideos(db, resultat.rows, req.profile?.id);
        res.json(video);

    } catch (erreur) {
        console.error(erreur);

        res.status(500).json({
            message: "Impossible de consulter cette vidéo."
        });
    }
});

// Une seule conversion à la fois dans ce prototype
let fileTraitement = Promise.resolve();

// Conversion automatique d'une vidéo enregistrée
async function convertirVideo(id, cheminSource) {

    const dossierSortie = path.join(videosDir, id);

    try {
        // 1. Début du traitement
        await db.query(`
            UPDATE public.videos
            SET statut = 'en_cours',
                date_modification = NOW()
            WHERE id = $1
        `, [id]);

        console.log("Traitement commencé :", id);

        // 2. Hachage du fichier original
        const hash = await calculerSHA256(cheminSource);

       
const infos = await traiterVideo(
    cheminSource,
    dossierSortie
);

// Vérifier que la playlist principale existe
const fichierMaster = path.join(
    dossierSortie,
    "master.m3u8"
);

const informationsMaster = await fichiers.stat(
    fichierMaster
);

if (informationsMaster.size === 0) {
    throw new Error(
        "La playlist master.m3u8 est vide."
    );
}

// Construire l'adresse de diffusion
const cheminHLS = `/hls/${id}/master.m3u8`;


        // 5. Enregistrer les résultats dans PostgreSQL
       
        await db.query(`
            UPDATE public.videos
            SET statut = 'prete',
                chemin_hls = $1,
                hash_sha256 = $2,
                duree_secondes = $3,
                largeur = $4,
                hauteur = $5,
                qualites = $6::jsonb,
                chemin_affiche = $8,
                message_erreur = NULL,
                date_modification = NOW()
            WHERE id = $7
        `, [
            cheminHLS,
            hash,
            infos.duree,
            infos.largeur,
            infos.hauteur,
            JSON.stringify(infos.qualites),
            id,
            infos.affiche ? `/hls/${id}/affiche.jpg` : null
        ]);


        console.log("Vidéo prête :", id);

    } catch (erreur) {

        console.error(
            "Erreur de traitement vidéo :",
            erreur.message
        );

        try {
            await db.query(`
                UPDATE public.videos
                SET statut = 'erreur',
                    message_erreur = $1,
                    date_modification = NOW()
                WHERE id = $2
            `, [erreur.message.slice(0, 1000), id]);

        } catch (erreurBase) {
            console.error(
                "Erreur PostgreSQL :",
                erreurBase.message
            );
        }

        // Supprimer la conversion incomplète
        await fichiers.rm(dossierSortie, {
            recursive: true,
            force: true
        }).catch(console.error);

    }finally {
        console.log(
            "Vidéo originale conservée :",
            cheminSource
        );
    }
}

// Recevoir une vidéo et lancer son traitement
app.post(
    "/api/videos",
    upload.single("video"),
    async (req, res) => {

        if (!req.file) {
            return res.status(400).json({
                message: "Aucune vidéo reçue."
            });
        }

        const id = randomUUID();


        const extension = path.extname(
            req.file.filename
        ).toLowerCase();

        const cheminOriginal = path.join(
            originauxDir,
            id + extension
        );

        const cheminOriginalRelatif =
            "storage/originaux/" + id + extension;


        const titre = (typeof req.body.titre === "string" && req.body.titre.trim()) ||
            path.basename(req.file.originalname).replace(/\.[^.]+$/, "").replace(/_/g, " ").slice(0, 255);
        const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
        if (titre.length > 255 || description.length > 2000 || /\u0000/.test(titre + description)) {
            await fichiers.unlink(req.file.path).catch(console.error);
            return res.status(400).json({ message: "Le titre est limité à 255 caractères et la description à 2 000 caractères." });
        }

        try {
            // Conserver le MP4 original dans son dossier définitif
            await fichiers.rename(req.file.path, cheminOriginal);
            // Enregistrer la vidéo AVANT la conversion
            
            await db.query(`
                INSERT INTO public.videos (
                    id,
                    titre,
                    statut,
                    taille_originale,
                    chemin_original,
                    auteur_id,
                    description
                )
                VALUES ($1, $2, 'en_attente', $3, $4, $5, $6)
            `, [
                id,
                titre,
                req.file.size,
                cheminOriginalRelatif,
                req.profile?.id || null,
                description
            ]);


            // Ajouter à la file de traitement
            fileTraitement = fileTraitement
                .then(() => convertirVideo(
                    id,
                    cheminOriginal
                ))
                .catch(erreur => {
                    console.error(
                        "Erreur de la file :",
                        erreur
                    );
                });

            // Réponse immédiate au formulaire
            res.status(202).json({
                id,
                titre,
                statut: "en_attente",
                url_hls: null
            });

        
        } catch (erreur) {

            console.error("Erreur d'enregistrement :", erreur);

            // Vérifier où se trouve le fichier original
            const cheminConserve = fs.existsSync(cheminOriginal)
                ? cheminOriginal
                : fs.existsSync(req.file.path)
                    ? req.file.path
                    : null;

            console.error(
                "Envoi échoué. Vérifier le fichier conservé :",
                cheminConserve || "Aucun fichier trouvé"
            );

            res.status(500).json({
                message:
                    "Impossible d'enregistrer la vidéo dans PostgreSQL."
            });
        }

    }
);

// Renvoyer les erreurs d'envoi au format JSON
app.use((erreur, req, res, next) => {

    console.error("Erreur HTTP :", erreur.message);

    const statut = erreur instanceof multer.MulterError ? 413 :
        (erreur.status >= 400 && erreur.status < 500 ? erreur.status : 500);
    res.status(statut).json({ message: statut < 500 ? erreur.message : "Le serveur rencontre un problème. Réessaie dans un instant." });
});

// Démarrer uniquement si PostgreSQL est accessible
async function demarrer() {
    try {
        await db.query("SELECT 1");
        await initialiserSocial(db);

        // Les tâches interrompues ne redémarrent pas
        // automatiquement dans ce premier prototype.
        await db.query(`
            UPDATE public.videos
            SET statut = 'erreur',
                message_erreur =
                    'Traitement interrompu par le serveur.',
                date_modification = NOW()
            WHERE statut IN ('en_attente', 'en_cours')
        `);


return app.listen(PORT, "0.0.0.0", () => {
    console.log(
        "StreamingVideo démarré sur le port " + PORT
    );
    console.log(
        "Accès local : http://localhost:" + PORT
    );
});

    } catch (erreur) {
        console.error(
            "Démarrage impossible :",
            erreur.message
        );

        process.exitCode = 1;
    }
}

if (require.main === module) demarrer();

module.exports = { app, demarrer };
