
"use strict";

// ==========================================
// STREAMINGVIDEO - CAMERA ET PUBLICATION
// Compatible PC et Cordova Android
// ==========================================

// Charger js/config.js avant upload.js
const $ = id => document.getElementById(id);


const API_URL = String(
    window.APP_CONFIG?.API_BASE_URL ||
    (
        location.port === "3001"
            ? location.origin + "/api"
            : ""
    )
).replace(/\/+$/, "");

const estCordova = () => Boolean(window.cordova);

const cameraNativeDisponible = () =>
    estCordova() && Boolean(window.CameraPreview);

// ==========================================
// VARIABLES
// ==========================================

let flux = null;
let enregistreur = null;
let fragments = [];
let fichierChoisi = null;
let fichiersChoisis = [];
let urlApercu = null;
let photoFiles = [];
let photoPreviewUrl = null;
let photoIndex = 0;
let photoAudioMode = "none";
let photoAudioFile = null;
let photoAudioPreviewUrl = null;
let photoSoundId = null;
let catalogueSons = [];
let minuterie = null;
let debut = 0;

let cameraFace = "environment";
// L'écran de suivi et les envois sont indépendants : un transfert peut avancer
// pendant que l'utilisateur prépare une nouvelle publication.
let vuePublications = false;
let fermetureCamera = Promise.resolve();
let apercuNatifActif = false;
let operationCamera = false;
let enregistrementNatif = false;

// ==========================================
// 1. MESSAGES
// ==========================================


let minuteurNotification = null;

function afficherEtat(texte, erreur = false) {

    const element = $("etat");

    element.textContent = texte;

    element.classList.toggle("erreur", erreur);

    // Afficher temporairement la notification
    element.classList.add("visible");

    clearTimeout(minuteurNotification);

    // Garder le message visible pendant
    // une publication en cours
    const messageFinal =
        erreur ||
        /publiée|terminée/i.test(texte);

    if (!vuePublications || messageFinal) {

        minuteurNotification = setTimeout(() => {
            element.classList.remove("visible");
        }, 3500);
    }
}


// ==========================================
// 2. CREER LE BOUTON RETOURNER EN BAS
// ==========================================

function installerBoutonRetourner() {

    const conteneur = $("commandesCamera");

    if (!conteneur || $("retournerBas")) return;

    const bouton = document.createElement("button");

    bouton.id = "retournerBas";
    bouton.type = "button";
    bouton.className = "tuile-retourner";

    bouton.setAttribute(
        "aria-label",
        "Retourner la caméra"
    );

    bouton.innerHTML = `
        <span aria-hidden="true">⇄</span>
        <small>Retourner</small>
    `;

    const espace = conteneur.querySelector(".espace");

    if (espace) {
        espace.replaceWith(bouton);
    } else {
        conteneur.appendChild(bouton);
    }

    bouton.addEventListener("click", retournerCamera);

    // Styles du bouton et de l'aperçu natif
    const style = document.createElement("style");

    style.textContent = `
        #commandesCamera {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
        }

        #commandesCamera #galerie,
        #commandesCamera #galeriePhotos,
        #commandesCamera #retournerBas {
            flex: 0 0 78px;
        }

        #commandesCamera #enregistrer {
            flex: 0 0 auto;
        }

        #retournerBas {
            min-height: 66px;
            border: 0;
            border-radius: 14px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 3px;
            background: #1d2941;
            color: white;
            cursor: pointer;
        }

        #retournerBas span {
            font-size: 27px;
            line-height: 1;
        }

        #retournerBas small {
            font-size: 12px;
        }

        #retournerBas:disabled {
            opacity: 0.5;
        }

        [hidden] {
            display: none !important;
        }

        /* Caméra native derrière les boutons HTML */
        html.sv-native,
        html.sv-native body,
        html.sv-native .studio,
        html.sv-native .cadre-video {
            background: transparent !important;
        }

        html.sv-native,
        html.sv-native body {
            overflow: hidden !important;
            overscroll-behavior: none;
        }

        html.sv-native .studio {
            overflow: visible !important;
        }

        html.sv-native .cadre-video::before,
        html.sv-native .cadre-video::after {
            display: none !important;
        }

        html.sv-native #camera,
        html.sv-native #indication {
            display: none !important;
        }

        html.sv-native .entete,
        html.sv-native .commandes,
        html.sv-native .consigne,
        html.sv-native .statut {
            position: relative;
            z-index: 2;
        }
    `;

    document.head.appendChild(style);
}

// ==========================================
// 3. MODE CAMERA NATIVE
// ==========================================

function activerModeNatif(actif) {
    document.documentElement.classList.toggle(
        "sv-native",
        actif
    );
    window.SVParentStudio?.cameraMode(actif);
}

// ==========================================
// 4. ARRETER LA CAMERA WEB
// ==========================================

function arreterCameraWeb() {

    if (flux) {
        flux.getTracks().forEach(piste => piste.stop());
    }

    flux = null;
    $("camera").srcObject = null;
}

// ==========================================
// 5. ARRETER LA CAMERA NATIVE
// ==========================================

function arreterCameraNative() {

    return new Promise(resolve => {

        if (!apercuNatifActif || !window.CameraPreview) {
            activerModeNatif(false);
            resolve();
            return;
        }

        apercuNatifActif = false;

        CameraPreview.stopCamera(
            () => {
                activerModeNatif(false);
                resolve();
            },
            erreur => {
                console.warn(
                    "Arrêt caméra native :",
                    erreur
                );

                activerModeNatif(false);
                resolve();
            }
        );
    });
}

// ==========================================
// 6. EFFACER LA PREVISUALISATION
// ==========================================

