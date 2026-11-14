"use strict";

document.addEventListener("DOMContentLoaded", () => {
    const $ = id => document.getElementById(id);
    const { api, element, icon, emit, initials, number } = SV;
    let current = null, profile = null, videoGeneration = 0;
    let commentVideoId = null, commentGeneration = 0, nextCursor = null;
    let replyTo = null, posting = false, shareTarget = null;
    const pending = new Set(), revisions = new Map(), comments = new Map(), threads = new Map();
    const toast = text => emit("toast", text);
    const commentDialog = $("commentairesDialog");
    const composer = $("texteCommentaire");

    function show(dialog) {
        if (dialog.open) return;
        const alreadyOpen = !!document.querySelector("dialog[open]");
        dialog.showModal();
        if (!alreadyOpen) emit("modal", true);
    }
    document.querySelectorAll("dialog").forEach(dialog => {
        dialog.addEventListener("close", () => {
            if (dialog === commentDialog) ++commentGeneration;
            if (!document.querySelector("dialog[open]")) emit("modal", false);
        });
        dialog.addEventListener("click", event => {
            if (event.target !== dialog) return;
            const box = dialog.getBoundingClientRect();
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
        });
    });
    document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));

    function renderSocial() {
        $("nombreLikes").textContent = number(current?.likes);
        $("nombreCommentaires").textContent = number(current?.comments);
        $("nombrePartages").textContent = number(current?.shares);
        $("aimer").classList.toggle("aime", !!current?.liked);
        $("aimer").setAttribute("aria-pressed", String(!!current?.liked));
        $("aimer").setAttribute("aria-label", current?.liked ? "Retirer mon J’aime" : "Aimer la vidéo");
        $("enregistrerVideo").classList.toggle("saved", !!current?.saved);
        $("enregistrerVideo").setAttribute("aria-pressed", String(!!current?.saved));
        $("enregistrerVideo").setAttribute("aria-label", current?.saved ? "Retirer des favoris" : "Enregistrer dans les favoris");
        $("aimer").disabled = !current || pending.has("like:" + current.id);
        $("enregistrerVideo").disabled = !current || pending.has("save:" + current.id);
        for (const id of ["commenter", "partager", "ouvrirDiscussion"]) $(id).disabled = !current;
        if (commentVideoId === current?.id) $("totalCommentaires").textContent = number(current.comments);
    }
    function updateSocial(stats) {
        emit("social", stats);
        if (current?.id === stats.id) { Object.assign(current, stats); renderSocial(); }
    }
    async function refreshSocial() {
        if (!current || document.hidden) return;
        const id = current.id, generation = videoGeneration, revision = revisions.get(id) || 0;
        try {
            const stats = await api("/videos/" + id + "/social");
            if (generation === videoGeneration && revision === (revisions.get(id) || 0) && !pending.has("like:" + id) && !pending.has("save:" + id)) updateSocial(stats);
        } catch { /* Le fil reste utilisable si l'actualisation discrète échoue. */ }
    }
    document.addEventListener("stream:video", event => {
        current = event.detail; ++videoGeneration; renderSocial();
        if (commentDialog.open) commentDialog.close();
        if (current) refreshSocial();
    });
    function heartAnimation() {
        const heart = $("coeurAnimation"); heart.classList.remove("animate");
        void heart.offsetWidth; heart.classList.add("animate");
    }
    async function toggle(resource, forceLike = false) {
        if (!current) return;
        const item = current, key = resource + ":" + item.id;
        if (pending.has(key) || (forceLike && item.liked)) return;
        const field = resource === "like" ? "liked" : "saved", active = !item[field];
        pending.add(key); revisions.set(item.id, (revisions.get(item.id) || 0) + 1);
        // Retour visuel immédiat, puis confirmation par le serveur.
        const button = $(resource === "like" ? "aimer" : "enregistrerVideo");
        button.classList.toggle(resource === "like" ? "aime" : "saved", active);
        button.setAttribute("aria-pressed", String(active)); button.disabled = true;
        if (resource === "like" && active) { heartAnimation(); $("nombreLikes").textContent = number(item.likes + 1); }
        try {
            const stats = await api("/videos/" + item.id + "/" + resource, { method: active ? "PUT" : "DELETE" });
            updateSocial(stats);
            if (resource === "save") toast(active ? "Ajoutée à tes favoris" : "Retirée de tes favoris");
        } catch (error) { toast(error.message); }
        finally { pending.delete(key); renderSocial(); }
    }
    $("aimer").addEventListener("click", () => toggle("like"));
    $("enregistrerVideo").addEventListener("click", () => toggle("save"));
    document.addEventListener("stream:doubletap", () => { if (current?.liked) heartAnimation(); else toggle("like", true); });

    function renderProfile(value) {
        profile = { ...profile, ...value };
        document.querySelectorAll(".my-avatar").forEach(node => { node.textContent = initials(profile.pseudo); });
        document.querySelectorAll(".my-name").forEach(node => { node.textContent = profile.pseudo; });
        if (value.likes !== undefined) $("profilLikes").textContent = number(value.likes);
        if (value.saves !== undefined) $("profilFavoris").textContent = number(value.saves);
        if (value.comments !== undefined) $("profilCommentaires").textContent = number(value.comments);
    }
    api("/profile").then(renderProfile).catch(() => {});
    async function openProfile() {
        $("pseudo").value = profile?.pseudo || ""; $("erreurProfil").textContent = "";
        show($("profilDialog"));
        try {
            const value = await api("/profile"); renderProfile(value);
            if (!$("pseudo").value) $("pseudo").value = value.pseudo;
        } catch (error) { $("erreurProfil").textContent = error.message; }
    }
    document.querySelectorAll("[data-profile]").forEach(button => button.addEventListener("click", openProfile));
    $("profilForm").addEventListener("submit", async event => {
        event.preventDefault(); $("sauverProfil").disabled = true; $("erreurProfil").textContent = "";
        try {
            const value = await api("/profile", { method: "PATCH", body: JSON.stringify({ pseudo: $("pseudo").value.trim() }) });
            renderProfile(value); emit("profile", value);
            for (const comment of comments.values()) {
                if (comment.authorId !== value.id) continue;
                comment.pseudo = value.pseudo;
                const row = $("comment-" + comment.id);
                if (row) { row.querySelector(".comment-name").textContent = value.pseudo; row.querySelector(".avatar").textContent = initials(value.pseudo); }
            }
            $("profilDialog").close(); toast("Ton pseudo a été enregistré");
        } catch (error) { $("erreurProfil").textContent = error.message; }
        finally { $("sauverProfil").disabled = false; }
    });

    function emptyState(title, description, retry) {
        const state = element("div", "comments-empty");
        state.append(icon("comment"), element("strong", "", title), element("p", "", description));
        if (retry) { const button = element("button", "secondary-button", "Réessayer"); button.addEventListener("click", () => loadComments(true)); state.append(button); }
        return state;
    }
    function relativeDate(value) {
        const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
        if (s < 60) return "à l’instant";
        if (s < 3600) return Math.floor(s / 60) + " min";
        if (s < 86400) return Math.floor(s / 3600) + " h";
        return Math.floor(s / 86400) + " j";
    }
    function cancelReply() { replyTo = null; $("reponseBandeau").hidden = true; composer.placeholder = "Ajoute ton grain de sel…"; }
    $("annulerReponse").addEventListener("click", () => { cancelReply(); composer.focus(); });
    function updateComposer() {
        $("envoyerCommentaire").disabled = posting || !composer.value.trim();
        $("longueurCommentaire").textContent = composer.value.length + "/1000";
        composer.style.height = "43px"; composer.style.height = Math.min(110, Math.max(43, composer.scrollHeight)) + "px";
    }
    composer.addEventListener("input", () => {
        $("erreurCommentaire").textContent = "Un peu de bienveillance, beaucoup d’échanges.";
        $("erreurCommentaire").classList.remove("error"); updateComposer();
    });
    composer.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("envoyerCommentaire").disabled) $("commentaireForm").requestSubmit(); }
    });
    function commentError(message) { $("erreurCommentaire").textContent = message; $("erreurCommentaire").classList.add("error"); }

    function commentRow(item) {
        comments.set(item.id, item);
        const row = element("article", "comment-item"); row.id = "comment-" + item.id;
        const avatar = element("span", "avatar", initials(item.pseudo)); avatar.setAttribute("aria-hidden", "true");
        const body = element("div", "comment-main"), author = element("div", "comment-author");
        author.append(element("span", "comment-name", item.pseudo));
        if (item.mine) author.append(element("span", "mine-badge", "Toi"));
        body.append(author);
        if (item.replyTo) body.append(element("p", "reply-to", "En réponse à " + item.replyTo));
        body.append(element("p", "comment-text", item.texte));
        const actions = element("div", "comment-actions"), date = element("time", "", relativeDate(item.date));
        date.dateTime = item.date;
        const reply = element("button", "", "Répondre"); reply.type = "button";
        reply.addEventListener("click", () => {
            replyTo = comments.get(item.id); $("reponseBandeau").hidden = false;
            $("reponsePseudo").textContent = replyTo.pseudo; composer.placeholder = "Ta réponse…"; composer.focus();
        });
        actions.append(date, reply);
        if (item.mine) {
            const remove = element("button", "", "Supprimer"); remove.type = "button";
            remove.addEventListener("click", async () => {
                if (!window.confirm(item.parentId ? "Supprimer ta réponse ?" : "Supprimer ton commentaire et ses réponses ?")) return;
                remove.disabled = true;
                try {
                    const stats = await api("/comments/" + item.id, { method: "DELETE" });
                    updateSocial(stats); cancelReply(); await loadComments(true); toast("Commentaire supprimé");
                } catch (error) { toast(error.message); remove.disabled = false; }
            });
            actions.append(remove);
        }
        body.append(actions);
        const like = element("button", "comment-like"), count = element("span", "", number(item.likes));
        const paint = value => {
            like.classList.toggle("liked", !!value.liked); like.setAttribute("aria-pressed", String(!!value.liked));
            like.setAttribute("aria-label", value.liked ? "Ne plus aimer ce commentaire" : "Aimer ce commentaire"); count.textContent = number(value.likes);
        };
        like.type = "button"; like.append(icon("heart"), count); paint(item);
        like.addEventListener("click", async () => {
            const actual = comments.get(item.id); like.disabled = true;
            try {
                const result = await api("/comments/" + item.id + "/like", { method: actual.liked ? "DELETE" : "PUT" });
                comments.set(item.id, result); paint(result);
            } catch (error) { toast(error.message); }
            finally { like.disabled = false; }
        });
        row.append(avatar, body, like); return row;
    }

    function addThread(item, prepend = false) {
        if (threads.has(item.id)) return;
        const wrapper = element("div", "comment-thread"); wrapper.append(commentRow(item));
        const toggle = element("button", "reply-toggle"), list = element("div", "replies"); list.hidden = true;
        const state = { wrapper, toggle, list, loaded: false, next: null, more: null, loading: false, ids: new Set() };
        threads.set(item.id, state);
        const label = () => {
            const count = comments.get(item.id)?.replyCount || 0;
            toggle.textContent = !list.hidden ? "Masquer les réponses" : count === 1 ? "Voir la réponse" : "Voir les " + number(count) + " réponses";
            toggle.hidden = !count;
        };
        state.label = label; label();
        toggle.addEventListener("click", async () => {
            if (state.loading) return;
            if (!list.hidden) { list.hidden = true; label(); return; }
            list.hidden = false;
            if (!state.loaded) await loadReplies(item.id, state);
            label();
        });
        wrapper.append(toggle, list);
        if (prepend) $("commentairesListe").prepend(wrapper); else $("commentairesListe").append(wrapper);
        return state;
    }
    async function loadReplies(id, state) {
        const generation = commentGeneration;
        state.loading = true; state.toggle.disabled = true;
        if (state.more) state.more.disabled = true;
        try {
            const result = await api("/comments/" + id + "/replies" + (state.next ? "?after=" + state.next : ""));
            if (generation !== commentGeneration || !commentDialog.open) return;
            state.more?.remove();
            for (const reply of result.items) if (!state.ids.has(reply.id)) { state.ids.add(reply.id); state.list.append(commentRow(reply)); }
            state.loaded = true; state.next = result.nextCursor;
            if (state.next) {
                state.more = element("button", "load-comments", "Voir plus de réponses");
                state.more.addEventListener("click", () => loadReplies(id, state)); state.list.append(state.more);
            }
        } catch (error) { toast(error.message); if (!state.loaded) state.list.hidden = true; }
        finally { state.loading = false; state.toggle.disabled = false; if (state.more) state.more.disabled = false; state.label(); }
    }
    async function loadComments(reset = false) {
        if (!commentVideoId || !commentDialog.open) return;
        if (reset) {
            ++commentGeneration; nextCursor = null; comments.clear(); threads.clear();
            $("commentairesListe").replaceChildren(emptyState("On ouvre la conversation…", "Les commentaires arrivent."));
        }
        const generation = commentGeneration, id = commentVideoId;
        const moreButton = $("plusCommentaires"); if (moreButton) moreButton.disabled = true;
        try {
            const result = await api("/videos/" + id + "/comments" + (nextCursor ? "?before=" + nextCursor : ""));
            if (generation !== commentGeneration || !commentDialog.open) return;
            if (reset) $("commentairesListe").replaceChildren();
            moreButton?.remove();
            for (const item of result.items) addThread(item);
            nextCursor = result.nextCursor; $("totalCommentaires").textContent = number(result.total);
            if (!threads.size) $("commentairesListe").append(emptyState("Lance la conversation.", "Une impression, une question, un coup de cœur ? Sois le premier à commenter."));
            if (nextCursor) {
                const more = element("button", "load-comments", "Voir plus de commentaires"); more.id = "plusCommentaires";
                more.addEventListener("click", () => loadComments()); $("commentairesListe").append(more);
            }
        } catch (error) {
            if (generation !== commentGeneration) return;
            if (reset) $("commentairesListe").replaceChildren(emptyState("La conversation attendra un instant.", error.message, true));
            else { toast(error.message); if (moreButton) moreButton.disabled = false; }
        }
    }
    function openComments() {
        if (!current) return;
        if (commentVideoId !== current.id) { composer.value = ""; cancelReply(); }
        commentVideoId = current.id; $("totalCommentaires").textContent = number(current.comments);
        $("erreurCommentaire").textContent = "Un peu de bienveillance, beaucoup d’échanges.";
        $("erreurCommentaire").classList.remove("error"); updateComposer(); show(commentDialog); loadComments(true);
    }
    $("commenter").addEventListener("click", openComments);
    $("ouvrirDiscussion").addEventListener("click", openComments);
    $("commentaireForm").addEventListener("submit", async event => {
        event.preventDefault(); const texte = composer.value.trim();
        if (!texte || posting || !commentVideoId) return;
        const id = commentVideoId, generation = commentGeneration, parentId = replyTo?.id || null;
        posting = true; composer.disabled = true; updateComposer();
        try {
            const result = await api("/videos/" + id + "/comments", { method: "POST", body: JSON.stringify({ texte, parentId }) });
            updateSocial(result.social);
            if (generation !== commentGeneration || !commentDialog.open) { composer.value = ""; cancelReply(); return; }
            $("commentairesListe").querySelector(".comments-empty")?.remove();
            const comment = result.comment;
            if (!comment.parentId) { addThread(comment, true); $("commentairesListe").scrollTop = 0; }
            else {
                const root = comments.get(comment.parentId), thread = threads.get(comment.parentId);
                if (root) root.replyCount++;
                if (thread) {
                    if (thread.loaded && !thread.next) { thread.list.append(commentRow(comment)); thread.ids.add(comment.id); thread.list.hidden = false; }
                    thread.label();
                    if (!thread.loaded) { thread.list.hidden = false; await loadReplies(comment.parentId, thread); }
                }
                toast("Ta réponse a été publiée");
            }
            composer.value = ""; cancelReply();
        } catch (error) { commentError(error.message); }
        finally { posting = false; composer.disabled = false; updateComposer(); }
    });

    function targetForVideo() {
        if (!current) return null;
        const url = new URL("/app/", SV.origin); url.searchParams.set("video", current.id);
        return { id: current.id, title: current.titre, url: url.href, eventId: SV.uuid(), counted: false };
    }
    function openShare(target, message = "") {
        shareTarget = target; $("lienPartage").value = target.url; $("etatPartage").textContent = message;
        $("partageNatif").hidden = !navigator.share; show($("partageDialog"));
    }
    async function countShare(target) {
        if (target.counted) return;
        try {
            const stats = await api("/videos/" + target.id + "/share", { method: "POST", body: JSON.stringify({ eventId: target.eventId }) });
            target.counted = true; updateSocial(stats);
        } catch { toast("Le lien est partagé, mais le compteur n’a pas pu être actualisé."); }
    }
    async function copyShare(target) {
        if (!target) return;
        let copied = false;
        try { await navigator.clipboard.writeText(target.url); copied = true; } catch {
            // Également utilisable sur le réseau local en HTTP et dans la WebView.
            const input = element("textarea"); input.value = target.url;
            input.style.cssText = "position:fixed;left:0;top:0;opacity:0";
            const host = [...document.querySelectorAll("dialog[open]")].at(-1) || document.body;
            host.append(input); input.focus(); input.select();
            try { copied = document.execCommand("copy"); } catch {} input.remove();
        }
        if (copied) {
            toast("Lien copié. À toi de le faire voyager !");
            if ($("partageDialog").open) $("etatPartage").textContent = "Le lien a été copié.";
            await countShare(target);
        } else {
            openShare(target, "Sélectionne et copie le lien ci-dessus."); $("lienPartage").focus(); $("lienPartage").select();
        }
    }
    async function nativeShare(target) {
        if (!target) return;
        if (!navigator.share) { openShare(target); return; }
        try { await navigator.share({ title: target.title, text: "À découvrir sur StreamingVideo", url: target.url }); await countShare(target); }
        catch (error) { if (error.name !== "AbortError") openShare(target, "Choisis de copier le lien pour partager cette vidéo."); }
    }
    $("partager").addEventListener("click", () => nativeShare(targetForVideo()));
    $("copierLien").addEventListener("click", () => {
        $("menuPlus").hidden = true; $("plus").setAttribute("aria-expanded", "false"); copyShare(targetForVideo());
    });
    $("copierPartage").addEventListener("click", () => copyShare(shareTarget));
    $("partageNatif").addEventListener("click", () => nativeShare(shareTarget));
    $("lienPartage").addEventListener("click", () => $("lienPartage").select());
    setInterval(refreshSocial, 20000);
    renderSocial();
});
