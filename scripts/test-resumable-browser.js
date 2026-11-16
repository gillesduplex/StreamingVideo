"use strict";

// Vérifie IndexedDB et la copie navigateur avec un vrai Chrome et un profil isolé.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const express = require("../backend/node_modules/express");
const { creerUploads } = require("../backend/services/resumableUploads");

const root = path.resolve(__dirname, "..");
const tempRoot = path.resolve(root, ".tmp");
const profile = path.resolve(tempRoot, "resumable-chrome-" + randomUUID());
const fixture = path.resolve(tempRoot, "resumable-files-" + randomUUID());
const fixtureSource = path.join(fixture, "vacances.mp4");
const testId = randomUUID();
const contents = "La vidéo est conservée pour reprendre après une fermeture.";
let server, browser, ws, session, sequence = 0;
const waiting = new Map();
const profiles = new Map(), videos = new Map(), queued = [];
let patchCount = 0, heldCount = 0, holdSecond = true, heldRequest, patchRequests = [];
const db = { async query(sql, args = []) {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (/^INSERT INTO (?:public\.)?videos\b/i.test(query)) {
        const [id, titre, taille_originale, chemin_original, auteur_id, description] = args;
        if (!videos.has(id)) videos.set(id, { id, titre, taille_originale, chemin_original, auteur_id, description, statut: "en_attente", message_erreur: null });
        return { rows: [], rowCount: 1 };
    }
    if (/^SELECT\b.+\bFROM (?:public\.)?videos\b/i.test(query)) {
        const video = videos.get(args[0]); return { rows: video ? [video] : [], rowCount: video ? 1 : 0 };
    }
    throw new Error("Requête SQL de test non prise en charge : " + query);
} };

async function startBrowser(origin, page = "/fixture") {
    const candidates = [process.env.CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
    let executable;
    for (const candidate of candidates) { try { await fs.access(candidate); executable = candidate; break; } catch {} }
    assert.ok(executable, "Chrome ou Edge est requis, ou définir CHROME_PATH.");
    browser = spawn(executable, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--user-data-dir=" + profile, "about:blank"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Chrome n'a pas ouvert DevTools.")), 15000);
        browser.once("error", error => { clearTimeout(timer); reject(error); });
        browser.stderr.on("data", chunk => {
            output += chunk.toString();
            const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        browser.once("exit", code => { clearTimeout(timer); reject(new Error("Chrome s'est arrêté : " + code)); });
    });
    ws = new WebSocket(endpoint);
    await once(ws, "open");
    ws.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (!message.id || !waiting.has(message.id)) return;
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
    });
    const target = await send("Target.createTarget", { url: "about:blank" }, false);
    session = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false)).sessionId;
    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send("Page.navigate", { url: origin + page });
    const start = Date.now();
    while (!(await evaluate("typeof SVUploadStore !== 'undefined' && typeof SVUploadFile !== 'undefined'"))) {
        if (Date.now() - start > 12000) throw new Error("Modules de stockage indisponibles.");
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

function send(method, params = {}, withSession = true) {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error("Délai DevTools : " + method)); }, 20000);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(withSession && session ? { sessionId: session } : {}) }));
    });
}

async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
}