function effacerApercu() {

    $("apercu").pause();
    $("apercu").removeAttribute("src");
    $("apercu").load();

    if (urlApercu) {
        if (urlApercu.startsWith("blob:")) URL.revokeObjectURL(urlApercu);
    }

    urlApercu = null;
    fichierChoisi = null;
    fichiersChoisis = [];
    photoFiles = [];
    photoIndex = 0;
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = null;
    $("apercuPhotos").hidden = true;
    $("imageApercuPhoto").removeAttribute("src");
    $("optionsAudioPhoto").hidden = true;
    $("sourceAudioPhoto").value = "none";
    $("sonsCatalogue").hidden = true;
    $("sonsCatalogue").replaceChildren();
    $("nomAudioPhoto").textContent = "";
    $("apercuAudioPhoto").pause();
    $("apercuAudioPhoto").removeAttribute("src");
    $("apercuAudioPhoto").hidden = true;
    if (photoAudioPreviewUrl) URL.revokeObjectURL(photoAudioPreviewUrl);
    photoAudioPreviewUrl = null;
    photoAudioMode = "none";
    photoAudioFile = null;
    photoSoundId = null;

    $("fichier").value = "";
    $("fichierPhotos").value = "";
    $("fichierAudioPhoto").value = "";
    $("fichierVideoSon").value = "";

    if ($("captureNative")) {
        $("captureNative").value = "";
    }

    $("voirVideo").hidden = true;
    $("progression").hidden = true;
}

// ==========================================
// 7. AFFICHER LES COMMANDES CAMERA
// ==========================================

function affichageCamera() {

    $("camera").hidden = false;
    $("apercu").hidden = true;

    $("commandesCamera").hidden = false;
    $("commandesApercu").hidden = true;
    $("consigne").hidden = false;

    $("retourner").hidden = false;
    $("indication").hidden = false;
    $("minuteur").hidden = true;
    $("reessayer").hidden = true;

    $("enregistrer").disabled = false;
    $("enregistrer").classList.remove("encours");

    $("enregistrer").setAttribute(
        "aria-label",
        "Démarrer l'enregistrement"
    );

    $("galerie").disabled = false;
    $("retourner").disabled = false;

    if ($("retournerBas")) {
        $("retournerBas").disabled = false;
    }
}

// ==========================================
// 8. AUTORISATIONS ANDROID
// ==========================================

async function demanderPermissions() {

    const gestionnaire =
        window.cordova?.plugins?.permissions;

    if (!gestionnaire) return;

    const demander = permission => new Promise(resolve => {

        gestionnaire.requestPermission(
            permission,
            reponse => {
                resolve(Boolean(reponse.hasPermission));
            },
            () => resolve(false)
        );
    });

    const okCamera = await demander(gestionnaire.CAMERA);

    if (!okCamera) {
        throw new Error(
            "Autorise l'appareil photo pour StreamingVideo dans Android."
        );
    }

    // Le microphone reste facultatif pour l'aperçu
    await demander(gestionnaire.RECORD_AUDIO);
}

// ==========================================
// 9. DEMARRER LA CAMERA NATIVE
// ==========================================

async function demarrerCameraNative() {

    if (!window.CameraPreview) {
        throw new Error("Plugin CameraPreview absent.");
    }

    // Eviter un décalage dû au défilement
    window.scrollTo(0, 0);

    // Attendre la mise en page du cadre
    await new Promise(resolve => {
        requestAnimationFrame(resolve);
    });

    const rect = document
        .querySelector(".cadre-video")
        .getBoundingClientRect();

    activerModeNatif(true);

    $("camera").hidden = true;
    $("indication").hidden = true;

    const direction = cameraFace === "user"
        ? CameraPreview.CAMERA_DIRECTION.FRONT
        : CameraPreview.CAMERA_DIRECTION.BACK;

    try {

        await new Promise((resolve, reject) => {

            CameraPreview.startCamera({

                x: Math.round(rect.left),
                y: Math.round(rect.top),

                width: Math.round(rect.width),
                height: Math.round(rect.height),

                camera: direction,

                // Laisser les boutons HTML devant
                toBack: true,

                tapPhoto: false,
                previewDrag: false

            }, resolve, reject);
        });

        apercuNatifActif = true;

        afficherEtat(
            cameraFace === "user"
                ? "Caméra avant prête."
                : "Caméra arrière prête."
        );

    } catch (erreur) {

        activerModeNatif(false);
        throw erreur;
    }
}

// ==========================================
// 10. CAMERA DU NAVIGATEUR
// ==========================================

async function demarrerCameraWeb() {

    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Caméra Web indisponible.");
    }

    const contraintes = {
        facingMode: {
            ideal: cameraFace
        },
        width: {
            ideal: 720
        },
        height: {
            ideal: 1280
        }
    };

    try {

        flux = await navigator.mediaDevices.getUserMedia({
            video: contraintes,
            audio: true
        });

    } catch {

        flux = await navigator.mediaDevices.getUserMedia({
            video: contraintes,
            audio: false
        });
    }

    $("camera").srcObject = flux;

    $("camera").classList.toggle(
        "miroir",
        cameraFace === "user"
    );

    await $("camera").play();

    $("indication").hidden = true;

    afficherEtat(
        "Caméra prête. Appuie sur le bouton rouge."
    );
}

// ==========================================
// 11. OUVRIR LA CAMERA
// ==========================================

async function ouvrirCamera() {

    if (
        vuePublications ||
        operationCamera ||
        enregistrementNatif
    ) {
        return;
    }

    operationCamera = true;

    try {

        clearInterval(minuterie);

        arreterCameraWeb();
        await arreterCameraNative();

        effacerApercu();
        affichageCamera();

        afficherEtat("Ouverture de la caméra...");

        if (cameraNativeDisponible()) {

            try {

                await demanderPermissions();
                await demarrerCameraNative();

            } catch (erreur) {

                console.error(
                    "Caméra native :",
                    erreur
                );

                afficherEtat(
                    "Caméra native indisponible : " +
                    (erreur.message || erreur),
                    true
                );

                $("indication").textContent =
                    "Utilise la galerie ou la capture du téléphone.";

                $("camera").hidden = true;
            }

        } else {

            try {

                await demarrerCameraWeb();

            } catch (erreur) {

                console.error(
                    "Caméra Web :",
                    erreur
                );

                afficherEtat(
                    "Caméra intégrée indisponible. " +
                    "Utilise la galerie ou le bouton rouge.",
                    true
                );

                $("indication").textContent =
                    "Caméra indisponible";

                $("camera").hidden = true;
                $("reessayer").hidden = false;
            }
        }

    } finally {
        operationCamera = false;
        // L'utilisateur peut avoir ouvert le suivi pendant l'autorisation caméra.
        if (vuePublications || fichierChoisi) {
            arreterCameraWeb();
            await arreterCameraNative();
        }
    }
}

// ==========================================
// 12. RETOURNER LA CAMERA
// ==========================================

