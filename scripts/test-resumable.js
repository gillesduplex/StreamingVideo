"use strict";

// Tests HTTP isolés : aucun accès à la base ni aux vidéos de l'utilisateur.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const express = require("../backend/node_modules/express");
const { creerUploads } = require("../backend/services/resumableUploads");

const workspace = path.resolve(__dirname, "..");
const tempRoot = path.resolve(workspace, ".tmp");
const fixture = path.resolve(tempRoot, "resumable-test-" + randomUUID());
const uploads = path.join(fixture, "uploads");
const originaux = path.join(fixture, "originaux");
const owner = { id: randomUUID() };
const other = { id: randomUUID() };
const tokenOwner = randomUUID();
const tokenOther = randomUUID();
const videos = new Map();
const queued = [];
let server, base, uploadRouter, completedVideoId;

// Seules les opérations vidéo attendues sont acceptées : aucune base réelle.
const db = {
    async query(sql, args = []) {
        const query = String(sql).replace(/\s+/g, " ").trim();
        if (/^INSERT INTO (?:public\.)?videos\b/i.test(query)) {
            const [id, titre, taille_originale, chemin_original, auteur_id, description] = args;
            if (!videos.has(id)) videos.set(id, { id, titre, taille_originale, chemin_original, auteur_id, description, statut: "en_attente", message_erreur: null });
            return { rows: [], rowCount: 1 };
        }
        if (/^SELECT\b.+\bFROM (?:public\.)?videos\b/i.test(query)) {
            const video = videos.get(args[0]);
            return { rows: video ? [video] : [], rowCount: video ? 1 : 0 };
        }
        if (/^UPDATE (?:public\.)?videos\b/i.test(query)) {
            const video = videos.get(args[0]);
            if (video) { video.statut = "en_attente"; video.message_erreur = null; }
            return { rows: [], rowCount: video ? 1 : 0 };
        }
        throw new Error("Requête SQL de test non prise en charge : " + query);
    }
};

async function start() {
    const app = express();
    app.use(express.json({ limit: "16kb" }));
    app.use((req, res, next) => {
        const token = req.get("X-Visitor-Token");
        req.profile = token === tokenOwner ? owner : token === tokenOther ? other : null;
        next();
    });
    uploadRouter = creerUploads({
        db, temporaires: uploads, originauxDir: originaux,
        enqueue: (id, source) => { queued.push({ id, source }); }
    });
    app.use("/api/uploads", uploadRouter);
    app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = "http://127.0.0.1:" + server.address().port + "/api/uploads";
}

async function stop() {
    if (!server) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = null;
}

async function request(suffix = "", { method = "GET", token = tokenOwner, json, bytes, offset } = {}) {
    const headers = {};
    if (token) headers["X-Visitor-Token"] = token;
    if (json !== undefined) headers["Content-Type"] = "application/json";
    if (bytes !== undefined) headers["Content-Type"] = "application/octet-stream";
    if (offset !== undefined) headers["Upload-Offset"] = String(offset);
    const response = await fetch(base + suffix, {
        method, headers,
        body: json !== undefined ? JSON.stringify(json) : bytes
    });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    return { status: response.status, body, headers: response.headers };
}

async function create(size, filename = "essai.mp4") {
    const result = await request("", { method: "POST", json: { clientId: randomUUID(), filename, size, title: "Essai", description: "Vidéo de test" } });
    assert.ok([200, 201].includes(result.status), JSON.stringify(result));
    assert.ok(result.body.id, "La session possède un identifiant.");
    assert.equal(Number(result.body.offset), 0);
    return result.body;
}

before(async () => {
    assert.ok(fixture.startsWith(tempRoot + path.sep), "Le dossier de test doit rester dans l'espace de travail.");
    await fs.mkdir(uploads, { recursive: true });
    await fs.mkdir(originaux, { recursive: true });
    await start();
});

