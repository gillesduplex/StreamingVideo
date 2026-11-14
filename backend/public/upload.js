"use strict";
const $ = (id) => document.getElementById(id);

let flux = null;
let enregistreur = null;
let fragments = [];
let fichierChoisi = null;
let urlApercu = null;
let minuterie = null;
let debut = 0;
let cameraFace = "user";
let envoiEnCours = false;

function afficherEtat(texte, erreur = false) {
  $("etat").textContent = texte;
  $("etat").classList.toggle("erreur", erreur);
}
function arreterCamera() {
  if (flux) flux.getTracks().forEach((piste) => piste.stop());
  flux = null;
  $("camera").srcObject = null;
}
function effacerApercu() {
  $("apercu").pause();
  $("apercu").removeAttribute("src");
  $("apercu").load();
  if (urlApercu) URL.revokeObjectURL(urlApercu);
  urlApercu = null;
  fichierChoisi = null;
  $("fichier").value = "";
  $("voirVideo").hidden = true;
  $("progression").hidden = true;
}
function affichageCamera() {
  $("camera").hidden = false;
  $("apercu").hidden = true;
  $("commandesCamera").hidden = false;
  $("commandesApercu").hidden = true;
  $("consigne").hidden = false;
  $("retourner").hidden = false;
  $("indication").hidden = false;
  $("minuteur").hidden = true;
  $("enregistrer").disabled = false;
  $("enregistrer").classList.remove("encours");
}
async function ouvrirCamera() {
  if (envoiEnCours) return;
  clearInterval(minuterie);
  arreterCamera();
  effacerApercu();
  affichageCamera();
  $("reessayer").hidden = true;
  afficherEtat("Ouverture de la caméra...");
  if (!navigator.mediaDevices?.getUserMedia) {
    afficherEtat("Caméra indisponible : ouvre cette page sur localhost ou en HTTPS, puis autorise la caméra.", true);
    $("reessayer").hidden = false;
    return;
  }
  const video = { facingMode: { ideal: cameraFace }, width: { ideal: 720 }, height: { ideal: 1280 } };
  try {
    try {
      flux = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    } catch {
      // Certains appareils autorisent la caméra mais pas le microphone.
      flux = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      afficherEtat("Microphone indisponible : enregistrement sans son.");
    }
    $("camera").srcObject = flux;
    $("camera").classList.toggle("miroir", cameraFace === "user");
    await $("camera").play();
    $("indication").textContent = "Prêt à enregistrer";
    if (flux.getAudioTracks().length) afficherEtat("Caméra prête. Appuie sur le bouton rouge.");
  } catch (erreur) {
    console.error(erreur);
    afficherEtat("Impossible d'ouvrir la caméra. Autorise son accès ou utilise la galerie.", true);
    $("indication").textContent = "Caméra indisponible";
    $("reessayer").hidden = false;
    $("enregistrer").disabled = true;
  }
}
function afficherApercu(fichier) {
  effacerApercu();
  arreterCamera();
  fichierChoisi = fichier;
  urlApercu = URL.createObjectURL(fichier);
  $("apercu").src = urlApercu;
  $("apercu").hidden = false;
  $("camera").hidden = true;
  $("commandesCamera").hidden = true;
  $("commandesApercu").hidden = false;
  $("consigne").hidden = true;
  $("retourner").hidden = true;
  $("indication").hidden = true;
  $("reessayer").hidden = true;
  $("minuteur").hidden = true;
  $("nomFichier").textContent = fichier.name;
  afficherEtat("Regarde l'aperçu. Tu peux supprimer la vidéo ou la publier.");
}
function choisirType() {
  const types = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4"
  ];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}
