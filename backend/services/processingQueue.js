const fs = require("node:fs/promises");
const os = require("node:os");

// FIFO : une vidéo coûteuse est exclusive ; deux petites vidéos peuvent
// progresser ensemble si la machine possède une marge suffisante.
function creerFileTraitement({ analyser, traiter, cpus, memoireLibre, onError = console.error }) {
    const file = [];
    const presentes = new Set();
    const actives = new Map();
    let lectureEnCours = false;
    const capacite = cpus || (() => os.availableParallelism ? os.availableParallelism() : os.cpus().length);
    const libre = memoireLibre || (() => os.freemem());

    function petite(infos, taille) {
        return taille <= 50 * 1024 * 1024 && infos &&
            infos.duree <= 120 && infos.largeur * infos.hauteur <= 1280 * 720 &&
            infos.fpsSource > 0 && infos.fpsSource <= 30;
    }

    async function preparer(job) {
        if (job.prepare) return;
        job.prepare = true;
        try {
            const stat = await fs.stat(job.source);
            job.infos = await analyser(job.source);
            job.petite = petite(job.infos, stat.size);
        } catch (error) {
            // Le traitement normal signalera l'erreur dans la base.
            job.petite = false;
            job.infos = null;
        }
    }

    async function avancer() {
        if (lectureEnCours) return;
        lectureEnCours = true;
        try {
            while (file.length) {
                if (actives.size >= 2 || [...actives.values()].some(job => !job.petite)) break;
                const job = file[0];
                await preparer(job);
                // Ne pas dépasser la capacité, même si l'analyse a pris du temps.
                if (actives.size && (!job.petite || capacite() < 4 || libre() < 1024 ** 3)) break;
                file.shift();
                actives.set(job.id, job);
                Promise.resolve().then(() => traiter(job.id, job.source, job.infos))
                    .catch(onError)
                    .finally(() => {
                        actives.delete(job.id);
                        presentes.delete(job.id);
                        void avancer();
                    });
            }
        } catch (error) {
            onError(error);
        } finally {
            lectureEnCours = false;
        }
    }

    return function ajouter(id, source) {
        if (presentes.has(id)) return;
        presentes.add(id);
        file.push({ id, source });
        void avancer();
    };
}

module.exports = { creerFileTraitement };
