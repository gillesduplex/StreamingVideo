
const fs = require("node:fs");
const path = require("node:path");
const db = require("./config/db");

const fichierCatalogue = path.join(
    __dirname, "storage", "catalogue.json"
);

const dossierVideos = path.join(
    __dirname, "storage", "videos"
);

async function importerVideos() {
    try {
        if (!fs.existsSync(fichierCatalogue)) {
            throw new Error("catalogue.json introuvable.");
        }

        // Sauvegarder le catalogue original
        fs.copyFileSync(
            fichierCatalogue,
            fichierCatalogue + ".avant-postgresql.bak"
        );

        const catalogue = JSON.parse(
            fs.readFileSync(fichierCatalogue, "utf8")
        );

        let importees = 0;
        let ignorees = 0;

        for (const video of catalogue) {
            const dossier = path.join(dossierVideos, video.id);

            const playlist = path.join(dossier, "index.m3u8");
            const initialisation = path.join(dossier, "init.m4s");

            // Importer uniquement les conversions réussies
            if (
                video.statut !== "prete" ||
                !fs.existsSync(playlist) ||
                !fs.existsSync(initialisation)
            ) {
                console.log("Ignorée :", video.titre, video.id);
                ignorees++;
                continue;
            }

            const resultat = await db.query(`
                INSERT INTO public.videos (
                    id,
                    titre,
                    statut,
                    chemin_hls,
                    hash_sha256,
                    duree_secondes,
                    largeur,
                    hauteur,
                    date_ajout
                )
                VALUES (
                    $1, $2, 'prete', $3,
                    $4, $5, $6, $7,
                    COALESCE($8::timestamptz, NOW())
                )
                ON CONFLICT (id) DO NOTHING
                RETURNING id
            `, [
                video.id,
                video.titre,
                `/hls/${video.id}/index.m3u8`,
                video.hash_sha256 || null,
                video.duree ?? null,
                video.largeur ?? null,
                video.hauteur ?? null,
                video.date_ajout || null
            ]);

            if (resultat.rowCount > 0) {
                console.log("Importée :", video.titre);
                importees++;
            } else {
                console.log("Déjà en base :", video.titre);
            }
        }

        console.log("Vidéos importées :", importees);
        console.log("Vidéos ignorées :", ignorees);

        const verification = await db.query(
            "SELECT COUNT(*)::integer AS total FROM public.videos"
        );

        console.log(
            "Total PostgreSQL :",
            verification.rows[0].total
        );

    } catch (erreur) {
        console.error("Erreur d'importation :", erreur.message);
        process.exitCode = 1;
    } finally {
        await db.end();
    }
}

importerVideos();