function finirEnregistrement() {
  if (enregistreur?.state === "recording") enregistreur.stop();
  clearInterval(minuterie);
  $("enregistrer").disabled = true;
}
function demarrerEnregistrement() {
  if (!flux || !window.MediaRecorder) {
    afficherEtat("Enregistrement non pris en charge par ce navigateur.", true);
    return;
  }
  fragments = [];
  try {
    const type = choisirType();
    enregistreur = new MediaRecorder(
      flux, type ? { mimeType: type, videoBitsPerSecond: 2500000 } : { videoBitsPerSecond: 2500000 }
    );
  } catch (erreur) {
    afficherEtat("Impossible de démarrer l'enregistrement : " + erreur.message, true);
    return;
  }
  enregistreur.ondataavailable = (e) => { if (e.data?.size > 0) fragments.push(e.data); };
  enregistreur.onerror = (e) => { afficherEtat("Erreur pendant l'enregistrement.", true); console.error(e); };
  enregistreur.onstop = () => {
    clearInterval(minuterie);
    const type = enregistreur.mimeType || "video/webm";
    const ext = type.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(fragments, { type });
    fragments = [];
    if (!blob.size) {
      afficherEtat("Enregistrement vide. Recommence.", true);
      ouvrirCamera();
      return;
    }
    const nom = "capture_" + Date.now() + "." + ext;
    afficherApercu(new File([blob], nom, { type }));
  };
  enregistreur.start(1000);
  debut = Date.now();
  $("enregistrer").classList.add("encours");
  $("enregistrer").setAttribute("aria-label", "Arrêter l'enregistrement");
  $("galerie").disabled = true;
  $("retourner").disabled = true;
  $("minuteur").hidden = false;
  $("indication").hidden = true;
  afficherEtat("Enregistrement en cours...");
  minuterie = setInterval(() => {
    const secondes = Math.floor((Date.now() - debut) / 1000);
    $("minuteur").textContent = "● " + String(Math.floor(secondes / 60)).padStart(2, "0") + ":" + String(secondes % 60).padStart(2, "0");
    if (secondes >= 60) finirEnregistrement();
  }, 250);
}
$("enregistrer").addEventListener("click", () => {
  if (enregistreur?.state === "recording") finirEnregistrement();
  else demarrerEnregistrement();
});
$("galerie").addEventListener("click", () => $("fichier").click());
$("fichier").addEventListener("change", (e) => {
  const fichier = e.target.files?.[0];
  if (!fichier) return;
  if (!/\.(mp4|webm|mov)$/i.test(fichier.name) || fichier.size === 0 || fichier.size > 2 * 1024 ** 3) {
    afficherEtat("Choisis une vidéo MP4, WebM ou MOV de 2 Go maximum.", true);
    e.target.value = "";
    return;
  }
  afficherApercu(fichier);
});
$("supprimer").addEventListener("click", () => ouvrirCamera());
$("reessayer").addEventListener("click", () => ouvrirCamera());
$("retourner").addEventListener("click", async () => {
  cameraFace = cameraFace === "user" ? "environment" : "user";
  await ouvrirCamera();
});

function envoyerVideo(fichier) {
  return new Promise((resolve, reject) => {
    const donnees = new FormData();
    donnees.append("video", fichier, fichier.name);
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      const progression = Math.round(100 * e.loaded / e.total);
      $("progression").value = progression;
      afficherEtat("Envoi au serveur : " + progression + "%");
    });
    xhr.open("POST", "/api/videos");
    xhr.onload = () => {
      let resultat;
      try { resultat = JSON.parse(xhr.responseText); }
      catch { reject(new Error("Réponse serveur inattendue : HTTP " + xhr.status)); return; }
      if (xhr.status < 200 || xhr.status >= 300) reject(new Error(resultat.message || "Erreur HTTP " + xhr.status));
      else resolve(resultat);
    };
    xhr.onerror = () => reject(new Error("Connexion au serveur impossible."));
    xhr.onabort = () => reject(new Error("Envoi annulé."));
    xhr.send(donnees);
  });
}
async function suivreTraitement(id) {
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    const reponse = await fetch("/api/videos/" + encodeURIComponent(id), { cache: "no-store" });
    if (!reponse.ok) throw new Error("Suivi de conversion indisponible : HTTP " + reponse.status);
    const video = await reponse.json();
    if (video.statut === "prete") return video;

const lienVideo = document.getElementById("voirVideo");

lienVideo.href =
    "/app/?video=" + encodeURIComponent(video.id);

lienVideo.hidden = false;

    if (video.statut === "erreur") throw new Error(video.erreur || "Conversion échouée.");
    afficherEtat(video.statut === "en_cours" ? "Vidéo reçue. FFmpeg prépare les qualités HLS/fMP4..." : "Vidéo reçue. En attente du traitement...");
  }
}
$("envoyer").addEventListener("click", async () => {
  if (!fichierChoisi || envoiEnCours) return;
  envoiEnCours = true;
  $("envoyer").disabled = true;
  $("supprimer").disabled = true;
  $("progression").value = 0;
  $("progression").hidden = false;
  $("voirVideo").hidden = true;
  try {
    afficherEtat("Envoi au serveur...");
    const resultat = await envoyerVideo(fichierChoisi);
    afficherEtat("Vidéo reçue. En attente de la conversion...");
    const prete = await suivreTraitement(resultat.id);
    afficherEtat("Vidéo publiée ! Conversion HLS/fMP4 terminée.");
    $("voirVideo").href = "/app/?video=" + encodeURIComponent(prete.id);
    $("voirVideo").hidden = false;
  } catch (erreur) {
    afficherEtat("Erreur : " + erreur.message, true);
  } finally {
    envoiEnCours = false;
    $("envoyer").disabled = false;
    $("supprimer").disabled = false;
  }
});
window.addEventListener("beforeunload", arreterCamera);
ouvrirCamera();
