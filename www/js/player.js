"use strict";

document.addEventListener("DOMContentLoaded", () => {
    const $ = id => document.getElementById(id);
    const { api, icon, element, emit, duration, number, initials } = SV;
    const scene = $("scene"), menu = $("menuPlus");
    const API_ORIGINE = SV.origin;
    let catalogue = [], catalogueComplet = [], indexActuel = 0, filtre = "all";
    let sonActif = false, defilementAutomatique = true, requeteCatalogue = 0;
    let minuterieFin, minuterieToast, minuterieConseil, rechercheTimer, attenteCatalogue, attenteLongueCatalogue;
    let catalogueEnCours = false, catalogueErreur = false, cordovaSuspendu = false;
    let videoPleinEcranId = null;
    try { defilementAutomatique = localStorage.getItem("defilementAutomatique") !== "false"; } catch {}
    $("defilementAuto").checked = defilementAutomatique;

    function message(texte, retry = false) {
        $("message").textContent = texte;
        $("message").hidden = !texte;
        $("reessayerFil").hidden = !retry;
    }
    function indicationReseau(state = "", texte = "") {
        $("chargement").dataset.state = state;
        $("chargement").textContent = texte;
        $("chargement").hidden = !texte;
    }
    function afficherToast(texte) {
        clearTimeout(minuterieToast);
        $("toast").textContent = texte;
        $("toast").hidden = false;
        minuterieToast = setTimeout(() => { $("toast").hidden = true; }, 3600);
    }
    function afficherConseilPleinEcran(texte) {
        clearTimeout(minuterieConseil);
        $("conseilPleinEcran").textContent = texte;
        $("conseilPleinEcran").hidden = false;
        minuterieConseil = setTimeout(() => { $("conseilPleinEcran").hidden = true; }, 3600);
    }
    const pleinEcran = new SVFullscreenPlayer({ scene, button: $("pleinEcran"), icon, toast: afficherConseilPleinEcran });
    document.addEventListener("stream:toast", event => afficherToast(event.detail));
    function tempsEcoule(value) {
        const timestamp = new Date(value).getTime();
        if (!Number.isFinite(timestamp)) return "";
        const s = Math.max(0, (Date.now() - timestamp) / 1000);
        if (s < 60) return "À l’instant";
        if (s < 3600) return "Il y a " + Math.floor(s / 60) + " min";
        if (s < 86400) return "Il y a " + Math.floor(s / 3600) + " h";
        if (s < 2592000) return "Il y a " + Math.floor(s / 86400) + " j";
        return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(timestamp);
    }
    function afficherDateAjout() {
        if (catalogue[indexActuel]) $("dateAjout").textContent = tempsEcoule(catalogue[indexActuel].date_ajout);
    }
    const titre = item => (item.titre || "Une nouvelle histoire").replace(/\.(mp4|webm|mov|mkv|m4v|3gpp?)$/i, "").replace(/_/g, " ");
    function fermerMenu() { menu.hidden = true; $("plus").setAttribute("aria-expanded", "false"); }
    $("plus").addEventListener("click", () => {
        menu.hidden = !menu.hidden;
        $("plus").setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("click", event => {
        if (!menu.hidden && !menu.contains(event.target) && !$("plus").contains(event.target)) {
            fermerMenu(); event.preventDefault(); event.stopPropagation();
        }
    }, true);
    function masquerFinFil() { clearTimeout(minuterieFin); $("finFil").hidden = true; }
    function afficherFinFil() {
        fermerMenu(); $("finFil").hidden = false;
        clearTimeout(minuterieFin); minuterieFin = setTimeout(masquerFinFil, 8000);
    }
    function afficherLecture(state = lecteur.state()) {
        const visible = state.hasVideo && (state.userPaused || state.blocked) && !state.suspended && !state.fatal;
        $("lecturePause").replaceChildren(icon(state.playing ? "pause" : "play"));
        $("lecturePause").setAttribute("aria-label", state.playing ? "Mettre en pause" : "Lire la vidéo");
        $("lecturePause").classList.toggle("visible", visible);
        $("lecturePause").disabled = !state.hasVideo;
        scene.classList.toggle("paused", !state.playing);
    }
    function basculerLecture() {
        if (!menu.hidden) { fermerMenu(); return; }
        lecteur.togglePlayback();
    }
    let clicPause;
    $("lecturePause").addEventListener("click", event => {
        clearTimeout(clicPause);
        if (event.detail < 2) clicPause = setTimeout(basculerLecture, 240);
    });
    $("lecturePause").addEventListener("dblclick", () => { clearTimeout(clicPause); emit("doubletap"); });
    function nomQualite(niveau, index) {
        const size = Math.min(Number(niveau.width), Number(niveau.height));
        return size > 0 ? size + "p" : "Qualité " + (index + 1);
    }
    function afficherQualite(instance, index) {
        $("qualiteActuelle").textContent = instance?.levels[index]
            ? (instance.autoLevelEnabled ? "Auto · " : "") + nomQualite(instance.levels[index], index) : "Auto";
    }
    function remplirQualites(instance) {
        const niveaux = instance?.levels || [];
        $("choixQualite").replaceChildren(new Option(niveaux.length === 1
            ? "Automatique · une qualité disponible" : "Automatique", "-1"));
        for (const [i, level] of (instance?.levels || []).entries()) $("choixQualite").add(new Option(nomQualite(level, i), String(i)));
        $("choixQualite").disabled = !instance;
        $("choixQualite").value = instance && !instance.autoLevelEnabled ? String(instance.currentLevel) : "-1";
    }
    $("choixQualite").addEventListener("change", event => lecteur.setQuality(Number(event.target.value)));

    function navigation() {
        $("videoPrecedente").disabled = !catalogue.length || indexActuel === 0;
        $("videoSuivante").disabled = !catalogue.length;
        $("numeroVideo").textContent = String(catalogue.length ? indexActuel + 1 : 0).padStart(2, "0");
        $("positionFil").textContent = catalogue.length ? (indexActuel + 1) + " / " + catalogue.length + " VIDÉOS" : "À DÉCOUVRIR";
        $("totalVideos").textContent = number(catalogueComplet.length) + " vidéos";
    }
    function recommandations() {
        const items = catalogueComplet.filter(item => item.id !== catalogue[indexActuel]?.id).slice(0, 3);
        const zone = $("recommandations");
        zone.replaceChildren();
        if (!items.length) zone.append(element("p", "muted", "De nouvelles découvertes arrivent bientôt."));
        for (const item of items) {
            const button = element("button", "recommendation");
            button.setAttribute("aria-label", "Regarder " + titre(item));
            const image = element("span", "recommendation-image");
            if (item.poster) {
                const img = element("img"); img.src = new URL(item.poster, API_ORIGINE).href;
                img.alt = ""; img.loading = "lazy"; img.addEventListener("error", () => img.remove(), { once: true });
                image.append(img);
            }
            image.append(icon("play"), element("span", "thumb-duration", duration(item.duree)));
            const body = element("span", "recommendation-body");
            const count = element("span", "recommendation-stats"); count.append(icon("heart"), document.createTextNode(number(item.likes) + " j’aime"));
            body.append(element("strong", "", titre(item)), element("small", "", item.author || "La communauté"), count);
            button.append(image, body, icon("arrow"));
            button.addEventListener("click", () => { filtre = "all"; $("recherche").value = ""; appliquerFil(item.id); });
            zone.append(button);
        }
    }
    function metadonnees(item) {
        $("titreVideo").textContent = titre(item);
        $("auteurVideo").textContent = item.author || "La communauté";
        $("avatarAuteur").textContent = initials(item.author || "Streaming Video");
        $("audioAuteur").textContent = item.audio_title ? "· " + item.audio_title : "· " + (item.author || "StreamingVideo");
        $("audioLabel").firstChild.textContent = item.audio_title ? "Son choisi " : "Son original ";
        $("descriptionVideo").textContent = item.description || "";
        $("dureeVideo").textContent = duration(item.duree);
        afficherDateAjout();
    }

    // Chaque carte garde son propre aperçu pendant le glissement. Les véritables
    // commandes (avec leurs IDs et événements) sont déplacées dans la carte active.
    function apercuPublication(item, card) {
        if (!card) return;
        card.querySelector(".publication-preview")?.remove();
        const preview = element("div", "publication-preview");
        preview.dataset.videoId = item.id;
        preview.setAttribute("aria-hidden", "true");
        preview.append(element("div", "degrade"));
        const header = element("div", "en-tete");
        const quality = element("span", "quality-badge");
        quality.append(element("i", "live-dot"), document.createTextNode("Auto"));
        const tools = element("div", "player-tools");
        if (item.media_type === "photo") tools.append(element("span", "photo-counter", "1/" + (Number(item.photo_count) || 1)));
        for (const name of [sonActif ? "volume" : "muted", "more"]) {
            const tool = element("span", "round-button"); tool.append(icon(name)); tools.append(tool);
        }
        header.append(quality, tools);
        const actions = element("aside", "actions-laterales");
        actions.append(element("span", "avatar author-avatar", initials(item.author || "Streaming Video")));
        const labels = [
            ["heart", number(item.likes), item.liked ? "aime" : ""],
            ["comment", number(item.comments), ""],
            ["bookmark", "Favoris", item.saved ? "saved" : ""],
            ["share", number(item.shares), ""]
        ];
        for (const [name, label, state] of labels) {
            const action = element("span", "action " + state);
            const image = element("span", "action-icon"); image.append(icon(name));
            action.append(image, element("small", "", label)); actions.append(action);
        }
        const info = element("div", "informations");
        const author = element("div", "author-line");
        author.append(element("span", "", item.author || "La communauté"), element("span", "creator-label", "CRÉATEUR"));
        const meta = element("div", "video-meta");
        meta.append(element("span", "", tempsEcoule(item.date_ajout)), element("span", "meta-dot", "·"), element("span", "", duration(item.duree)));
        const audio = element("div", "audio-line");
        const bars = element("span", "sound-bars");
        for (let i = 0; i < 4; i++) bars.append(element("i"));
        audio.append(bars, element("span", "", item.audio_title ? "Son choisi · " + item.audio_title : "Son original · " + (item.author || "StreamingVideo")));
        info.append(author, element("strong", "", titre(item)), element("p", "", item.description || ""), meta, audio);
        const playback = element("div", "playback-meta");
        const hint = element("span", "swipe-hint"); hint.append(icon("up"), document.createTextNode("Glisse pour découvrir"));
        playback.append(hint, element("span", "", "0:00 / " + duration(item.duree)));
        preview.append(header, actions, info, playback, element("div", "progression"));
        card.append(preview);
    }

    const lecteur = new SV.VideoFeed($("filVideos"), {
        onCard: apercuPublication,
        onSelect(item, index) {
            indexActuel = index;
            if (videoPleinEcranId && videoPleinEcranId !== item.id) pleinEcran.close();
            videoPleinEcranId = item.id;
            pleinEcran.setDuration(item.duree);
            masquerFinFil(); fermerMenu(); message(""); indicationReseau();
            scene.classList.add("has-video");
            metadonnees(item); navigation(); recommandations();
            $("progressionLecture").style.width = "0%";
            $("positionLecture").value = "0";
            $("tempsLecture").textContent = "0:00 / " + duration(item.duree);
            const photo = item.media_type === "photo" && Number(item.photo_count) > 0;
            $("compteurPhotos").hidden = !photo;
            $("photoPrecedente").hidden = !photo;
            $("photoSuivante").hidden = !photo;
            if (photo) $("compteurPhotos").textContent = "1/" + item.photo_count;
            $("qualiteActuelle").textContent = "Auto";
            emit("video", item);
            if (/^https?:$/.test(location.protocol)) {
                const url = new URL(location.href); url.searchParams.set("video", item.id); history.replaceState(null, "", url);
            }
        },
        onLevels: remplirQualites,
        onLevel: afficherQualite,
        onState: afficherLecture,
        onStatus: indicationReseau,
        onError(text) { message(text, true); },
        onTap: basculerLecture,
        onDoubleTap() { emit("doubletap"); },
        onProgress(current, total) {
            const item = catalogue[indexActuel];
            if (item?.media_type === "photo" && Number(item.photo_count) > 0) {
                const interval = Number(item.photo_interval_seconds) || 3;
                const slide = Math.min(Number(item.photo_count), Math.floor(current / interval) + 1);
                $("compteurPhotos").textContent = slide + "/" + item.photo_count;
            }
            if (!Number.isFinite(total) || total <= 0) return;
            pleinEcran.setDuration(total);
            const fraction = current / total;
            $("progressionLecture").style.width = fraction * 100 + "%";
            $("positionLecture").value = String(Math.round(fraction * 1000));
            $("tempsLecture").textContent = duration(current) + " / " + duration(total);
        },
        onEnd() {
            if (defilementAutomatique && indexActuel < catalogue.length - 1) chargerVideo(indexActuel + 1);
            else lecteur.restart();
        }
    });

    // Le même lecteur et sa barre de progression servent aux gestes latéraux.
    new SVSeekGestures({ scene, feed: lecteur });
    $("photoPrecedente").addEventListener("click", () => lecteur.navigatePhoto(-1));
    $("photoSuivante").addEventListener("click", () => lecteur.navigatePhoto(1));

    function chargerVideo(index, behavior = "smooth") {
        if (index < 0 || index >= catalogue.length) return;
        lecteur.select(index, { behavior });
    }
    function appliquerFil(id, garderLecture = false) {
        const ancienId = catalogue[indexActuel]?.id;
        const query = $("recherche").value.trim().toLocaleLowerCase("fr");
        catalogue = catalogueComplet.filter(item =>
            (filtre !== "saved" || item.saved) && (filtre !== "liked" || item.liked) &&
            (!query || [item.titre, item.description, item.author].join(" ").toLocaleLowerCase("fr").includes(query))
        );
        if (filtre === "trending") catalogue.sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments) || new Date(b.date_ajout) - new Date(a.date_ajout));
        document.querySelectorAll("[data-feed]").forEach(button => {
            const active = button.dataset.feed === filtre;
            button.classList.toggle("active", active);
            if (button.classList.contains("feed-tab")) button.setAttribute("aria-pressed", String(active));
            else if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
        });
        document.title = "StreamingVideo · " + ({ all: "Pour toi", trending: "Explorer", liked: "Vidéos aimées", saved: "Mes favoris" }[filtre]);
        if (!catalogue.length) {
            videoPleinEcranId = null;
            pleinEcran.close();
            pleinEcran.setDuration(0);
            lecteur.clear(); scene.classList.remove("has-video");
            indicationReseau(); masquerFinFil(); emit("video", null);
            $("titreVideo").textContent = query ? "Une autre envie ?" : "Les histoires t’attendent.";
            $("descriptionVideo").textContent = ""; $("auteurVideo").textContent = "StreamingVideo";
            $("dateAjout").textContent = ""; $("dureeVideo").textContent = ""; $("tempsLecture").textContent = "0:00 / 0:00";
            $("progressionLecture").style.width = "0%"; $("positionLecture").value = "0";
            message(query ? "Aucune vidéo ne correspond à ta recherche." : filtre === "saved"
                ? "Tes favoris t’attendent ici. Touche le marque-page d’une vidéo pour la retrouver."
                : filtre === "liked" ? "Tes coups de cœur s’afficheront ici. Aime une vidéo pour commencer."
                : "Le fil est prêt pour ta première vidéo. Touche + pour publier.");
            navigation(); recommandations(); afficherLecture(); return;
        }
        const found = catalogue.findIndex(item => item.id === (id || (garderLecture ? ancienId : null)));
        const index = found >= 0 ? found : 0;
        indexActuel = index;
        const sameOrder = lecteur.items.length === catalogue.length && catalogue.every((item, i) => lecteur.items[i]?.id === item.id);
        if (garderLecture && sameOrder && lecteur.active?.item?.id === catalogue[index].id) {
            navigation(); recommandations(); metadonnees(catalogue[index]);
            return;
        }
        lecteur.setItems(catalogue, catalogue[index].id);
        lecteur.select(index, { behavior: "instant" });
        navigation(); recommandations(); metadonnees(catalogue[index]);
    }
    async function chargerCatalogue(conserver = false) {
        const request = ++requeteCatalogue;
        const id = conserver ? catalogue[indexActuel]?.id : new URLSearchParams(location.search).get("video");
        catalogueEnCours = true; catalogueErreur = false; message("");
        clearTimeout(attenteCatalogue); clearTimeout(attenteLongueCatalogue);
        if (!lecteur.video) {
            indicationReseau();
            attenteCatalogue = setTimeout(() => {
                if (request === requeteCatalogue && catalogueEnCours) indicationReseau(
                    navigator.onLine === false ? "offline" : "unstable",
                    navigator.onLine === false ? "Connexion interrompue. Chargement…" : "Connexion instable"
                );
            }, 2500);
            attenteLongueCatalogue = setTimeout(() => {
                if (request === requeteCatalogue && catalogueEnCours) indicationReseau("loading", "Chargement… Connexion instable");
            }, 10000);
        }
        try {
            const items = await api("/videos");
            if (request !== requeteCatalogue) return;
            if (!Array.isArray(items)) throw new Error("Le catalogue reçu est invalide.");
            catalogueComplet = items.filter(item => item && item.statut === "prete" && item.url_hls)
                .sort((a, b) => new Date(b.date_ajout) - new Date(a.date_ajout));
            indicationReseau(); appliquerFil(id, conserver);
        } catch (error) {
            if (request !== requeteCatalogue) return;
            catalogueErreur = true;
            if (navigator.onLine === false) {
                indicationReseau("offline", "Connexion interrompue. Chargement…");
                message("La connexion est interrompue. Le fil reprendra quand elle reviendra.", true);
            } else message(error.message, true);
        } finally {
            if (request === requeteCatalogue) {
                catalogueEnCours = false; clearTimeout(attenteCatalogue); clearTimeout(attenteLongueCatalogue);
            }
        }
    }
    function changerVideo(offset) {
        if (!catalogue.length || document.querySelector("dialog[open]")) return;
        if (indexActuel + offset >= catalogue.length) afficherFinFil();
        else chargerVideo(indexActuel + offset);
    }
    document.addEventListener("stream:social", event => {
        const stats = event.detail, item = catalogueComplet.find(item => item.id === stats.id);
        if (!item) return;
        Object.assign(item, stats); appliquerFil(catalogue[indexActuel]?.id, true);
        apercuPublication(item, lecteur.cards.get(item.id));
    });
    document.addEventListener("stream:profile", event => {
        for (const item of catalogueComplet) if (item.authorId === event.detail.id) {
            item.author = event.detail.pseudo;
            apercuPublication(item, lecteur.cards.get(item.id));
        }
        if (catalogue[indexActuel]) metadonnees(catalogue[indexActuel]);
        recommandations();
    });
    document.querySelectorAll("[data-feed]").forEach(button => button.addEventListener("click", () => {
        filtre = button.dataset.feed; $("recherche").value = ""; appliquerFil();
    }));
    $("recherche").addEventListener("input", () => { clearTimeout(rechercheTimer); rechercheTimer = setTimeout(() => appliquerFil(), 240); });
    $("rechercheForm").addEventListener("submit", event => { event.preventDefault(); clearTimeout(rechercheTimer); appliquerFil(); $("recherche").blur(); });
    $("videoPrecedente").addEventListener("click", () => changerVideo(-1));
    $("videoSuivante").addEventListener("click", () => changerVideo(1));
    $("fermerFin").addEventListener("click", masquerFinFil);
    $("reessayerFil").addEventListener("click", () => {
        message(""); indicationReseau();
        if (lecteur.video && !catalogueErreur) lecteur.retry();
        else chargerCatalogue(true);
    });
    $("actualiserFil").addEventListener("click", async () => {
        $("actualiserFil").disabled = true;
        try { await chargerCatalogue(true); } finally { $("actualiserFil").disabled = false; }
    });
    function ouvrirAjout() {
        pleinEcran.close();
        if (window.SVStudio) window.SVStudio.open();
        else location.href = "upload.html";
    }
    $("ajouterVideo").addEventListener("click", ouvrirAjout);
    $("publierFin").addEventListener("click", ouvrirAjout);
    document.querySelectorAll("[data-publish]").forEach(button => button.addEventListener("click", ouvrirAjout));
    document.addEventListener("sv:show-video", event => {
        const id = event.detail?.id;
        if (!id) return;
        filtre = "all";
        $("recherche").value = "";
        // Une publication peut venir d'être ajoutée au catalogue pendant la copie.
        api("/videos").then(items => {
            if (!Array.isArray(items)) return;
            catalogueComplet = items.filter(item => item && item.statut === "prete" && item.url_hls)
                .sort((a, b) => new Date(b.date_ajout) - new Date(a.date_ajout));
            appliquerFil(id);
        }).catch(error => message(error.message, true));
    });
    document.addEventListener("sv:go-home", () => {
        filtre = "all";
        $("recherche").value = "";
        appliquerFil();
    });
    $("defilementAuto").addEventListener("change", event => {
        defilementAutomatique = event.target.checked;
        try { localStorage.setItem("defilementAutomatique", String(defilementAutomatique)); } catch {}
        afficherToast(defilementAutomatique ? "Défilement automatique activé" : "La vidéo sera lue en boucle");
    });
    $("son").addEventListener("click", () => {
        sonActif = !sonActif; lecteur.setSound(sonActif);
        $("son").replaceChildren(icon(sonActif ? "volume" : "muted"));
        $("son").setAttribute("aria-label", sonActif ? "Couper le son" : "Activer le son");
        $("son").setAttribute("aria-pressed", String(sonActif));
    });
    $("informationsVideo").addEventListener("click", () => {
        fermerMenu(); const item = catalogue[indexActuel];
        if (item) afficherToast(duration(item.duree) + " · " + tempsEcoule(item.date_ajout));
    });
    function afficherHistorique() {
        const entries = lecteur.historyItems();
        const list = $("historiqueListe");
        list.replaceChildren();
        $("effacerHistorique").disabled = entries.length === 0;
        if (!entries.length) {
            list.append(element("p", "historique-vide", "Les vidéos regardées pendant cette session apparaîtront ici."));
            return;
        }
        for (const entry of entries) {
            const item = catalogueComplet.find(video => video.id === entry.item?.id);
            const row = element("button", "historique-item");
            row.type = "button";
            row.disabled = !item;
            const text = element("span", "historique-texte");
            text.append(element("strong", "", String(item?.titre || entry.item?.titre || "Vidéo")));
            const progress = entry.finished ? "Vidéo terminée · revoir" : "Reprendre à " + duration(entry.position) +
                (entry.duration > 0 ? " / " + duration(entry.duration) : "");
            text.append(element("small", "", item ? progress : "Vidéo indisponible"));
            row.append(text, icon("play"));
            if (item) row.addEventListener("click", () => {
                $("historiqueDialog").close();
                filtre = "all";
                $("recherche").value = "";
                appliquerFil(item.id);
            });
            list.append(row);
        }
    }
    $("ouvrirHistorique").addEventListener("click", () => {
        fermerMenu();
        lecteur.remember(lecteur.active, true);
        afficherHistorique();
        const dialog = $("historiqueDialog");
        if (dialog.open) return;
        const alreadyOpen = !!document.querySelector("dialog[open]");
        dialog.showModal();
        if (!alreadyOpen) emit("modal", true);
    });
    $("effacerHistorique").addEventListener("click", () => {
        lecteur.clearHistory();
        afficherHistorique();
    });
    $("positionLecture").addEventListener("input", event => lecteur.seek(Number(event.target.value) / 1000));
    function actualiserSuspension() {
        lecteur.setSuspended(document.hidden || cordovaSuspendu || document.body.classList.contains("studio-ouvert") || !!document.querySelector("dialog[open]"));
    }
    document.addEventListener("stream:modal", actualiserSuspension);
    document.addEventListener("visibilitychange", actualiserSuspension);
    document.addEventListener("pause", () => { cordovaSuspendu = true; actualiserSuspension(); });
    document.addEventListener("resume", () => { cordovaSuspendu = false; actualiserSuspension(); });
    window.addEventListener("online", () => { if (catalogueErreur && !catalogueEnCours) chargerCatalogue(true); });
    window.addEventListener("offline", () => {
        if (catalogueEnCours || catalogueErreur) indicationReseau("offline", "Connexion interrompue. Chargement…");
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape") { if (pleinEcran.active) pleinEcran.close(); fermerMenu(); return; }
        if (event.target instanceof Element && event.target.closest("button,a,input,select,textarea,dialog")) return;
        if (document.querySelector("dialog[open]")) return;
        if (event.key === "/") { event.preventDefault(); $("recherche").focus(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); changerVideo(event.key === "ArrowDown" ? 1 : -1); }
        if (event.code === "Space") { event.preventDefault(); basculerLecture(); }
    });
    window.addEventListener("pagehide", event => { if (event.persisted) lecteur.setSuspended(true); else lecteur.destroy(); });
    window.addEventListener("pageshow", event => { if (event.persisted) actualiserSuspension(); });
    setInterval(afficherDateAjout, 60000);
    afficherLecture();
    chargerCatalogue();
});