async function retournerCamera() {

    if (
        operationCamera ||
        vuePublications ||
        enregistrementNatif ||
        enregistreur?.state === "recording"
    ) {

        afficherEtat(
            "Arrête l'enregistrement avant de retourner la caméra."
        );

        return;
    }

    // Android : changer sans recréer la caméra
    if (apercuNatifActif && window.CameraPreview) {

        operationCamera = true;

        $("retourner").disabled = true;

        if ($("retournerBas")) {
            $("retournerBas").disabled = true;
        }

        try {

            await new Promise((resolve, reject) => {
                CameraPreview.switchCamera(resolve, reject);
            });

            cameraFace = cameraFace === "user"
                ? "environment"
                : "user";

            afficherEtat(
                cameraFace === "user"
                    ? "Caméra avant activée."
                    : "Caméra arrière activée."
            );

        } catch (erreur) {

            afficherEtat(
                "Impossible de retourner la caméra : " +
                (erreur.message || erreur),
                true
            );

        } finally {

            operationCamera = false;
            $("retourner").disabled = false;

            if ($("retournerBas")) {
                $("retournerBas").disabled = false;
            }
        }

        return;
    }

    // Navigateur : réouvrir avec l'autre caméra
    cameraFace = cameraFace === "user"
        ? "environment"
        : "user";

    await ouvrirCamera();
}

// ==========================================
// 13. VERIFIER UNE VIDEO
// ==========================================


function preparerFichierVideo(fichier) {

    if (!fichier) {
        throw new Error("Aucune vidéo sélectionnée.");
    }

    console.log("Vidéo enregistrée :", {
        nom: fichier.name,
        type: fichier.type,
        taille: fichier.size
    });

    // Vérifier la taille
    if (fichier.size === 0) {
        throw new Error(
            "La vidéo enregistrée est vide. Recommence."
        );
    }

    const limite = 2 * 1024 * 1024 * 1024;

    if (fichier.size > limite) {
        throw new Error(
            "La vidéo dépasse la limite de 2 Go."
        );
    }

    // Formats acceptés
    const extensions = /\.(mp4|webm|mov|3gp|3gpp|m4v)$/i;

    if (extensions.test(fichier.name || "")) {
        return fichier;
    }

    // Certains appareils donnent un nom sans extension.
    // Dans ce cas, identifier le format à partir du MIME.
    const type = (fichier.type || "")
        .split(";")[0]
        .toLowerCase();

    const formats = {
        "video/mp4": "mp4",
        "video/webm": "webm",
        "video/quicktime": "mov",
        "video/3gpp": "3gp",
        "video/x-m4v": "m4v"
    };

    const extension = formats[type];

    if (!extension) {
        throw new Error(
            "Format vidéo non reconnu : " +
            (fichier.type || fichier.name || "inconnu")
        );
    }

    // Donner un nom utilisable par le backend
    const nom = "capture_" + Date.now() + "." + extension;
    if (fichier.localURL) { fichier.name = nom; return fichier; }
    const nouveau = new Blob([fichier], { type: fichier.type });
    Object.defineProperty(nouveau, "name", { value: nom });
    return nouveau;
}


// ==========================================
// 14. AFFICHER UNE VIDEO AVANT PUBLICATION
// ==========================================


async function afficherApercu(fichier) {

    try {
        fichier = preparerFichierVideo(fichier);
    } catch (erreur) {
        console.error("Vidéo non acceptée :", erreur);

        afficherEtat(erreur.message, true);
        return;
    }

    // Nettoyer l'ancien aperçu
    effacerApercu();

    // Fermer la caméra après l'enregistrement
    arreterCameraWeb();
    
    // Arrêter la caméra native Android si elle est active
    await arreterCameraNative();

    fichierChoisi = fichier;
    fichiersChoisis = [fichier];
    $("apercuPhotos").hidden = true;
    $("optionsAudioPhoto").hidden = true;
    $("publicationMultiple").hidden = true;
    $("envoyer").textContent = "Publier la vidéo";
    $("titrePublication").value = (fichier.name || "").replace(/\.[^.]+$/, "").replace(/_/g, " ").slice(0, 255);

    urlApercu = fichier.previewURL || (fichier.localURL ? fichier.localURL : URL.createObjectURL(fichier));

    $("apercu").src = urlApercu;
    $("apercu").hidden = false;

    $("camera").hidden = true;

    // Afficher les boutons de publication
    $("commandesCamera").hidden = true;
    $("commandesApercu").hidden = false;

    $("consigne").hidden = true;
    $("retourner").hidden = true;
    $("indication").hidden = true;
    $("reessayer").hidden = true;
    $("minuteur").hidden = true;

    $("nomFichier").textContent = fichier.name;

    afficherEtat(
        "Vidéo prête à être publiée."
    );
}

function afficherPhotoApercue(index) {
    if (!photoFiles.length) return;
    photoIndex = (index + photoFiles.length) % photoFiles.length;
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = URL.createObjectURL(photoFiles[photoIndex]);
    $("imageApercuPhoto").src = photoPreviewUrl;
    $("compteurApercuPhotos").textContent = (photoIndex + 1) + "/" + photoFiles.length;
    $("photoApercuPrecedente").hidden = photoFiles.length < 2;
    $("photoApercuSuivante").hidden = photoFiles.length < 2;
}

async function afficherApercuPhotos(selection) {
    const photos = Array.from(selection || []);
    if (!photos.length) return;
    const extensions = /\.(jpe?g|png|webp)$/i;
    if (photos.length > 1000 || photos.some(photo =>
        !photo.size || photo.size > 50 * 1024 * 1024 ||
        (!extensions.test(photo.name || "") && !/^image\/(jpeg|png|webp)$/i.test(photo.type || ""))
    ) || photos.reduce((total, photo) => total + photo.size, 0) > 2 * 1024 * 1024 * 1024) {
        afficherEtat("Sélectionne des photos JPG, PNG ou WebP de 50 Mio maximum et moins de 2 Gio au total (1 000 photos au maximum pour protéger le serveur).", true);
        return;
    }

    effacerApercu();
    arreterCameraWeb();
    await arreterCameraNative();
    photoFiles = photos;
    photoAudioMode = "none";
    $("titrePublication").value = (photos[0].name || "Photos").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 255);
    $("nomFichier").textContent = photos.length + (photos.length > 1 ? " photos sélectionnées" : " photo sélectionnée");
    $("publicationMultiple").hidden = true;
    $("apercu").hidden = true;
    $("apercuPhotos").hidden = false;
    $("optionsAudioPhoto").hidden = false;
    $("envoyer").textContent = "Publier les photos";
    $("camera").hidden = true;
    $("commandesCamera").hidden = true;
    $("commandesApercu").hidden = false;
    $("consigne").hidden = true;
    $("retourner").hidden = true;
    $("indication").hidden = true;
    $("reessayer").hidden = true;
    $("minuteur").hidden = true;
    afficherPhotoApercue(0);
    afficherEtat("Photos prêtes. Chaque photo s'affichera trois secondes.");
}