async function stopBrowser() {
    if (!browser) return;
    if (ws?.readyState === WebSocket.OPEN) {
        await send("Browser.close", {}, false).catch(() => {});
        ws.close();
    }
    if (browser.exitCode === null) await Promise.race([once(browser, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (browser.exitCode === null) { browser.kill(); await once(browser, "exit"); }
    browser = null; ws = null; session = null;
}

async function main() {
    assert.ok(profile.startsWith(tempRoot + path.sep));
    assert.ok(fixture.startsWith(tempRoot + path.sep));
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(fixture, { recursive: true });
    const app = express();
    app.use(express.json({ limit: "16kb" }));
    app.use("/api", (req, res, next) => {
        const token = req.get("X-Visitor-Token");
        if (!token) return res.status(401).json({ message: "Profil absent." });
        if (!profiles.has(token)) profiles.set(token, { id: randomUUID(), pseudo: "Test" });
        req.profile = profiles.get(token); next();
    });
    app.get("/api/profile", (req, res) => res.json(req.profile));
    app.get("/api/videos/:id", (req, res) => res.json({ id: req.params.id, statut: "prete" }));
    app.use("/api/uploads", (req, res, next) => {
        if (req.method === "PATCH") {
            patchCount++;
            patchRequests.push({ offset: Number(req.get("Upload-Offset")), size: Number(req.get("Content-Length")) });
            if (holdSecond && patchCount === 2) { heldCount++; heldRequest = req; req.on("close", () => {}); return; }
        }
        next();
    });
    app.use("/api/uploads", creerUploads({ db, temporaires: path.join(fixture, "uploads"), originauxDir: path.join(fixture, "originaux"),
        enqueue: (id, source) => queued.push({ id, source }) }));
    app.get("/app/cordova.js", (req, res) => res.type("application/javascript").send("// Cordova non nécessaire au test navigateur."));
    app.use("/app", express.static(path.join(root, "www")));
    app.get("/fixture", (req, res) => res.type("html").send("<!doctype html><meta charset=utf-8><script src='/js/upload-store.js'></script><script src='/js/upload-file.js'></script>"));
    app.use(express.static(path.join(root, "www")));
    app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;

    await startBrowser(origin);
    const prepared = await evaluate(`(async () => {
        const id = ${JSON.stringify(testId)};
        const text = ${JSON.stringify(contents)};
        const file = new File([text], "vacances.mp4", { type: "video/mp4" });
        const source = await SVUploadFile.persist(file, id);
        await SVUploadStore.put({ id, source, title: "Vacances", offset: 12, state: "interrupted" });
        const slice = await SVUploadFile.read(source, 0, 12);
        return { size: source.size, kind: source.kind, start: new TextDecoder().decode(slice) };
    })()`);
    assert.equal(prepared.kind, "blob");
    assert.equal(prepared.start, Buffer.from(contents).subarray(0, 12).toString("utf8"));
    assert.equal(prepared.size, Buffer.byteLength(contents));

    // Fermeture et réouverture réelles du navigateur, même profil et même origine.
    await stopBrowser();
    await startBrowser(origin);
    const restored = await evaluate(`(async () => {
        const item = await SVUploadStore.get(${JSON.stringify(testId)});
        const bytes = await SVUploadFile.read(item.source, 0, item.source.size);
        return { title: item.title, offset: item.offset, state: item.state, text: new TextDecoder().decode(bytes) };
    })()`);
    assert.deepEqual(restored, { title: "Vacances", offset: 12, state: "interrupted", text: contents });
    console.log("OK : fiche IndexedDB et vidéo Web retrouvées après fermeture et réouverture réelles de Chrome.");

    const removed = await evaluate(`(async () => {
        const id = ${JSON.stringify(testId)};
        const record = await SVUploadStore.get(id);
        await SVUploadFile.remove(record.source);
        await SVUploadStore.remove(id);
        return { record: (await SVUploadStore.get(id)) || null, blob: await SVUploadStore.getBlob(id) };
    })()`);
    assert.deepEqual(removed, { record: null, blob: null });
    console.log("OK : suppression de la copie de travail et de la fiche locale.");

    // Une vidéo fictive de plusieurs blocs suffit pour tester le transfert brut ;
    // aucun FFmpeg ni donnée de la base de l'utilisateur n'intervient.
    const payload = Buffer.alloc(13 * 1024 * 1024 + 12345);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 13) % 251;
    await fs.writeFile(fixtureSource, payload);
    await stopBrowser();
    await startBrowser(origin, "/app/upload.html");
    await until("!!document.getElementById('retournerBas') && (document.getElementById('camera').srcObject !== null || !document.getElementById('reessayer').hidden)", "initialisation du studio");
    const documentNode = await send("DOM.getDocument");
    const input = await send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: "#fichier" });
    await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [fixtureSource] });
    await until("!document.getElementById('commandesApercu').hidden", "aperçu du fichier sélectionné");
    await evaluate("document.getElementById('envoyer').click()");
    await until("(await SVUploadStore.list()).some(item => item.state === 'uploading' && item.offset >= 5242880)", "premier bloc confirmé", 30000);
    const waitHeld = Date.now();
    while (!heldCount && Date.now() - waitHeld < 10000) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(heldCount, 1, "Le deuxième bloc est réellement en attente sur le serveur de test.");

    // Pendant le transfert réel retenu, préparer une autre vidéo sans perdre
    // la session en cours ni le brouillon lors du passage entre les deux vues.
    const beforeDraft = await evaluate("(async()=>{const item=(await SVUploadStore.list())[0];return {id:item.id,offset:item.offset,sessionId:item.sessionId}})()");
    const secondSource = path.join(fixture, "autre-video.mp4");
    await fs.writeFile(secondSource, Buffer.from("Une seconde vidéo de démonstration."));
    assert.equal(await evaluate("!document.getElementById('nouvellePublication').hidden && getComputedStyle(document.getElementById('nouvellePublication')).display !== 'none'"), true, "On peut créer une autre publication pendant l'envoi.");
    await evaluate("document.getElementById('nouvellePublication').click()");
    await until("!document.body.classList.contains('publication-en-cours')", "retour au studio pendant l'envoi");
    const draftInput = await send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: "#fichier" });
    await send("DOM.setFileInputFiles", { nodeId: draftInput.nodeId, files: [secondSource] });
    await until("!document.getElementById('commandesApercu').hidden && document.getElementById('nomFichier').textContent.includes('autre-video.mp4')", "aperçu de la deuxième vidéo");
    await evaluate("document.getElementById('titrePublication').value='Mon deuxième brouillon'; document.getElementById('descriptionPublication').value='À conserver pendant le suivi';");
    assert.equal(await evaluate("!document.getElementById('suivrePublications').hidden"), true, "Le suivi est accessible depuis le brouillon.");
    await evaluate("document.getElementById('suivrePublications').click()");
    await until("document.body.classList.contains('publication-en-cours') && !document.getElementById('transfert').hidden", "suivi pendant le brouillon");
    const afterDraft = await evaluate("(async()=>{const items=await SVUploadStore.list();const item=items[0];return {count:items.length,id:item.id,offset:item.offset,sessionId:item.sessionId}})()");
    assert.deepEqual(afterDraft, { count: 1, ...beforeDraft }, "Le brouillon ne lance pas d'envoi et la session continue à la même position confirmée.");
    await evaluate("document.getElementById('nouvellePublication').click()");
    await until("!document.body.classList.contains('publication-en-cours')", "réouverture du brouillon");
    const draft = await evaluate("({shown:!document.getElementById('commandesApercu').hidden,name:document.getElementById('nomFichier').textContent,title:document.getElementById('titrePublication').value,description:document.getElementById('descriptionPublication').value})");
    assert.equal(draft.shown, true);
    assert.match(draft.name, /autre-video\.mp4/);
    assert.equal(draft.title, "Mon deuxième brouillon");
    assert.equal(draft.description, "À conserver pendant le suivi");
    await evaluate("document.getElementById('suivrePublications').click()");
    await until("document.body.classList.contains('publication-en-cours')", "retour au suivi initial");
    console.log("OK : un brouillon reste disponible pendant l'envoi d'une autre vidéo et après consultation du suivi.");

    await evaluate("document.querySelector('#transfertListe .pause').click()");
    await until("(await SVUploadStore.list()).some(item => item.state === 'paused')", "pause persistée");
    const paused = await evaluate("(async()=>{const item=(await SVUploadStore.list())[0];return {id:item.id,sessionId:item.sessionId,offset:item.offset,token:SV.token}})()");
    assert.equal(paused.offset, 5 * 1024 * 1024);
    assert.equal(patchRequests[0].size, 5 * 1024 * 1024, "Le premier bloc contient 5 Mio.");
    const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await fs.mkdir(path.join(root, ".artifacts", "qa"), { recursive: true });
    await fs.writeFile(path.join(root, ".artifacts", "qa", "resumable-pause.png"), Buffer.from(screenshot.data, "base64"));
    await stopBrowser();
    holdSecond = false;
    await startBrowser(origin, "/app/upload.html");
    await until("document.querySelector('#transfertListe .continuer') && !document.querySelector('#transfertListe .continuer').hidden", "reprise proposée après fermeture");
    const reopened = await evaluate("(async()=>{const item=(await SVUploadStore.list())[0];return {id:item.id,sessionId:item.sessionId,offset:item.offset,selected:document.getElementById('fichier').files.length,token:SV.token}})()");
    assert.equal(reopened.id, paused.id);
    assert.equal(reopened.sessionId, paused.sessionId);
    assert.equal(reopened.offset, paused.offset);
    assert.equal(reopened.selected, 0, "La vidéo ne doit pas être resélectionnée.");
    assert.equal(reopened.token, paused.token, "L'identité locale reste la même à la réouverture.");
    await evaluate("document.querySelector('#transfertListe .continuer').click()");
    await until("document.querySelector('#transfertListe .etat')?.textContent === 'Vidéo publiée'", "publication reprise", 20000);
    assert.equal(queued.length, 1);
    assert.deepEqual(await fs.readFile(queued[0].source), payload, "Le serveur reçoit exactement les octets de la vidéo d'origine.");
    assert.ok(patchRequests.every(item => item.size <= 8 * 1024 * 1024 &&
        (item.size >= 5 * 1024 * 1024 || item.offset + item.size === payload.length)),
    "Les blocs font entre 5 et 8 Mio, sauf le dernier : " + JSON.stringify(patchRequests));
    assert.equal(await evaluate("(async()=> (await SVUploadStore.list()).length)()"), 0, "La copie de travail et sa fiche sont nettoyées après publication.");
    console.log("OK : dépôt réel, blocs de 5 à 8 Mio, pause, fermeture de Chrome, reprise sans resélection et octets vérifiés.");

    async function startAnotherUpload() {
        await stopBrowser();
        patchCount = 0; heldCount = 0; heldRequest = null; holdSecond = true; queued.length = 0; patchRequests = [];
        await startBrowser(origin, "/app/upload.html");
        await until("!!document.getElementById('retournerBas') && (document.getElementById('camera').srcObject !== null || !document.getElementById('reessayer').hidden)", "initialisation du studio");
        const documentNode = await send("DOM.getDocument");
        const input = await send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: "#fichier" });
        await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [fixtureSource] });
        await until("!document.getElementById('commandesApercu').hidden", "aperçu d'une nouvelle vidéo");
        await evaluate("document.getElementById('envoyer').click()");
        await until("(await SVUploadStore.list()).some(item => item.state === 'uploading' && item.offset >= 5242880)", "premier bloc confirmé", 30000);
        const start = Date.now();
        while (!heldCount && Date.now() - start < 10000) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(heldCount, 1, "Le deuxième bloc est retenu pour provoquer l'interruption.");
        return evaluate("(async()=>{const item=(await SVUploadStore.list())[0];return {id:item.id,sessionId:item.sessionId,offset:item.offset}})()");
    }

    const beforeClose = await startAnotherUpload();
    assert.equal(beforeClose.offset, 5 * 1024 * 1024);
    // Simule une fermeture brutale : aucun clic sur Pause ni sauvegarde manuelle.
    browser.kill();
    if (browser.exitCode === null) await once(browser, "exit");
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    browser = null; ws = null; session = null;
    holdSecond = false;
    await startBrowser(origin, "/app/upload.html");
    assert.equal(await evaluate("document.getElementById('fichier').files.length"), 0);
    await until("document.querySelector('#transfertListe .etat')?.textContent === 'Vidéo publiée'", "reprise automatique après fermeture brutale", 20000);
    assert.equal(queued.length, 1);
    assert.deepEqual(await fs.readFile(queued[0].source), payload);
    console.log("OK : fermeture brutale sans Pause, reprise automatique sans resélection et octets finaux identiques.");

    await startAnotherUpload();
    await send("Network.enable");
    await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    heldRequest.destroy();
    await until("(await SVUploadStore.list()).some(item => item.state === 'interrupted')", "coupure réseau persistée");
    assert.equal(await evaluate("navigator.onLine"), false);
    holdSecond = false;
    await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await until("document.querySelector('#transfertListe .etat')?.textContent === 'Vidéo publiée'", "reprise automatique après retour réseau", 20000);
    assert.equal(queued.length, 1);
    assert.deepEqual(await fs.readFile(queued[0].source), payload);
    console.log("OK : coupure réseau, retour de connexion et reprise automatique jusqu'à publication.");
}

async function until(expression, label, timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await evaluate("(async()=>!!(" + expression + "))()")) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const state = await evaluate("({etat:document.querySelector('#transfertListe .etat')?.textContent,records:document.querySelector('#transfertListe .transfert-details')?.textContent})").catch(() => null);
    throw new Error("Attente échouée : " + label + " " + JSON.stringify(state));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    await stopBrowser();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(profile).startsWith(path.resolve(tempRoot) + path.sep), "Nettoyage limité au profil de test.");
    assert.ok(path.resolve(fixture).startsWith(path.resolve(tempRoot) + path.sep), "Nettoyage limité aux fichiers de test.");
    await fs.rm(profile, { recursive: true, force: true });
    await fs.rm(fixture, { recursive: true, force: true });
});
