
"use strict";

// StreamingVideo - Lecteur HLS et fil des publications

document.addEventListener("DOMContentLoaded", () => {

    const $ = (id) => document.getElementById(id);

    const video = $("lecteur");
    const scene = $("scene");

    const API_BASE = String(
        window.APP_CONFIG?.API_BASE_URL || ""
    ).replace(/\/+$/, "");

    const API_ORIGINE = API_BASE
        ? new URL(API_BASE).origin
        : location.origin;

    let catalogue = [];
    let indexActuel = 0;
    let hls = null;
    let sonActif = false;
    let aime = false;
    let numeroChargement = 0;

    let minuterieChargement = null;
    let minuterieFin = null;
    let minuterieToast = null;

    let debutY = null;
    let dernierDefilement = 0;
    let defilementAutomatique = true;

    // =====================================
    // 1. DÉFILEMENT AUTOMATIQUE
    // =====================================

    try {
        defilementAutomatique =
            localStorage.getItem(
                "defilementAutomatique"
            ) !== "false";

    } catch (erreur) {
        console.warn(
            "Préférence locale indisponible",
            erreur
        );
    }

    $("defilementAuto").checked =
        defilementAutomatique;

    // =====================================
    // 2. MESSAGES
    // =====================================

    function message(texte) {

        $("message").textContent = texte;
        $("message").hidden = !texte;
    }

    function chargement(texte) {

        clearTimeout(minuterieChargement);

        const zone = $("chargement");

        if (!texte) {
            zone.hidden = true;
            return;
        }

        const attenteVideo =
            texte === "Chargement de la vidéo..." ||
            texte === "Chargement...";

        if (!attenteVideo) {
            zone.textContent = texte;
            zone.hidden = false;
            return;
        }

        // Ne pas afficher de message immédiatement
        zone.hidden = true;

        const jeton = numeroChargement;

        minuterieChargement = setTimeout(() => {

            if (
                jeton === numeroChargement &&
                !video.error &&
                video.readyState <
                    HTMLMediaElement.HAVE_FUTURE_DATA
            ) {

                zone.textContent =
                    "Connexion en cours...";

                zone.hidden = false;
            }

        }, 1500);
    }

    function afficherToast(texte) {

        clearTimeout(minuterieToast);

        $("toast").textContent = texte;
        $("toast").hidden = false;

        minuterieToast = setTimeout(() => {
            $("toast").hidden = true;
        }, 3200);
    }

    // =====================================
    // 3. DATE DE PUBLICATION
    // =====================================

    function tempsEcoule(dateAjout) {

        const date = new Date(dateAjout).getTime();

        if (!Number.isFinite(date)) {
            return "Date indisponible";
        }

        const secondes = Math.max(
            0,
            Math.floor((Date.now() - date) / 1000)
        );

        if (secondes < 60) {
            return "À l'instant";
        }

        if (secondes < 3600) {
            return "Il y a " +
                Math.floor(secondes / 60) + "mn";
        }

        if (secondes < 86400) {
            return "Il y a " +
                Math.floor(secondes / 3600) + "h";
        }

        if (secondes < 2592000) {
            return "Il y a " +
                Math.floor(secondes / 86400) + "j";
        }

        if (secondes < 31536000) {
            return "Il y a " +
                Math.floor(secondes / 2592000) +
                "mois";
        }

        const annees = Math.floor(
            secondes / 31536000
        );

        return "Il y a " + annees +
            " an" + (annees > 1 ? "s" : "");
    }

    function afficherDateAjout() {

        const item = catalogue[indexActuel];

        if (item) {
            $("dateAjout").textContent =
                tempsEcoule(item.date_ajout);
        }
    }

    // =====================================
    // 4. PUBLICATIONS LES PLUS RÉCENTES
    // =====================================

    function trierRecents(videos) {

        return videos
            .filter(item =>
                item &&
                item.statut === "prete" &&
                item.url_hls
            )
            .sort((a, b) =>
                new Date(b.date_ajout) -
                new Date(a.date_ajout)
            );
    }

    function urlVideo(item) {

        // Utiliser l'adresse du backend
        // même lorsque le lecteur est dans Cordova
        return new URL(
            item.url_hls,
            API_ORIGINE
        ).href;
    }

    // =====================================
    // 5. MENU ET PANNEAU DE FIN
    // =====================================

    function fermerMenu() {

        $("menuPlus").hidden = true;

        $("plus").setAttribute(
            "aria-expanded",
            "false"
        );
    }

    function afficherFinFil() {

        fermerMenu();

        clearTimeout(minuterieFin);

        $("finFil").hidden = false;

        // Le panneau disparaît après 8 secondes
        minuterieFin = setTimeout(() => {
            $("finFil").hidden = true;
        }, 8000);

        // La vidéo continue de jouer
    }

    function masquerFinFil() {

        clearTimeout(minuterieFin);

        $("finFil").hidden = true;
    }

    // =====================================
    // 6. LECTURE ET PAUSE
    // =====================================

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

            console.info(
                "Lecture manuelle nécessaire :",
                erreur.message
            );

            afficherLecture();
        }
    }

    // =====================================
    // 7. QUALITÉS HLS
    // =====================================

    function nomQualite(niveau, index) {

        const largeur = Number(niveau.width);
        const hauteur = Number(niveau.height);

        const resolution = Math.min(
            largeur,
            hauteur
        );

        return (
            Number.isFinite(resolution) &&
            resolution > 0
        )
            ? resolution + "p"
            : "Qualité " + (index + 1);
    }

    function remplirQualites(instance) {

        const select = $("choixQualite");

        select.replaceChildren(
            new Option("Automatique", "-1")
        );

        instance.levels.forEach(
            (niveau, index) => {

                select.add(
                    new Option(
                        nomQualite(niveau, index),
                        String(index)
                    )
                );
            }
        );

        select.value = "-1";
    }

    function afficherQualite(instance, index) {

        const niveau = instance.levels[index];

        if (!niveau) {
            $("qualiteActuelle").textContent =
                "Auto";
            return;
        }

        const nom = nomQualite(niveau, index);

        $("qualiteActuelle").textContent =
            (instance.autoLevelEnabled
                ? "Auto · "
                : "") + nom;
    }

    // =====================================
    // 8. LIBÉRER L'ANCIEN LECTEUR
    // =====================================

    function detruireAncienLecteur() {

        if (hls) {
            hls.destroy();
            hls = null;
        }

        video.pause();

        video.removeAttribute("src");

        video.load();
    }

    // =====================================
    // 9. CHARGER UNE VIDÉO
    // =====================================

    function chargerVideo(index) {

        if (
            index < 0 ||
            index >= catalogue.length
        ) {
            return;
        }

        masquerFinFil();
        fermerMenu();

        const jeton = ++numeroChargement;

        indexActuel = index;

        detruireAncienLecteur();

        const item = catalogue[indexActuel];

        $("titreVideo").textContent =
            item.titre || "Vidéo";

        afficherDateAjout();

        $("progressionLecture").style.width =
            "0%";

        $("qualiteActuelle").textContent =
            "Auto";

        $("choixQualite").replaceChildren(
            new Option("Automatique", "-1")
        );

        aime = false;

        $("aimer").classList.remove("aime");

        $("aimer").querySelector(
            ".symbole"
        ).textContent = "♡";

        video.muted = !sonActif;

        video.loop = false;

        message("");

        chargement(
            "Chargement de la vidéo..."
        );

        afficherLecture();

        let source;

        try {
            source = urlVideo(item);

        } catch (erreur) {
            chargement("");
            message("Adresse de la vidéo invalide.");
            return;
        }

        // ===== LECTURE AVEC HLS.JS =====

        if (window.Hls && Hls.isSupported()) {

            const instance = new Hls({

                enableWorker: true,

                // Commencer à une qualité légère
                startLevel: 0,

                capLevelToPlayerSize: true,

                maxBufferLength: 10,

                maxMaxBufferLength: 20
            });

            hls = instance;

            let erreursReseau = 0;
            let erreursMedia = 0;

            instance.on(
                Hls.Events.MEDIA_ATTACHED,
                () => {

                    if (
                        jeton === numeroChargement
                    ) {
                        instance.loadSource(source);
                    }
                }
            );

            instance.on(
                Hls.Events.MANIFEST_PARSED,
                () => {

                    if (
                        jeton !== numeroChargement
                    ) {
                        return;
                    }

                    remplirQualites(instance);

                    jouer();
                }
            );

            // Changement automatique de qualité
            instance.on(
                Hls.Events.LEVEL_SWITCHED,
                (event, data) => {

                    if (
                        jeton !== numeroChargement
                    ) {
                        return;
                    }

                    afficherQualite(
                        instance,
                        data.level
                    );
                }
            );

            // Gestion des erreurs HLS
            instance.on(
                Hls.Events.ERROR,
                (event, erreur) => {

                    if (
                        jeton !== numeroChargement
                    ) {
                        return;
                    }

                    console.warn(
                        "Erreur HLS :",
                        erreur.details,
                        "Fatale :",
                        erreur.fatal
                    );

                    if (!erreur.fatal) {
                        return;
                    }

                    // Réessayer une erreur réseau
                    if (
                        erreur.type ===
                            Hls.ErrorTypes.NETWORK_ERROR &&
                        erreursReseau++ < 2
                    ) {
                        instance.startLoad();
                        return;
                    }

                    // Tenter de récupérer une erreur média
                    if (
                        erreur.type ===
                            Hls.ErrorTypes.MEDIA_ERROR &&
                        erreursMedia++ < 1
                    ) {
                        instance.recoverMediaError();
                        return;
                    }

                    chargement("");

                    message(
                        "Impossible de lire cette vidéo : " +
                        erreur.details
                    );
                }
            );

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
                function () {

                    if (
                        jeton === numeroChargement
                    ) {
                        jouer();
                    }

                },
                { once: true }
            );

        } else {

            chargement("");

            message(
                "Ce téléphone ne prend pas en charge HLS."
            );
        }

        // Précharger la playlist suivante
        // sans revenir à la première
        const suivante =
            catalogue[indexActuel + 1];

        if (suivante) {

            fetch(
                urlVideo(suivante),
                { cache: "force-cache" }
            ).catch(() => {});
        }
    }

    // =====================================
    // 10. CHANGER DE VIDÉO
    // =====================================

    function changerVideo(deplacement) {

        if (!catalogue.length) return;

        const suivant =
            indexActuel + deplacement;

        // L'utilisateur dépasse la dernière vidéo
        if (suivant >= catalogue.length) {

            afficherFinFil();

            return;
        }

        // Avant la première vidéo
        if (suivant < 0) return;

        chargerVideo(suivant);
    }

    // =====================================
    // 11. CHARGER LE CATALOGUE
    // =====================================

    async function chargerCatalogue() {

        chargement("Chargement des vidéos...");

        message("");

        if (!API_BASE) {

            chargement("");

            message(
                "Adresse API absente. Vérifie js/config.js."
            );

            return;
        }

        try {

            const reponse = await fetch(
                API_BASE + "/videos",
                { cache: "no-store" }
            );

            if (!reponse.ok) {
                throw new Error(
                    "HTTP " + reponse.status
                );
            }

            const donnees =
                await reponse.json();

            if (!Array.isArray(donnees)) {
                throw new Error(
                    "Catalogue invalide"
                );
            }

            catalogue = trierRecents(donnees);

            chargement("");

            if (!catalogue.length) {

                message(
                    "Aucune vidéo. Appuie sur + pour publier."
                );

                return;
            }

            // Lecture d'une vidéo partagée
            const idDemande =
                new URLSearchParams(
                    location.search
                ).get("video");

            const position =
                catalogue.findIndex(
                    item => item.id === idDemande
                );

            chargerVideo(
                position < 0 ? 0 : position
            );

        } catch (erreur) {

            console.error(
                "Erreur catalogue :",
                erreur
            );

            chargement("");

            message(
                "Connexion au serveur impossible : " +
                erreur.message
            );
        }
    }

    // =====================================
    // 12. ACTUALISER LE FIL
    // =====================================

    async function actualiserFil() {

        const bouton = $("actualiserFil");

        bouton.disabled = true;

        bouton.textContent =
            "Actualisation...";

        try {

            const reponse = await fetch(
                API_BASE + "/videos",
                { cache: "no-store" }
            );

            if (!reponse.ok) {
                throw new Error(
                    "HTTP " + reponse.status
                );
            }

            const donnees =
                await reponse.json();

            if (!Array.isArray(donnees)) {
                throw new Error(
                    "Catalogue invalide"
                );
            }

            catalogue = trierRecents(
                donnees
            );

            masquerFinFil();

            if (!catalogue.length) {

                detruireAncienLecteur();

                message(
                    "Aucune vidéo disponible pour le moment."
                );

                return;
            }

            // Retour au début du fil :
            // la publication la plus récente
            chargerVideo(0);

            afficherToast(
                "actualisé"
            );

        } catch (erreur) {

            console.error(
                "Actualisation :",
                erreur
            );

            afficherToast(
                "Actualisation impossible. Vérifie le Wi-Fi."
            );

        } finally {

            bouton.disabled = false;

            bouton.textContent =
                "↻ Actualiser";
        }
    }

    // =====================================
    // 13. FIN DE LECTURE
    // =====================================

    video.addEventListener(
        "ended",
        () => {

            const derniereVideo =
                indexActuel === catalogue.length - 1;

            if (
                defilementAutomatique &&
                !derniereVideo
            ) {

                chargerVideo(
                    indexActuel + 1
                );

            } else {

                // Dernière vidéo ou auto désactivé :
                // reprendre la même vidéo
                video.currentTime = 0;

                jouer();
            }
        }
    );

    // =====================================
    // 14. ÉVÉNEMENTS DU LECTEUR
    // =====================================

    video.addEventListener(
        "playing",
        () => {

            chargement("");

            afficherLecture();
        }
    );

    video.addEventListener(
        "pause",
        afficherLecture
    );

    video.addEventListener(
        "waiting",
        () => {

            if (!video.paused) {
                chargement("Chargement...");
            }
        }
    );

    video.addEventListener(
        "timeupdate",
        () => {

            if (
                Number.isFinite(video.duration) &&
                video.duration > 0
            ) {

                const pourcentage =
                    (video.currentTime /
                        video.duration) * 100;

                $("progressionLecture").style.width =
                    pourcentage + "%";
            }
        }
    );

    function basculerLecture() {

        if (video.paused) {
            jouer();
        } else {
            video.pause();
        }
    }

    video.addEventListener(
        "click",
        basculerLecture
    );

    $("lecturePause").addEventListener(
        "click",
        basculerLecture
    );

    // =====================================
    // 15. SON ET J'AIME
    // =====================================

    $("son").addEventListener(
        "click",
        () => {

            sonActif = !sonActif;

            video.muted = !sonActif;

            $("son").querySelector(
                ".symbole"
            ).textContent =
                sonActif ? "🔊" : "🔇";
        }
    );

    $("aimer").addEventListener(
        "click",
        () => {

            aime = !aime;

            $("aimer").classList.toggle(
                "aime",
                aime
            );

            $("aimer").querySelector(
                ".symbole"
            ).textContent =
                aime ? "♥" : "♡";
        }
    );

    // =====================================
    // 16. AJOUTER UNE VIDÉO
    // =====================================

    function ouvrirAjout() {

        location.href = window.cordova
            ? "upload.html"
            : "/upload.html";
    }

    $("ajouterVideo").addEventListener(
        "click",
        ouvrirAjout
    );

    $("publierFin").addEventListener(
        "click",
        ouvrirAjout
    );

    $("fermerFin").addEventListener(
        "click",
        masquerFinFil
    );

    $("actualiserFil").addEventListener(
        "click",
        actualiserFil
    );

    // =====================================
    // 17. INTERRUPTEUR AUTO
    // =====================================

    $("defilementAuto").addEventListener(
        "change",
        event => {

            defilementAutomatique =
                event.target.checked;

            try {

                localStorage.setItem(
                    "defilementAutomatique",
                    String(defilementAutomatique)
                );

            } catch (erreur) {

                console.warn(
                    "Impossible d'enregistrer le réglage :",
                    erreur
                );
            }

            afficherToast(
                defilementAutomatique
                    ? "Défilement automatique activé"
                    : "Défilement automatique désactivé"
            );
        }
    );

    // =====================================
    // 18. CHOIX DE LA QUALITÉ
    // =====================================

    $("choixQualite").addEventListener(
        "change",
        event => {

            if (!hls) return;

            const niveau = Number(
                event.target.value
            );

            hls.currentLevel = niveau;

            if (niveau < 0) {

                $("qualiteActuelle").textContent =
                    "Auto";

            } else {

                afficherQualite(
                    hls,
                    niveau
                );
            }
        }
    );

    // =====================================
    // 19. MENU DES TROIS POINTS
    // =====================================

    $("plus").addEventListener(
        "click",
        () => {

            const ouvrir =
                $("menuPlus").hidden;

            $("menuPlus").hidden =
                !ouvrir;

            $("plus").setAttribute(
                "aria-expanded",
                String(ouvrir)
            );
        }
    );

    // =====================================
    // 20. PARTAGE
    // =====================================

    function obtenirLienPartage() {

        const item =
            catalogue[indexActuel];

        if (!item) return null;

        const lien = new URL(
            "/app/",
            API_ORIGINE
        );

        lien.searchParams.set(
            "video",
            item.id
        );

        return lien.href;
    }

    async function copierLienVideo() {

        const lien =
            obtenirLienPartage();

        if (!lien) return;

        try {

            await navigator.clipboard.writeText(
                lien
            );

            afficherToast("Lien copié");

        } catch (erreur) {

            window.prompt(
                "Copie ce lien :",
                lien
            );
        }
    }

    $("copierLien").addEventListener(
        "click",
        async () => {

            fermerMenu();

            await copierLienVideo();
        }
    );

    $("partager").addEventListener(
        "click",
        async () => {

            const lien =
                obtenirLienPartage();

            const item =
                catalogue[indexActuel];

            if (!lien || !item) return;

            if (navigator.share) {

                try {

                    await navigator.share({
                        title: item.titre,
                        text:
                            "Regarde cette vidéo sur StreamingVideo",
                        url: lien
                    });

                } catch (erreur) {

                    if (
                        erreur.name !==
                        "AbortError"
                    ) {

                        afficherToast(
                            "Partage indisponible"
                        );
                    }
                }

            } else {

                await copierLienVideo();
            }
        }
    );

    // =====================================
    // 21. INFORMATIONS VIDÉO
    // =====================================

    $("informationsVideo").addEventListener(
        "click",
        () => {

            fermerMenu();

            const item =
                catalogue[indexActuel];

            if (!item) return;

            const duree =
                Number(item.duree);

            const dureeTexte =
                Number.isFinite(duree) &&
                duree > 0

                    ? Math.floor(duree / 60) +
                      "mn " +
                      Math.floor(duree % 60) + "s"

                    : "Durée inconnue";

            afficherToast(
                dureeTexte +
                " · " +
                tempsEcoule(item.date_ajout)
            );
        }
    );

    // =====================================
    // 22. GLISSEMENT SUR LE TÉLÉPHONE
    // =====================================

    function elementInteractif(element) {

        return element instanceof Element &&
            Boolean(element.closest(
                "button, a, input, select, .menu-plus, .fin-fil"
            ));
    }

    scene.addEventListener(
        "touchstart",
        event => {

            if (
                elementInteractif(
                    event.target
                )
            ) {

                debutY = null;
                return;
            }

            debutY =
                event.changedTouches[0].clientY;

        },
        { passive: true }
    );

    scene.addEventListener(
        "touchend",
        event => {

            if (debutY === null) {
                return;
            }

            const difference =
                event.changedTouches[0].clientY -
                debutY;

            debutY = null;

            if (Math.abs(difference) < 60) {
                return;
            }

            changerVideo(
                difference < 0 ? 1 : -1
            );

        },
        { passive: true }
    );

    // =====================================
    // 23. DÉFILEMENT SUR ORDINATEUR
    // =====================================

    scene.addEventListener(
        "wheel",
        event => {

            if (
                elementInteractif(
                    event.target
                )
            ) {
                return;
            }

            if (
                Math.abs(event.deltaY) < 20
            ) {
                return;
            }

            const maintenant =
                Date.now();

            if (
                maintenant -
                dernierDefilement < 800
            ) {
                return;
            }

            dernierDefilement =
                maintenant;

            changerVideo(
                event.deltaY > 0 ? 1 : -1
            );

        },
        { passive: true }
    );

    document.addEventListener(
        "keydown",
        event => {

            if (
                event.target instanceof Element &&
                event.target.closest(
                    "input, select, textarea"
                )
            ) {
                return;
            }

            if (
                event.key === "ArrowDown"
            ) {
                changerVideo(1);
            }

            if (
                event.key === "ArrowUp"
            ) {
                changerVideo(-1);
            }

            if (
                event.code === "Space"
            ) {

                event.preventDefault();

                basculerLecture();
            }
        }
    );

    // =====================================
    // 24. DÉMARRAGE DE L'APPLICATION
    // =====================================

    setInterval(
        afficherDateAjout,
        60000
    );

    chargerCatalogue();

});
