
document.addEventListener("DOMContentLoaded", function () {

    const $ = id => document.getElementById(id);

    const video = $("lecteur");
    const scene = $("scene");

    const API = new URL(
        window.APP_CONFIG.API_BASE_URL,
        window.location.href
    );

    let catalogue = [];
    let indexActuel = 0;
    let hls = null;
    let sonActif = false;
    let aime = false;
    let numeroChargement = 0;

    function message(texte) {
        $("message").textContent = texte;
        $("message").hidden = !texte;
    }

    function chargement(texte) {
        $("chargement").textContent = texte;
        $("chargement").hidden = !texte;
    }

    function urlVideo(item) {
        return new URL(item.url_hls, API.origin).href;
    }

    function afficherLecture() {
        $("lecturePause").textContent =
            video.paused ? "▶" : "Ⅱ";

        $("lecturePause").classList.toggle(
            "visible",
            video.paused
        );
    }

    async function jouer() {
        try {
            await video.play();
            message("");
        } catch (erreur) {
            chargement("");
            message(
                "Lecture automatique bloquée. " +
                "Appuie sur ▶ pour démarrer."
            );
        }
    }

    // Charger la vidéo actuellement sélectionnée
    function chargerVideo(index) {
        if (catalogue.length === 0) return;

        indexActuel =
            (index + catalogue.length) % catalogue.length;

        const item = catalogue[indexActuel];
        const source = urlVideo(item);
        const chargementCourant = ++numeroChargement;

        // Libérer l'ancien lecteur HLS
        if (hls) {
            hls.destroy();
            hls = null;
        }

        video.pause();
        video.removeAttribute("src");
        video.load();

        video.muted = !sonActif;
        video.loop = false;

        $("titreVideo").textContent = item.titre;

        $("compteur").textContent =
            "Vidéo " + (indexActuel + 1) +
            " sur " + catalogue.length;

        $("progressionLecture").style.width = "0%";

        aime = false;
        $("aimer").classList.remove("aime");
        $("aimer").querySelector(".symbole").textContent = "♡";

        message("");
        chargement("Chargement de la vidéo...");

        // Lecture HLS.js
        if (window.Hls && Hls.isSupported()) {

            const instance = new Hls({
                enableWorker: true,
                maxBufferLength: 15,
                maxMaxBufferLength: 30
            });

            hls = instance;

            instance.on(
                Hls.Events.MANIFEST_PARSED,
                function () {
                    if (chargementCourant !== numeroChargement) {
                        return;
                    }
                    jouer();
                }
            );

            instance.on(
                Hls.Events.ERROR,
                function (evenement, erreur) {
                    console.error("Erreur HLS :", erreur);

                    if (
                        erreur.fatal &&
                        chargementCourant === numeroChargement
                    ) {
                        chargement("");
                        message(
                            "Erreur de lecture vidéo. " +
                            "Appuie sur ↻ pour réessayer."
                        );
                    }
                }
            );

            instance.loadSource(source);
            instance.attachMedia(video);

        } else if (
            video.canPlayType(
                "application/vnd.apple.mpegurl"
            )
        ) {
            // Lecture HLS native
            video.src = source;

            video.addEventListener(
                "loadedmetadata",
                function lancement() {
                    video.removeEventListener(
                        "loadedmetadata",
                        lancement
                    );

                    if (chargementCourant === numeroChargement) {
                        jouer();
                    }
                }
            );

        } else {
            chargement("");
            message(
                "Ce navigateur ne prend pas en charge HLS."
            );
        }

        afficherLecture();

        // Précharger légèrement la playlist suivante
        if (catalogue.length > 1) {
            const suivant =
                catalogue[(indexActuel + 1) % catalogue.length];

            fetch(urlVideo(suivant), {
                cache: "force-cache"
            }).catch(() => {});
        }
    }

    // Vidéo suivante ou précédente
    function changerVideo(deplacement) {
        if (!catalogue.length) return;

        chargerVideo(indexActuel + deplacement);
    }

    // Récupérer le catalogue depuis Node.js
    async function chargerCatalogue() {
        chargement("Chargement du catalogue...");
        message("");

        try {
            const reponse = await fetch(
                API.href.replace(/\/$/, "") + "/videos"
            );

            if (!reponse.ok) {
                throw new Error("HTTP " + reponse.status);
            }

            const resultats = await reponse.json();

            catalogue = resultats.filter(
                v => v.statut === "prete" && v.url_hls
            );

            if (!catalogue.length) {
                chargement("");
                message(
                    "Aucune vidéo disponible. " +
                    "Ajoute d'abord des vidéos depuis upload.html."
                );
                return;
            }

            chargerVideo(0);

        } catch (erreur) {
            console.error(erreur);
            chargement("");
            message(
                "Connexion au serveur impossible : " +
                erreur.message
            );
        }
    }

    // Lecture automatique de la suivante
    video.addEventListener("ended", function () {
        changerVideo(1);
    });

    video.addEventListener("playing", function () {
        chargement("");
        afficherLecture();
    });

    video.addEventListener("pause", afficherLecture);

    video.addEventListener("waiting", function () {
        if (!video.paused) {
            chargement("Chargement...");
        }
    });

    video.addEventListener("timeupdate", function () {
        if (
            Number.isFinite(video.duration) &&
            video.duration > 0
        ) {
            const pourcentage =
                (video.currentTime / video.duration) * 100;

            $("progressionLecture").style.width =
                pourcentage + "%";
        }
    });

    video.addEventListener("click", function () {
        if (video.paused) jouer();
        else video.pause();
    });

    $("lecturePause").addEventListener("click", function () {
        if (video.paused) jouer();
        else video.pause();
    });

    $("suivant").addEventListener("click", function () {
        changerVideo(1);
    });

    $("precedent").addEventListener("click", function () {
        changerVideo(-1);
    });

    $("actualiser").addEventListener("click", function () {
        chargerCatalogue();
    });

    $("son").addEventListener("click", function () {
        sonActif = !sonActif;
        video.muted = !sonActif;

        $("son").querySelector(".symbole").textContent =
            sonActif ? "🔊" : "🔇";
    });

    // J'aime : interface locale pour commencer
    $("aimer").addEventListener("click", function () {
        aime = !aime;

        $("aimer").classList.toggle("aime", aime);

        $("aimer").querySelector(".symbole").textContent =
            aime ? "♥" : "♡";
    });

    // Balayage vertical sur téléphone
    let debutY = null;

    scene.addEventListener("touchstart", function (event) {
        if (event.target.closest("button")) {
            debutY = null;
            return;
        }

        debutY = event.changedTouches[0].clientY;
    }, { passive: true });

    scene.addEventListener("touchend", function (event) {
        if (debutY === null) return;

        const finY = event.changedTouches[0].clientY;
        const difference = finY - debutY;
        debutY = null;

        if (Math.abs(difference) < 60) return;

        if (difference < 0) {
            changerVideo(1);
        } else {
            changerVideo(-1);
        }
    }, { passive: true });

    // Molette et pavé tactile du PC
    let dernierDefilement = 0;

    scene.addEventListener("wheel", function (event) {
        if (Math.abs(event.deltaY) < 20) return;

        const maintenant = Date.now();

        if (maintenant - dernierDefilement < 800) {
            return;
        }

        dernierDefilement = maintenant;

        changerVideo(event.deltaY > 0 ? 1 : -1);
    }, { passive: true });

    // Clavier du PC
    document.addEventListener("keydown", function (event) {
        if (event.key === "ArrowDown") changerVideo(1);
        if (event.key === "ArrowUp") changerVideo(-1);

        if (event.code === "Space") {
            event.preventDefault();

            if (video.paused) jouer();
            else video.pause();
        }
    });

    chargerCatalogue();
});
