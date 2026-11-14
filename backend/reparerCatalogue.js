
const fs = require("node:fs");
const path = require("node:path");

const fichier = path.join(
    __dirname, "storage", "catalogue.json"
);

// Sauvegarder le catalogue original
fs.copyFileSync(fichier, fichier + ".bak");

const videos = JSON.parse(
    fs.readFileSync(fichier, "utf8")
);

let nombre = 0;

for (const video of videos) {
    const initialisation = path.join(
        __dirname,
        "storage",
        "videos",
        video.id,
        "init.m4s"
    );

    if (
        video.statut === "prete" &&
        !fs.existsSync(initialisation)
    ) {
        video.statut = "erreur";
        video.erreur = "Conversion incomplète : init.m4s absent.";
        nombre++;
    }
}

fs.writeFileSync(
    fichier,
    JSON.stringify(videos, null, 2),
    "utf8"
);

console.log(
    nombre + " vidéo(s) marquée(s) comme incomplète(s)."
);