after(async () => {
    await stop();
    // On vérifie à nouveau la cible avant tout nettoyage récursif sur Windows.
    assert.ok(path.resolve(fixture).startsWith(path.resolve(tempRoot) + path.sep));
    await fs.rm(fixture, { recursive: true, force: true });
});

test("validation de la taille, du nom et du propriétaire", async () => {
    for (const size of [0, -1, 2 * 1024 ** 3 + 1]) {
        const result = await request("", { method: "POST", json: { clientId: randomUUID(), filename: "test.mp4", size, title: "Test" } });
        assert.ok(result.status >= 400 && result.status < 500, "Taille refusée : " + JSON.stringify(result));
    }
    const anonymous = await request("", { method: "POST", token: null, json: { clientId: randomUUID(), filename: "test.mp4", size: 12, title: "Test" } });
    assert.ok([401, 403].includes(anonymous.status), "Une session exige un profil.");
    const session = await create(12);
    const forbidden = await request("/" + session.id, { token: tokenOther });
    assert.ok([403, 404].includes(forbidden.status), "Un autre profil ne peut pas consulter la session.");
});

test("reprend depuis la position confirmée après redémarrage et refuse les offsets périmés", async () => {
    const source = Buffer.from("abcdefghij");
    const session = await create(source.length);
    let sent = await request("/" + session.id, { method: "PATCH", bytes: source.subarray(0, 4), offset: 0 });
    assert.ok([200, 204].includes(sent.status), JSON.stringify(sent));
    let state = await request("/" + session.id);
    assert.equal(Number(state.body.offset), 4);

    await stop(); await start();
    state = await request("/" + session.id);
    assert.equal(Number(state.body.offset), 4, "La position survit à la recréation du serveur.");
    const stale = await request("/" + session.id, { method: "PATCH", bytes: source.subarray(0, 4), offset: 0 });
    assert.equal(stale.status, 409, "Un bloc déjà confirmé ne doit jamais être ajouté deux fois.");
    state = await request("/" + session.id);
    assert.equal(Number(state.body.offset), 4);

    sent = await request("/" + session.id, { method: "PATCH", bytes: source.subarray(4), offset: 4 });
    assert.ok([200, 204].includes(sent.status), JSON.stringify(sent));
    state = await request("/" + session.id);
    assert.equal(Number(state.body.offset), source.length);
    const finished = await request("/" + session.id + "/complete", { method: "POST" });
    assert.ok([200, 201, 202].includes(finished.status), JSON.stringify(finished));
    assert.ok(finished.body.videoId, "Une vidéo est associée à la session terminée.");
    completedVideoId = finished.body.videoId;
    const again = await request("/" + session.id + "/complete", { method: "POST" });
    assert.equal(again.body.videoId, finished.body.videoId, "La finalisation est idempotente.");
    assert.equal(queued.filter(item => item.id === finished.body.videoId).length, 1, "Une seule conversion est lancée.");
    const original = queued.find(item => item.id === finished.body.videoId).source;
    assert.deepEqual(await fs.readFile(original), source, "Le fichier assemblé est exactement le fichier envoyé.");
});

test("finalisation incomplète, accès tiers et blocs simultanés ne corrompent pas le fichier", async () => {
    const session = await create(8);
    const incomplete = await request("/" + session.id + "/complete", { method: "POST" });
    assert.ok([400, 409].includes(incomplete.status), "La session incomplète ne peut pas être publiée.");
    const foreign = await request("/" + session.id, { method: "PATCH", token: tokenOther, bytes: Buffer.from("xxxx"), offset: 0 });
    assert.ok([403, 404].includes(foreign.status));
    const sends = await Promise.all([
        request("/" + session.id, { method: "PATCH", bytes: Buffer.from("abcd"), offset: 0 }),
        request("/" + session.id, { method: "PATCH", bytes: Buffer.from("ABCD"), offset: 0 })
    ]);
    assert.equal(sends.filter(item => [200, 204].includes(item.status)).length, 1, "Un seul bloc concurrent est confirmé.");
    assert.equal(sends.filter(item => item.status === 409).length, 1, "Le second bloc concurrent est refusé.");
    const state = await request("/" + session.id);
    assert.equal(Number(state.body.offset), 4);
});