// ==========================================
// 15. FORMAT D'ENREGISTREMENT WEB
// ==========================================


function choisirType() {

    if (typeof MediaRecorder === "undefined") {
        return "";
    }

    // Préférer WebM sur Android lorsque disponible.
    const types = [
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp8",
        "video/webm",
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4"
    ];

    const type = types.find(
        t => MediaRecorder.isTypeSupported(t)
    ) || "";

    console.log("Format sélectionné :", type);

    return type;
}


// ==========================================
// 16. CHRONOMETRE D'ENREGISTREMENT
// ==========================================

function tempsEnregistrement() {

    debut = Date.now();

    $("minuteur").hidden = false;
    $("enregistrer").classList.add("encours");

    $("enregistrer").setAttribute(
        "aria-label",
        "Arrêter l'enregistrement"
    );

    $("galerie").disabled = true;
    $("retourner").disabled = true;

    if ($("retournerBas")) {
        $("retournerBas").disabled = true;
    }

    afficherEtat("Enregistrement en cours...");

    minuterie = setInterval(() => {

        const secondes = Math.floor(
            (Date.now() - debut) / 1000
        );

        $("minuteur").textContent =
            "● " +
            String(Math.floor(secondes / 60))
                .padStart(2, "0") +
            ":" +
            String(secondes % 60)
                .padStart(2, "0");

        // Arrêter automatiquement à 60 secondes
        if (secondes >= 60) {
            finirEnregistrement();
        }

    }, 250);
}

// ==========================================
// 17. ARRETER LE CHRONOMETRE
// ==========================================

function arreterChrono() {

    clearInterval(minuterie);

    $("enregistrer").disabled = false;
    $("enregistrer").classList.remove("encours");

    $("galerie").disabled = false;
    $("retourner").disabled = false;

    if ($("retournerBas")) {
        $("retournerBas").disabled = false;
    }

    $("minuteur").hidden = true;
}

// ==========================================
// 18. RECUPERER UNE VIDEO NATIVE
// ==========================================

// Nécessite cordova-plugin-file
function fichierDepuisChemin(chemin) {

    return new Promise((resolve, reject) => {

        if (!window.resolveLocalFileSystemURL) {

            reject(new Error(
                "Installe cordova-plugin-file pour lire la vidéo."
            ));

            return;
        }

        let uri = String(chemin || "");

        if (uri.startsWith("/")) {
            uri = "file://" + uri;
        }

        if (!uri) {

            reject(new Error(
                "Chemin de la vidéo vide."
            ));

            return;
        }

        window.resolveLocalFileSystemURL(
            uri,

            entree => {

                entree.file(fichier => {

                    fichier.previewURL = entree.toURL();
                    resolve(fichier);

                }, reject);
            },

            reject
        );
    });
}

// ==========================================
// 19. ENREGISTREMENT AVEC CAMERA NATIVE
// ==========================================


async function demarrerEnregistrementNatif() {

    if (enregistrementNatif || operationCamera) {
        return;
    }

    if (
        !apercuNatifActif ||
        !window.CameraPreview?.startRecordVideo
    ) {
        afficherEtat(
            "Enregistrement intégré indisponible.",
            true
        );
        return;
    }

    const permissions =
        window.cordova?.plugins?.permissions;

    // Vérifier l'autorisation du microphone
    if (permissions) {

        const microAutorise = await new Promise(resolve => {

            permissions.requestPermission(
                permissions.RECORD_AUDIO,

                resultat => {
                    resolve(Boolean(resultat.hasPermission));
                },

                () => resolve(false)
            );
        });

        if (!microAutorise) {

            afficherEtat(
                "Autorise le microphone dans les paramètres " +
                "Android pour enregistrer avec le son.",
                true
            );

            return;
        }
    }

    $("enregistrer").disabled = true;

    afficherEtat("Démarrage de l'enregistrement...");

    try {

        // Attendre la confirmation du plugin natif
        await new Promise((resolve, reject) => {

            CameraPreview.startRecordVideo({

                cameraDirection:
                    cameraFace === "user"
                        ? CameraPreview.CAMERA_DIRECTION.FRONT
                        : CameraPreview.CAMERA_DIRECTION.BACK,

                width: 720,
                height: 1280,
                quality: 60,
                withFlash: false

            }, resolve, reject);
        });

        // L'enregistrement a réellement démarré
        enregistrementNatif = true;

        $("enregistrer").disabled = false;

        tempsEnregistrement();

        console.log(
            "Enregistrement vidéo natif démarré."
        );

    } catch (erreur) {

        console.error(
            "Erreur d'enregistrement natif :",
            erreur
        );

        enregistrementNatif = false;

        arreterChrono();

        const message = String(
            erreur?.message || erreur
        );

        if (message.toLowerCase().includes("illegal access")) {

            afficherEtat(
                "Autorisation Android refusée. " +
                "Vérifie les accès Caméra, Microphone, " +
                "Photos et vidéos de StreamingVideo.",
                true
            );

        } else {

            afficherEtat(
                "Impossible d'enregistrer : " + message,
                true
            );
        }

        $("enregistrer").disabled = false;
    }
}


// ==========================================
// 20. TERMINER L'ENREGISTREMENT
// ==========================================

