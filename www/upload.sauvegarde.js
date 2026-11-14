
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
let urlApercu = null;
let minuterie = null;
let debut = 0;

let cameraFace = "environment";
let envoiEnCours = false;
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

    if (!envoiEnCours || messageFinal) {

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
        URL.revokeObjectURL(urlApercu);
    }

    urlApercu = null;
    fichierChoisi = null;

    $("fichier").value = "";

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
        envoiEnCours ||
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
    }
}

// ==========================================
// 12. RETOURNER LA CAMERA
// ==========================================

async function retournerCamera() {

    if (
        operationCamera ||
        envoiEnCours ||
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
    return new File(
        [fichier],
        "capture_" + Date.now() + "." + extension,
        { type: fichier.type }
    );
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

    // Conserver la vidéo pour sa publication
    fichierChoisi = fichier;

    fichierChoisi = fichier;

    urlApercu = URL.createObjectURL(fichier);

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

                    const nom =
                        "capture_" + Date.now() + ".mp4";

                    resolve(new File(
                        [fichier],
                        nom,
                        { type: "video/mp4" }
                    ));

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

        const fichier = new File(
            [blob],
            "capture_" + Date.now() + "." + extension,
            { type }
        );

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

$("galerie").addEventListener("click", () => {
    $("fichier").click();
});

$("fichier").addEventListener("change", event => {

    const fichier = event.target.files?.[0];

    if (fichier) {
        afficherApercu(fichier);
    }
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

    donnees.append(
        "video",
        fichier,
        fichier.name
    );

    const adresse = API_URL + "/videos";

    const reponse = await fetch(adresse, {
        method: "POST",
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

            { cache: "no-store" }
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

        afficherEtat(
            video.statut === "en_cours"
                ? "FFmpeg prépare les différentes qualités HLS/fMP4..."
                : "Vidéo reçue. En attente du traitement..."
        );
    }

    throw new Error(
        "Conversion trop longue. Vérifie le serveur."
    );
}

// ==========================================
// 28. LIEN VERS LA VIDEO PUBLIEE
// ==========================================

function lienVersVideo(id) {

    const destination = estCordova()
        ? "index.html"
        : "/app/";

    return destination +
        "?video=" +
        encodeURIComponent(id);
}

// ==========================================
// 29. BOUTON PUBLIER
// ==========================================

$("envoyer").addEventListener("click", async () => {

    if (!fichierChoisi || envoiEnCours) {
        return;
    }

    envoiEnCours = true;

    $("envoyer").disabled = true;
    $("supprimer").disabled = true;

    $("progression").hidden = false;

    // Barre animée pendant l'envoi
    $("progression").removeAttribute("value");

    $("voirVideo").hidden = true;

    try {

        afficherEtat(
            "Envoi de la vidéo au serveur..."
        );

        const resultat = await envoyerVideo(
            fichierChoisi
        );

        $("progression").value = 100;

        const video = await suivreTraitement(
            resultat.id
        );

        afficherEtat(
            "Vidéo publiée ! Conversion HLS/fMP4 terminée."
        );

        $("voirVideo").href = lienVersVideo(
            video.id
        );

        $("voirVideo").hidden = false;

    } catch (erreur) {

        console.error("Publication :", erreur);

        afficherEtat(
            "Erreur : " + erreur.message,
            true
        );

    } finally {

        envoiEnCours = false;

        $("envoyer").disabled = false;
        $("supprimer").disabled = false;
        $("progression").hidden = true;
    }
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

// ==========================================
// 31. INITIALISER LE STUDIO
// ==========================================

async function initialiserStudio() {

    installerBoutonRetourner();

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