test("un bloc interrompu n'avance pas la position et peut être renvoyé", async () => {
    const session = await create(16);
    await new Promise(resolve => {
        const req = http.request(base + "/" + session.id, {
            method: "PATCH",
            headers: { "X-Visitor-Token": tokenOwner, "Upload-Offset": "0", "Content-Type": "application/octet-stream", "Content-Length": "16" }
        });
        req.on("error", () => {});
        req.write(Buffer.from("abc"));
        setTimeout(() => { req.destroy(); resolve(); }, 50);
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    const state = await request("/" + session.id);
    assert.equal(Number(state.body.offset), 0, "Un bloc reçu partiellement ne doit pas être confirmé.");
    const resent = await request("/" + session.id, { method: "PATCH", bytes: Buffer.from("abcdefghijklmnop"), offset: 0 });
    assert.ok([200, 204].includes(resent.status), JSON.stringify(resent));
    assert.equal(Number((await request("/" + session.id)).body.offset), 16);
});

test("un arrêt entre écriture et confirmation tronque les octets non confirmés", async () => {
    const source = Buffer.from("abcdefgh");
    const session = await create(source.length);
    assert.equal((await request("/" + session.id, { method: "PATCH", bytes: source.subarray(0, 4), offset: 0 })).status, 200);
    const partial = path.join(uploads, "reprises", session.id + ".part");
    await fs.appendFile(partial, "OCTETS NON CONFIRMÉS");
    await stop(); await start();
    const state = await request("/" + session.id);
    assert.equal(Number(state.body.offset), 4);
    assert.equal((await fs.stat(partial)).size, 4, "Le fichier partiel revient au dernier offset confirmé.");
    assert.equal((await request("/" + session.id, { method: "PATCH", bytes: source.subarray(4), offset: 4 })).status, 200);
    const done = await request("/" + session.id + "/complete", { method: "POST" });
    assert.equal(done.status, 200);
    assert.deepEqual(await fs.readFile(queued.find(item => item.id === done.body.videoId).source), source);
});

test("les blocs hors limites et les offsets invalides ne sont pas enregistrés", async () => {
    const session = await create(9 * 1024 * 1024);
    const missingOffset = await request("/" + session.id, { method: "PATCH", bytes: Buffer.from("a") });
    assert.equal(missingOffset.status, 400);
    const oversized = await request("/" + session.id, { method: "PATCH", bytes: Buffer.alloc(8 * 1024 * 1024 + 1), offset: 0 });
    assert.equal(oversized.status, 413);
    assert.equal(Number((await request("/" + session.id)).body.offset), 0);
});

test("récupère uniquement les conversions qui étaient en attente au redémarrage", async () => {
    const video = videos.get(completedVideoId);
    assert.ok(video);
    video.statut = "erreur";
    video.message_erreur = "Mise en attente interrompue par le serveur.";
    const before = queued.filter(item => item.id === video.id).length;
    await stop(); await start();
    await uploadRouter.recover();
    assert.equal(video.statut, "en_attente");
    assert.equal(queued.filter(item => item.id === video.id).length, before + 1);
    await uploadRouter.recover();
    assert.equal(queued.filter(item => item.id === video.id).length, before + 1, "La récupération n'enfile pas deux fois le même travail.");

    video.statut = "erreur";
    video.message_erreur = "Traitement interrompu par le serveur.";
    await uploadRouter.recover();
    assert.equal(video.statut, "erreur", "Un encodage qui tournait n'est pas relancé automatiquement.");
    assert.equal(queued.filter(item => item.id === video.id).length, before + 1);
});
