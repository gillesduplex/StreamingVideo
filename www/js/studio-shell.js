"use strict";

// Le fil reste la page racine ; le studio est conservé pendant que l'on
// regarde les vidéos, ce qui ne détruit ni les File ni les copies en cours.
window.SVStudio = (() => {
    let frame = null;
    let visible = false;
    let uploadStatus = null;

    function notifyFrame() {
        frame?.contentWindow?.postMessage({ type: "sv-studio-visibility", visible }, "*");
    }
    function setVisible(value) {
        visible = value;
        if (!value) document.documentElement.classList.remove("sv-studio-camera");
        if (frame) frame.hidden = !value;
        document.body.classList.toggle("studio-ouvert", value);
        // Le lecteur suspend son son et reprend son état lorsqu'on revient.
        document.dispatchEvent(new CustomEvent("stream:modal", { detail: value }));
        notifyFrame();
    }
    function open() {
        if (!frame) {
            frame = document.createElement("iframe");
            frame.className = "studio-frame";
            frame.title = "Créer et suivre les publications";
            frame.setAttribute("allow", "camera; microphone");
            frame.src = "upload.html";
            frame.addEventListener("load", notifyFrame);
            document.body.append(frame);
        }
        setVisible(true);
    }
    function close(videoId) {
        if (visible) setVisible(false);
        if (videoId) document.dispatchEvent(new CustomEvent("sv:show-video", { detail: { id: videoId } }));
    }
    function renderUploadStatus() {
        const active = (window.SVBackgroundUploads?.transfers || [])
            .map(transfer => transfer.record)
            .filter(record => record && !record.hidden && !["done", "cancelled"].includes(record.state));
        if (!active.length) {
            uploadStatus?.remove();
            uploadStatus = null;
            return;
        }

        if (!uploadStatus) {
            uploadStatus = document.createElement("button");
            uploadStatus.type = "button";
            uploadStatus.className = "upload-background-status";
            uploadStatus.setAttribute("aria-live", "polite");
            uploadStatus.addEventListener("click", open);
            uploadStatus.innerHTML = "<span class=\"upload-background-copy\"><strong></strong><small></small></span><progress max=\"100\" value=\"0\"></progress>";
            document.body.append(uploadStatus);
        }

        const current = active.find(record => ["uploading", "processing", "finalizing"].includes(record.state)) || active[0];
        const labels = {
            preparing: "Préparation sur l’appareil",
            ready: "Prête à envoyer",
            queued: "En attente d’une place",
            connecting: "Connexion au serveur",
            uploading: "Envoi",
            paused: "En pause",
            interrupted: "Reprise après interruption",
            finalizing: "Finalisation",
            processing: "Traitement de la vidéo",
            error: "À reprendre"
        };
        const totalSize = active.reduce((total, record) => total + (Number(record.size) || 0), 0);
        const completedSize = active.reduce((total, record) => {
            const size = Number(record.size) || 0;
            const sent = ["processing", "finalizing"].includes(record.state)
                ? size
                : Math.max(Number(record.offset) || 0, Number(record.copiedBytes) || 0);
            return total + Math.min(size, sent);
        }, 0);
        const progress = totalSize ? Math.round(completedSize / totalSize * 100) : 0;
        const title = active.length > 1 ? `${active.length} publications à suivre`
            : ["paused", "error"].includes(current.state) ? "Publication à reprendre" : "Publication en cours";
        const name = current.title || current.name;
        uploadStatus.querySelector("strong").textContent = title;
        uploadStatus.querySelector("small").textContent =
            `${name ? `${name} · ` : ""}${labels[current.state] || "En cours"} · ${progress}% · Appuie pour suivre`;
        uploadStatus.querySelector("progress").value = progress;
        uploadStatus.setAttribute("aria-label", uploadStatus.textContent);
    }
    window.addEventListener("sv-upload-update", renderUploadStatus);
    renderUploadStatus();
    document.addEventListener("backbutton", event => {
        if (!visible) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
    }, true);
    document.addEventListener("click", event => {
        const brand = event.target.closest?.("a.brand, a.mobile-brand");
        if (!brand) return;
        event.preventDefault();
        document.dispatchEvent(new CustomEvent("sv:go-home"));
    });
    function cameraMode(active) {
        document.documentElement.classList.toggle("sv-studio-camera", !!active && visible);
    }
    return { open, close, cameraMode, showVideo: close, isVisible: () => visible };
})();
