"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const db = require("../config/db");
const { app } = require("../server");
const { initialiserSocial } = require("../services/social");
const tokenA = randomUUID(), tokenB = randomUUID(), videoId = randomUUID(), otherVideoId = randomUUID();
let server, base, rootId, replyId, profileA, schemaReady = false;
let uploadedId = null, testSource = null;

async function request(path, method = "GET", body, token = tokenA) {
    const response = await fetch(base + path, {
        method, headers: { ...(token ? { "X-Visitor-Token": token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json() };
}
before(async () => {
    await initialiserSocial(db);
    schemaReady = true;
    await db.query("INSERT INTO public.videos (id, titre, statut, chemin_hls) VALUES ($1, 'Test interactions', 'prete', '/hls/test/master.m3u8'), ($2, 'Autre test', 'prete', '/hls/test/master.m3u8')", [videoId, otherVideoId]);
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    base = "http://127.0.0.1:" + server.address().port + "/api";
});
after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    try {
        if (schemaReady) {
            await db.query("DELETE FROM public.videos WHERE id = ANY($1::uuid[])", [[videoId, otherVideoId, uploadedId].filter(Boolean)]);
            const hashes = [tokenA, tokenB].map(token => createHash("sha256").update(token).digest("hex"));
            await db.query("DELETE FROM public.stream_profiles WHERE token_hash = ANY($1::text[])", [hashes]);
            if (uploadedId) {
                const storage = path.resolve(__dirname, "../storage") + path.sep;
                for (const target of [path.resolve(storage, "videos", uploadedId), path.resolve(storage, "originaux", uploadedId + ".mp4")]) {
                    if (!target.startsWith(storage)) throw new Error("Nettoyage hors du stockage refusé.");
                    await fs.rm(target, { recursive: true, force: true });
                }
            }
            if (testSource) await fs.unlink(testSource).catch(() => {});
        }
    } finally { await db.end(); }
});

test("le profil conserve son identité et son pseudo, sans publier son secret", async () => {
    const first = await request("/profile"); profileA = first.data.id;
    assert.equal(first.status, 200); assert.ok(first.data.pseudo); assert.equal(first.data.token_hash, undefined);
    const changed = await request("/profile", "PATCH", { pseudo: "Créateur test" });
    assert.equal(changed.data.pseudo, "Créateur test");
    assert.equal((await request("/profile")).data.id, profileA);
    assert.equal((await request("/profile", "PATCH", { pseudo: "x" })).status, 400);
    assert.equal((await request("/profile", "GET", undefined, null)).status, 401);
});
test("likes persistants, idempotents et propres à chaque appareil", async () => {
    assert.equal((await request(`/videos/${videoId}/like`, "PUT")).data.likes, 1);
    assert.equal((await request(`/videos/${videoId}/like`, "PUT")).data.likes, 1);
    assert.equal((await request(`/videos/${videoId}/social`, "GET", undefined, tokenB)).data.liked, false);
    assert.equal((await request(`/videos/${videoId}/like`, "PUT", undefined, tokenB)).data.likes, 2);
    const list = (await request("/videos")).data.find(item => item.id === videoId);
    assert.equal(list.likes, 2); assert.equal(list.liked, true);
    assert.equal((await request(`/videos/${videoId}/like`, "DELETE")).data.likes, 1);
    assert.equal((await request(`/videos/${videoId}/like`, "DELETE")).data.likes, 1);
    assert.equal((await request(`/videos/${videoId}/like`, "PUT", undefined, null)).status, 401);
});
test("les favoris sont enregistrés et peuvent être retirés", async () => {
    assert.equal((await request(`/videos/${videoId}/save`, "PUT")).data.saved, true);
    assert.equal((await request(`/videos/${videoId}/save`, "PUT")).data.saved, true);
    assert.equal((await request("/profile")).data.saves, 1);
    assert.equal((await request(`/videos/${videoId}/save`, "DELETE")).data.saved, false);
});
test("commentaires, réponses à un commentaire et réponses à une réponse", async () => {
    const root = await request(`/videos/${videoId}/comments`, "POST", { texte: "Très belle vidéo <script>alert(1)</script>" });
    assert.equal(root.status, 201); rootId = root.data.comment.id;
    assert.equal(root.data.comment.authorId, profileA); assert.equal(root.data.comment.mine, true);
    const reply = await request(`/videos/${videoId}/comments`, "POST", { texte: "Merci !", parentId: rootId }, tokenB);
    assert.equal(reply.status, 201); replyId = reply.data.comment.id; assert.equal(reply.data.comment.parentId, rootId);
    const nested = await request(`/videos/${videoId}/comments`, "POST", { texte: "Avec plaisir", parentId: replyId });
    assert.equal(nested.data.comment.parentId, rootId); assert.ok(nested.data.comment.replyTo);
    const roots = await request(`/videos/${videoId}/comments`);
    assert.equal(roots.data.items.length, 1); assert.equal(roots.data.items[0].replyCount, 2); assert.equal(roots.data.total, 3);
    const replies = await request(`/comments/${rootId}/replies`);
    assert.deepEqual(replies.data.items.map(item => item.texte), ["Merci !", "Avec plaisir"]);
    assert.equal((await request(`/videos/${otherVideoId}/comments`, "POST", { texte: "Hors sujet", parentId: rootId })).status, 404);
});
test("les likes de commentaires ne se dupliquent pas", async () => {
    const path = `/comments/${rootId}/like`;
    assert.equal((await request(path, "PUT", undefined, tokenB)).data.likes, 1);
    assert.equal((await request(path, "PUT", undefined, tokenB)).data.likes, 1);
    assert.equal((await request(path, "DELETE", undefined, tokenB)).data.likes, 0);
});
test("les entrées invalides sont refusées sans modifier les compteurs", async () => {
    assert.equal((await request("/videos/pas-un-uuid/comments")).status, 400);
    assert.equal((await request(`/videos/${randomUUID()}/like`, "PUT")).status, 404);
    for (const texte of ["  ", "a".repeat(1001), "nul\u0000"]) {
        assert.equal((await request(`/videos/${videoId}/comments`, "POST", { texte })).status, 400);
    }
    assert.equal((await request(`/videos/${videoId}/comments?before=incorrect`)).status, 400);
    assert.equal((await request(`/videos/${videoId}/comments`, "POST")).status, 400);
    assert.equal((await request(`/videos/${videoId}/share`, "POST")).status, 400);
    assert.equal((await request("/profile", "PATCH")).status, 400);
});
test("un événement de partage n'est compté qu'une fois", async () => {
    const eventId = randomUUID();
    assert.equal((await request(`/videos/${videoId}/share`, "POST", { eventId })).data.shares, 1);
    assert.equal((await request(`/videos/${videoId}/share`, "POST", { eventId })).data.shares, 1);
    assert.equal((await request(`/videos/${videoId}/share`, "POST", { eventId: randomUUID() })).data.shares, 2);
});
test("seul l'auteur supprime son commentaire ; ses réponses et likes sont nettoyés", async () => {
    assert.equal((await request(`/comments/${rootId}`, "DELETE", undefined, tokenB)).status, 404);
    assert.equal((await request(`/comments/${rootId}`, "DELETE")).data.comments, 0);
    assert.equal((await request(`/comments/${rootId}/replies`)).status, 404);
});
test("pagination stable même quand plusieurs commentaires ont exactement la même date", async () => {
    await db.query(`INSERT INTO public.video_comments (id, video_id, profile_id, texte, created_at)
        SELECT gen_random_uuid(), $1, $2, 'Page ' || n, '2026-01-01T00:00:00Z' FROM generate_series(1, 23) n`, [videoId, profileA]);
    const first = (await request(`/videos/${videoId}/comments`)).data;
    assert.equal(first.items.length, 20); assert.ok(first.nextCursor);
    const second = (await request(`/videos/${videoId}/comments?before=${first.nextCursor}`)).data;
    assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 23);
});

test("une vraie publication conserve le titre, la description et l'auteur, puis produit HLS et miniature", async () => {
    const temporary = path.resolve(__dirname, "../../.tmp");
    await fs.mkdir(temporary, { recursive: true });
    testSource = path.join(temporary, "publication-" + randomUUID() + ".mp4");
    await promisify(execFile)(require("ffmpeg-static"), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "color=c=0xff715b:s=180x320:r=15:d=0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", testSource], { windowsHide: true });
    const form = new FormData();
    form.append("titre", "Une publication de test"); form.append("description", "Un instant enregistré par les tests.");
    form.append("video", new Blob([await fs.readFile(testSource)], { type: "video/mp4" }), "capture.mp4");
    const response = await fetch(base + "/videos", { method: "POST", headers: { "X-Visitor-Token": tokenA }, body: form });
    const result = await response.json(); uploadedId = result.id;
    assert.equal(response.status, 202); assert.ok(uploadedId);
    let video;
    const start = Date.now();
    do {
        await new Promise(resolve => setTimeout(resolve, 150));
        video = (await request("/videos/" + uploadedId)).data;
    } while (video.statut !== "prete" && video.statut !== "erreur" && Date.now() - start < 20000);
    assert.equal(video.statut, "prete", video.erreur);
    assert.equal(video.titre, "Une publication de test");
    assert.equal(video.description, "Un instant enregistré par les tests."); assert.equal(video.authorId, profileA);
    const origin = base.replace(/\/api$/, "");
    assert.equal((await fetch(origin + video.url_hls)).status, 200);
    const thumbnail = await fetch(origin + video.poster);
    assert.equal(thumbnail.status, 200); assert.ok(thumbnail.headers.get("content-type").includes("image/jpeg"));
});