async function finirEnregistrement() {

    if (enregistrementNatif && window.CameraPreview) {

        enregistrementNatif = false;
        arreterChrono();

        $("enregistrer").disabled = true;

        try {

            const chemin = await new Promise(
                (resolve, reject) => {

                    CameraPreview.stopRecordVideo(
                        resolve,
                        reject
                    );
                }
            );

            const fichier = await fichierDepuisChemin(
                chemin
            );

            await afficherApercu(fichier);

        } catch (erreur) {

            console.error(
                "Fin d'enregistrement natif :",
                erreur
            );

            afficherEtat(
                "Enregistrement impossible à récupérer : " +
                (erreur.message || erreur),
                true
            );

            $("enregistrer").disabled = false;
        }

        return;
    }

    // Enregistrement dans le navigateur
    if (enregistreur?.state === "recording") {
        enregistreur.stop();
    }

    clearInterval(minuterie);

    $("enregistrer").disabled = true;
}

// ==========================================
// 21. ENREGISTREMENT DANS LE NAVIGATEUR
// ==========================================

function demarrerEnregistrementWeb() {

    if (
        !flux ||
        typeof MediaRecorder === "undefined"
    ) {

        ouvrirCaptureNative();
        return;
    }

    fragments = [];

    try {

        const type = choisirType();

        enregistreur = new MediaRecorder(flux, {
            ...(type ? { mimeType: type } : {}),
            videoBitsPerSecond: 2500000
        });

    } catch (erreur) {

        afficherEtat(
            "Impossible de démarrer : " +
            erreur.message,
            true
        );

        return;
    }

    enregistreur.ondataavailable = event => {

        if (event.data?.size > 0) {
            fragments.push(event.data);
        }
    };

    enregistreur.onerror = event => {

        console.error("MediaRecorder :", event);

        afficherEtat(
            "Erreur pendant l'enregistrement.",
            true
        );
    };

    enregistreur.onstop = async () => {

        arreterChrono();

        const type =
            enregistreur.mimeType || "video/webm";

        const extension =
            type.includes("mp4") ? "mp4" : "webm";

        const blob = new Blob(fragments, { type });

        fragments = [];

        if (!blob.size) {

            afficherEtat(
                "Enregistrement vide. Recommence.",
                true
            );

            await ouvrirCamera();
            return;
        }

        const fichier = blob;
        Object.defineProperty(fichier, "name", { value: "capture_" + Date.now() + "." + extension });

        await afficherApercu(fichier);
    };

    enregistreur.start(1000);
    tempsEnregistrement();
}

// ==========================================
// 22. CAPTURE NATIVE DE SECOURS
// ==========================================

function ouvrirCaptureNative() {

    let input = $("captureNative");

    if (!input) {

        input = document.createElement("input");

        input.type = "file";
        input.id = "captureNative";
        input.accept = "video/*";

        input.setAttribute(
            "capture",
            "environment"
        );

        input.hidden = true;

        document.body.appendChild(input);

        input.addEventListener("change", event => {

            const fichier = event.target.files?.[0];

            if (fichier) {
                afficherApercu(fichier);
            }
        });
    }

    input.click();
}

// ==========================================
// 23. BOUTON ROUGE
// ==========================================

$("enregistrer").addEventListener("click", () => {

    if (
        enregistrementNatif ||
        enregistreur?.state === "recording"
    ) {

        finirEnregistrement();

    } else if (apercuNatifActif) {

        demarrerEnregistrementNatif();

    } else if (flux) {

        demarrerEnregistrementWeb();

    } else {

        ouvrirCaptureNative();
    }
});

// ==========================================
// 24. GALERIE
// ==========================================

async function afficherSelectionGalerie(selection) {
    if (!selection.length) return;
    let fichiers;
    try { fichiers = selection.map(preparerFichierVideo); }
    catch (erreur) { afficherEtat(erreur.message, true); return; }
    await afficherApercu(fichiers[0]);
    if (!fichierChoisi) return;
    fichiersChoisis = [fichierChoisi, ...fichiers.slice(1)];
    if (fichiersChoisis.length > 1) {
        $("nomFichier").textContent = fichiersChoisis.length + " vidéos sélectionnées · aperçu de " + fichierChoisi.name;
        $("publicationMultiple").hidden = false;
        $("envoyer").textContent = "Publier les " + fichiersChoisis.length + " vidéos";
    }
}

$("galerie").addEventListener("click", async () => {
    if (!window.SVPersistentPicker?.available()) { $("fichier").click(); return; }
    try { await afficherSelectionGalerie(await window.SVPersistentPicker.select()); }
    catch (erreur) { afficherEtat(erreur?.message || (typeof erreur === "string" ? erreur : "Impossible de choisir les vidéos."), true); }
});

$("fichier").addEventListener("change", async event => {
    await afficherSelectionGalerie(Array.from(event.target.files || []));
});

$("galeriePhotos").addEventListener("click", () => $("fichierPhotos").click());
$("fichierPhotos").addEventListener("change", event => afficherApercuPhotos(event.target.files));
$("photoApercuPrecedente").addEventListener("click", () => afficherPhotoApercue(photoIndex - 1));
$("photoApercuSuivante").addEventListener("click", () => afficherPhotoApercue(photoIndex + 1));

async function chargerSonsCatalogue() {
    if (catalogueSons.length) return catalogueSons;
    const response = await fetch(API_URL + "/photo-posts/sounds", {
        headers: { "X-Visitor-Token": SV.token }
    });
    const sounds = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(sounds)) {
        throw new Error(sounds?.message || "Impossible de charger le catalogue de sons.");
    }
    catalogueSons = sounds;
    return sounds;
}

$("sourceAudioPhoto").addEventListener("change", async event => {
    const mode = event.target.value;
    photoAudioMode = mode;
    photoAudioFile = null;
    photoSoundId = null;
    $("sonsCatalogue").hidden = true;
    $("apercuAudioPhoto").pause();
    $("apercuAudioPhoto").removeAttribute("src");
    $("apercuAudioPhoto").hidden = true;
    if (photoAudioPreviewUrl) URL.revokeObjectURL(photoAudioPreviewUrl);
    photoAudioPreviewUrl = null;
    $("nomAudioPhoto").textContent = "";

    if (mode === "local") $("fichierAudioPhoto").click();
    else if (mode === "extract") $("fichierVideoSon").click();
    else if (mode === "catalog") {
        try {
            const sounds = await chargerSonsCatalogue();
            const select = $("sonsCatalogue");
            select.replaceChildren();
            if (!sounds.length) {
                select.add(new Option("Aucun son disponible pour le moment", ""));
                select.disabled = true;
                select.hidden = false;
                $("nomAudioPhoto").textContent = "Le catalogue est alimenté par l’administrateur.";
                return;
            }
            select.disabled = false;
            select.add(new Option("Choisir un son", ""));
            for (const sound of sounds) select.add(new Option(sound.title, sound.id));
            select.hidden = false;
        } catch (error) {
            event.target.value = "none";
            photoAudioMode = "none";
            afficherEtat(error.message, true);
        }
    }
});

$("fichierAudioPhoto").addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (!file) {
        $("sourceAudioPhoto").value = "none";
        photoAudioMode = "none";
        return;
    }
    if (!file.size || file.size > 2 * 1024 * 1024 * 1024) {
        $("sourceAudioPhoto").value = "none";
        photoAudioMode = "none";
        afficherEtat("Le fichier audio est vide ou dépasse 2 Gio.", true);
        return;
    }
    photoAudioFile = file;
    $("nomAudioPhoto").textContent = file.name || "Fichier audio sélectionné";
    photoAudioPreviewUrl = URL.createObjectURL(file);
    $("apercuAudioPhoto").src = photoAudioPreviewUrl;
    $("apercuAudioPhoto").hidden = false;
});

$("fichierVideoSon").addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (!file) {
        $("sourceAudioPhoto").value = "none";
        photoAudioMode = "none";
        return;
    }
    if (!file.size || file.size > 2 * 1024 * 1024 * 1024) {
        $("sourceAudioPhoto").value = "none";
        photoAudioMode = "none";
        afficherEtat("La vidéo est vide ou dépasse 2 Gio.", true);
        return;
    }
    photoAudioFile = file;
    $("nomAudioPhoto").textContent = "Son extrait de : " + (file.name || "vidéo sélectionnée");
});

$("sonsCatalogue").addEventListener("change", event => {
    photoSoundId = event.target.value || null;
    const sound = catalogueSons.find(item => item.id === photoSoundId);
    $("apercuAudioPhoto").pause();
    if (!sound) {
        $("apercuAudioPhoto").hidden = true;
        $("nomAudioPhoto").textContent = "";
        return;
    }
    $("nomAudioPhoto").textContent = sound.title;
    $("apercuAudioPhoto").src = new URL(sound.url, SV.origin).href;
    $("apercuAudioPhoto").hidden = false;
});

// Capture native déjà définie dans le HTML
if ($("captureNative")) {

    $("captureNative").addEventListener(
        "change",
        event => {

            const fichier = event.target.files?.[0];

            if (fichier) {
                afficherApercu(fichier);
            }
        }
    );
}

// ==========================================
// 25. SUPPRIMER ET RECOMMENCER
// ==========================================

$("supprimer").addEventListener(
    "click",
    ouvrirCamera
);

$("reessayer").addEventListener(
    "click",
    ouvrirCamera
);

// Bouton Retourner situé en haut de la page
$("retourner").addEventListener(
    "click",
    retournerCamera
);

// ==========================================
// 26. ENVOYER UNE VIDEO AU BACKEND
// ==========================================

async function envoyerVideo(fichier) {

    if (!API_URL) {

        throw new Error(
            "Adresse API absente : vérifie js/config.js."
        );
    }

    const donnees = new FormData();
    donnees.append("titre", $("titrePublication").value.trim());
    donnees.append("description", $("descriptionPublication").value.trim());

    donnees.append(
        "video",
        fichier,
        fichier.name
    );

    const adresse = API_URL + "/videos";

    const reponse = await fetch(adresse, {
        method: "POST",
        headers: { "X-Visitor-Token": SV.token },
        body: donnees
    });

    const texte = await reponse.text();

    let resultat;

    try {

        resultat = JSON.parse(texte);

    } catch {

        throw new Error(
            "Réponse inattendue HTTP " +
            reponse.status
        );
    }

    if (!reponse.ok) {

        throw new Error(
            resultat.message ||
            "Erreur HTTP " + reponse.status
        );
    }

    return resultat;
}

// ==========================================
// 27. SUIVI DE LA CONVERSION FFmpeg
// ==========================================

async function suivreTraitement(id) {

    // Vérification pendant une heure maximum
    for (let essai = 0; essai < 1800; essai++) {

        await new Promise(resolve => {
            setTimeout(resolve, 2000);
        });

        const reponse = await fetch(
            API_URL +
            "/videos/" +
            encodeURIComponent(id),

            { cache: "no-store", headers: { "X-Visitor-Token": SV.token } }
        );

        if (!reponse.ok) {

            throw new Error(
                "Suivi indisponible : HTTP " +
                reponse.status
            );
        }

        const video = await reponse.json();

        if (video.statut === "prete") {
            return video;
        }

        if (video.statut === "erreur") {

            throw new Error(
                video.erreur ||
                "Conversion échouée."
            );
        }

        afficherEtat(video.statut === "en_cours"
            ? "On prépare ta publication pour une lecture fluide…"
            : "Publication reçue. En attente du traitement...");
    }

    throw new Error(
        "Conversion trop longue. Vérifie le serveur."
    );
}

// ==========================================
// 28. LIEN VERS LA VIDEO PUBLIEE
// ==========================================

function lienVersVideo(id) {

    const destination = "index.html";

    return destination +
        "?video=" +
        encodeURIComponent(id);
}

function envoyerPhotos(photos) {
    if (!API_URL) return Promise.reject(new Error("Adresse API absente : vérifie js/config.js."));
    const tailleTotale = photos.reduce((total, photo) => total + photo.size, 0) + (photoAudioFile?.size || 0);
    if (tailleTotale > 2 * 1024 * 1024 * 1024) {
        return Promise.reject(new Error("La publication photo dépasse la limite technique de 2 Gio au total."));
    }
    const donnees = new FormData();
    photos.forEach((photo, index) => donnees.append("photos", photo, photo.name || `photo-${index + 1}.jpg`));
    donnees.append("titre", $("titrePublication").value.trim());
    donnees.append("description", $("descriptionPublication").value.trim());
    if (photoAudioMode === "local" && photoAudioFile) donnees.append("audio", photoAudioFile, photoAudioFile.name || "son.mp3");
    if (photoAudioMode === "extract" && photoAudioFile) donnees.append("sourceVideo", photoAudioFile, photoAudioFile.name || "source.mp4");
    if (photoAudioMode === "catalog" && photoSoundId) donnees.append("soundId", photoSoundId);

    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", API_URL + "/photo-posts");
        request.setRequestHeader("X-Visitor-Token", SV.token);
        request.upload.onprogress = event => {
            if (!event.lengthComputable) return;
            const percent = Math.floor(event.loaded / event.total * 100);
            $("progression").hidden = false;
            $("progression").value = percent;
            afficherEtat("Envoi des photos : " + percent + " %");
        };
        request.upload.onload = () => afficherEtat("Photos envoyées. Création du diaporama…");
        request.onerror = () => reject(new Error("L’envoi des photos a échoué. Vérifie ta connexion."));
        request.onload = () => {
            let result;
            try { result = JSON.parse(request.responseText); }
            catch { reject(new Error("Réponse inattendue HTTP " + request.status)); return; }
            if (request.status < 200 || request.status >= 300) {
                reject(new Error(result.message || "Erreur HTTP " + request.status));
                return;
            }
            resolve(result);
        };
        request.send(donnees);
    });
}

// ==========================================
// 29. BOUTON PUBLIER
// ==========================================

const formaterOctets = valeur => {
    if (valeur < 1024 * 1024) return (valeur / 1024).toFixed(0) + " Kio";
    return (valeur / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " Mio";
};
const cartesTransferts = new Map();

function actualiserNavigationPublications() {
    const nombre = cartesTransferts.size;
    $("suivrePublications").hidden = vuePublications || !nombre;
    $("suivrePublications").textContent = `Voir les publications (${nombre})`;
    $("transfert").hidden = !vuePublications;
}

function afficherPublications() {
    vuePublications = true;
    document.body.classList.add("publication-en-cours");
    actualiserNavigationPublications();
    $("apercu").pause();
    $("apercuAudioPhoto").pause();
    arreterCameraWeb();
    fermetureCamera = arreterCameraNative().catch(erreur => console.warn("Arrêt caméra :", erreur));
}

async function afficherStudio() {
    vuePublications = false;
    document.body.classList.remove("publication-en-cours");
    actualiserNavigationPublications();
    // Conserver un brouillon déjà sélectionné si l'utilisateur a seulement
    // consulté le suivi. Sinon, réouvrir la caméra pour une nouvelle sélection.
    await fermetureCamera;
    if (!vuePublications && !fichierChoisi && !photoFiles.length) await ouvrirCamera();
}

const optionsGestionnaire = {
    confirmUnverified: () => window.confirm("L'application peut vérifier la partie déjà copiée, mais elle n'a plus accès au reste de la vidéo d'origine. Si tu choisis un autre fichier, la vidéo publiée peut être endommagée. Confirme que tu as sélectionné exactement la vidéo d'origine pour continuer."),
    onUpdate(record, mesure, transfert) {
    let carte = cartesTransferts.get(transfert);
    if (!record) {
        carte?.remove();
        cartesTransferts.delete(transfert);
        if (!cartesTransferts.size && vuePublications) afficherStudio();
        else actualiserNavigationPublications();
        return;
    }
    if (!carte) {
        carte = document.createElement("article");
        carte.className = "transfert-carte";
        carte.innerHTML = `<div class="transfert-entete"><span class="transfert-icone" aria-hidden="true">▶</span><div><strong class="nom"></strong><p class="etat" role="status"></p></div><span class="pourcent">0 %</span></div>
            <progress max="100" value="0" aria-label="Progression de l’envoi"></progress><p class="transfert-details"></p>
            <div class="transfert-actions"><button class="pause" type="button">Mettre en pause</button><button class="continuer" type="button">Reprendre</button><button class="annuler" type="button">Annuler</button><input class="rechoisir" type="file" accept="video/*,.mkv,.3gp,.m4v" hidden><a class="voir" href="index.html">Voir la vidéo</a></div>`;
        carte.querySelector(".pause").onclick = () => transfert.pause().catch(erreur => afficherEtat(erreur.message, true));
        carte.querySelector(".continuer").onclick = async () => {
            if (transfert.record?.needsFile && !transfert.originalFile && (!transfert.record.source?.originalUri || transfert.record.sourceUnavailable)) {
                if (!window.SVPersistentPicker?.available()) { carte.querySelector(".rechoisir").click(); return; }
                try {
                    const fichiers = await window.SVPersistentPicker.select();
                    if (fichiers.length) await gestionnaire.continueWithFile(transfert, fichiers[0]);
                } catch (erreur) { afficherEtat(erreur?.message || (typeof erreur === "string" ? erreur : "Impossible de retrouver la vidéo."), true); }
            } else transfert.resume();
        };
        carte.querySelector(".rechoisir").onchange = event => {
            const fichier = event.target.files?.[0];
            if (fichier) gestionnaire.continueWithFile(transfert, fichier).catch(erreur => afficherEtat(erreur.message, true));
            event.target.value = "";
        };
        carte.querySelector(".annuler").onclick = () => transfert.cancel().catch(erreur => afficherEtat(erreur.message, true));
        $("transfertListe").appendChild(carte);
        cartesTransferts.set(transfert, carte);
    }
    actualiserNavigationPublications();
    carte.querySelector(".nom").textContent = record.title || record.name;
    const etats = { preparing: "Préparation de la copie sur l’appareil…", ready: "Prêt à envoyer", queued: "En attente d’une place d’envoi", connecting: "Connexion au serveur…",
        uploading: record.copyComplete === false ? "Copie et envoi en cours" : "Envoi en cours", paused: "Envoi en pause", interrupted: "Connexion interrompue · nouvelle tentative…",
        finalizing: "Vérification de l’envoi…", processing: "Vidéo reçue · préparation en cours…", done: "Vidéo publiée", error: record.error || "Publication interrompue" };
    const sourceManquante = record.needsFile && !transfert.originalFile && (!record.source?.originalUri || record.sourceUnavailable);
    carte.querySelector(".etat").textContent = record.copyVerifying ? "Vérification de la copie conservée…" :
        sourceManquante ? (record.state === "error" && record.error ? record.error : "La source n'est plus accessible. Appuie sur Reprendre pour choisir la même vidéo et vérifier la copie.") :
        mesure.networkSlow && record.state === "uploading" ? "Connexion lente ou instable…" : (etats[record.state] || "Publication en cours");
    const valeur = mesure.sent ?? record.offset ?? 0;
    const total = record.size;
    const pourcent = total ? Math.min(100, Math.max(0, valeur / total * 100)) : 0;
    carte.querySelector("progress").value = pourcent;
    carte.querySelector(".pourcent").textContent = Math.floor(pourcent) + " %";
    let details = formaterOctets(valeur) + " sur " + formaterOctets(total || 0);
    if (mesure.speed > 0 && record.state === "uploading") {
        const secondes = Math.ceil(Math.max(0, total - valeur) / mesure.speed);
        details += " · " + formaterOctets(mesure.speed) + "/s · environ " + (secondes >= 60 ? Math.ceil(secondes / 60) + " min" : secondes + " s") + " restantes";
    }
    if (record.state === "uploading" && valeur > (record.offset || 0)) details += " · " + formaterOctets(record.offset || 0) + " confirmés";
    if (!record.copyComplete && !record.videoId) details += " · copie : " + formaterOctets(record.copiedBytes || 0) + " sur " + formaterOctets(record.size) + ". Garde cette page ouverte jusqu’à la fin de la copie.";
    carte.querySelector(".transfert-details").textContent = details;
    carte.querySelector(".pause").hidden = !["queued", "connecting", "uploading"].includes(record.state);
    carte.querySelector(".continuer").hidden = !["paused", "interrupted", "error"].includes(record.state) && !record.needsFile;
    carte.querySelector(".continuer").disabled = !!record.copyVerifying;
    carte.querySelector(".continuer").textContent = "Reprendre";
    carte.querySelector(".annuler").hidden = ["preparing", "processing", "finalizing", "done"].includes(record.state);
    carte.querySelector(".voir").hidden = record.state !== "done";
    if (record.state === "done") carte.querySelector(".voir").href = lienVersVideo(record.videoId);
} };
let gestionnairePartage = null;
try { if (window.SVParentStudio) gestionnairePartage = window.parent.SVBackgroundUploads || null; } catch {}
const gestionnaire = gestionnairePartage || new SVUploadManager(optionsGestionnaire);
if (gestionnairePartage) {
    gestionnaire.confirmUnverified = optionsGestionnaire.confirmUnverified;
    gestionnaire.addListener(optionsGestionnaire.onUpdate);
}

$("nouvellePublication").addEventListener("click", afficherStudio);
$("suivrePublications").addEventListener("click", afficherPublications);

$("envoyer").addEventListener("click", () => {
    if (vuePublications) return;
    if (photoFiles.length) {
        const photos = [...photoFiles];
        $("progression").value = 0;
        afficherPublications();
        envoyerPhotos(photos).then(async result => {
            afficherEtat("Photos reçues. Préparation du diaporama…");
            await suivreTraitement(result.id);
            effacerApercu();
            $("titrePublication").value = "";
            $("descriptionPublication").value = "";
            $("voirVideo").href = lienVersVideo(result.id);
            $("voirVideo").hidden = false;
            afficherEtat("Publication photo publiée.");
        }).catch(async error => {
            await afficherStudio();
            afficherEtat(error.message || "Impossible de publier les photos.", true);
        });
        return;
    }
    if (!fichiersChoisis.length) return;
    const description = $("descriptionPublication").value.trim();
    const titre = $("titrePublication").value.trim();
    const fichiers = [...fichiersChoisis];
    afficherPublications();
    // Le gestionnaire garde chaque File indépendamment de la prévisualisation.
    fichiers.forEach((fichier, index) => {
        const title = index === 0 ? titre : (fichier.name || "Vidéo").replace(/\.[^.]+$/, "").replace(/_/g, " ").slice(0, 255);
        gestionnaire.start(fichier, { title, description }).catch(erreur => afficherEtat(erreur.message || "Impossible de préparer la publication.", true));
    });
    effacerApercu();
    $("titrePublication").value = "";
    $("descriptionPublication").value = "";
});

// ==========================================
// 30. NETTOYAGE QUAND ON QUITTE LA PAGE
// ==========================================

function nettoyerCamera() {

    clearInterval(minuterie);
    arreterCameraWeb();

    if (apercuNatifActif && window.CameraPreview) {

        CameraPreview.stopCamera();
        apercuNatifActif = false;
    }

    activerModeNatif(false);
}

window.addEventListener(
    "pagehide",
    nettoyerCamera
);

window.addEventListener(
    "beforeunload",
    nettoyerCamera
);

// Le cadre reste vivant lorsqu'on retourne au fil : seule sa caméra s'arrête.
window.addEventListener("message", event => {
    if (!window.SVParentStudio || event.source !== window.parent || event.data?.type !== "sv-studio-visibility") return;
    if (!event.data.visible) {
        $("apercu").pause();
        arreterCameraWeb();
        fermetureCamera = arreterCameraNative().catch(erreur => console.warn("Arrêt caméra :", erreur));
    } else if (!vuePublications && !fichierChoisi) {
        Promise.resolve(fermetureCamera).then(() => ouvrirCamera());
    }
});

// Les liens vers le fil ne doivent pas recharger la page qui porte l'envoi.
document.addEventListener("click", event => {
    if (!window.SVParentStudio) return;
    const link = event.target.closest?.("a[href]");
    if (!link || link.closest(".publication-notice")) return;
    let destination;
    try { destination = new URL(link.href, location.href); } catch { return; }
    if (destination.origin !== location.origin || !destination.pathname.endsWith("/index.html")) return;
    event.preventDefault();
    event.stopPropagation();
    window.SVParentStudio.close(destination.searchParams.get("video"));
}, true);

// ==========================================
// 31. INITIALISER LE STUDIO
// ==========================================

async function initialiserStudio() {

    SV.api("/profile").then(profil => {
        $("auteurPublication").textContent = profil.pseudo;
    }).catch(() => {});

    installerBoutonRetourner();

    try {
        const nombre = await gestionnaire.restore();
        if (gestionnairePartage) for (const transfert of gestionnaire.transfers) transfert.display();
        if (nombre) { afficherPublications(); return; }
    }
    catch (erreur) { afficherEtat("Stockage local indisponible : " + erreur.message, true); }
    await ouvrirCamera();
}

// Attendre que les plugins Cordova soient prêts
if (estCordova()) {

    document.addEventListener(
        "deviceready",
        initialiserStudio,
        { once: true }
    );

} else {

    initialiserStudio();
}
