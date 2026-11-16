"use strict";

// Navigateur et serveur isolés : ne consulte et ne modifie aucune base réelle.
// SV_TEST_NO_SANDBOX=1 est réservé à un environnement de test restreint.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const express = require("../backend/node_modules/express");

const root = path.resolve(__dirname, "..");
const tmp = path.resolve(root, ".tmp");
const profile = path.join(tmp, "feed-browser-" + randomUUID());
const videos = ["a", "b", "c"].map((id, i) => ({ id, titre: "Vidéo " + id, statut: "prete", url_hls: "/fixture.mp4", duree: 253,
    date_ajout: new Date(Date.UTC(2026, 0, 3 - i)).toISOString(), likes: 0, comments: 0, saves: 0, shares: 0 }));
videos.push({ id: "photo", titre: "Diaporama", statut: "prete", media_type: "photo", photo_count: 3,
    photo_interval_seconds: 3, audio_title: "Son choisi", url_hls: "/fixture.mp4", duree: 253,
    date_ajout: new Date(Date.UTC(2025, 11, 30)).toISOString(), likes: 0, comments: 0, saves: 0, shares: 0 });
let browser, server, ws, session, sequence = 0;
const waiting = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function send(method, params = {}, withSession = true) {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error("Délai DevTools : " + method)); }, 15000);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(withSession && session ? { sessionId: session } : {}) }));
    });
}
async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
}
async function until(expression, label) {
    const start = Date.now();
    while (!await evaluate(expression)) {
        if (Date.now() - start > 15000) throw new Error("Délai : " + label);
        await delay(100);
    }
}

async function main() {
    assert.ok(profile.startsWith(tmp + path.sep));
    await fs.mkdir(profile, { recursive: true });
    const app = express();
    app.get("/api/profile", (_req, res) => res.json({ id: "test", pseudo: "Test" }));
    app.get("/api/videos", (_req, res) => res.json(videos));
    app.get("/api/videos/:id/social", (_req, res) => res.json({ id: _req.params.id, likes: 0, comments: 0, shares: 0, saves: 0 }));
    app.get("/fixture.mp4", (_req, res) => res.sendFile(path.join(root, "videos_test", "test.mp4")));
    app.get("/app/cordova.js", (_req, res) => res.type("application/javascript").send("// Test navigateur"));
    app.use("/app", express.static(path.join(root, "www")));
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    const options = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
    let executable;
    for (const candidate of options) { try { await fs.access(candidate); executable = candidate; break; } catch {} }
    assert.ok(executable, "Chrome ou Edge est requis.");
    browser = spawn(executable, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required", ...(process.env.SV_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
        "--user-data-dir=" + profile, "about:blank"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Chrome n'a pas ouvert DevTools.")), 15000);
        browser.once("error", reject);
        browser.stderr.on("data", chunk => {
            output += chunk;
            const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        browser.once("exit", code => { clearTimeout(timer); reject(new Error("Chrome arrêté : " + code)); });
    });
    ws = new WebSocket(endpoint); await once(ws, "open");
    ws.addEventListener("message", event => {
        const message = JSON.parse(event.data), pending = waiting.get(message.id);
        if (!pending) return;
        waiting.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    });
    const target = await send("Target.createTarget", { url: "about:blank" }, false);
    session = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false)).sessionId;
    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const size = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
    await size(390, 844);
    // Le lecteur HLS suit ici son chemin natif avec une vraie vidéo MP4 locale.
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        const fakeHls = { isSupported: () => false };
        Object.defineProperty(window, "Hls", { configurable: true, get: () => fakeHls, set: () => {} });
        const original = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function(type) { return type === "application/vnd.apple.mpegurl" ? "probably" : original.call(this, type); };
        localStorage.setItem("defilementAutomatique", "false");
    })();` });
    await send("Page.navigate", { url: origin + "/app/" });
    await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === 'a' && document.getElementById('lecteur')?.duration > 60", "première vidéo prête");
    await evaluate("document.getElementById('videoSuivante').click()");
    await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === 'b' && document.getElementById('lecteur')?.duration > 60", "deuxième vidéo prête");
    await evaluate("document.getElementById('lecteur').currentTime=80");
    await until("document.getElementById('lecteur').currentTime >= 79", "position initiale non nulle");
    await until("!document.getElementById('lecteur').paused", "lecture avant rotation");
    await evaluate("document.getElementById('pleinEcran').click()");
    await until("document.getElementById('scene').classList.contains('video-fullscreen')", "plein écran");
    await size(844, 390); await delay(500);
    await size(390, 844); await delay(700);
    await evaluate("document.getElementById('pleinEcran').click()");
    await until("!document.getElementById('scene').classList.contains('video-fullscreen')", "sortie du plein écran");
    await until("!document.getElementById('lecteur').paused", "reprise automatique après rotation");
    await delay(1000);
    const after = await evaluate("({ id:document.querySelector('.feed-card.is-active')?.dataset.videoId, time:document.getElementById('lecteur').currentTime })");
    assert.equal(after.id, "b", "La rotation conserve la deuxième vidéo.");
    assert.ok(after.time >= 78, "La rotation conserve la position : " + after.time);
    await delay(500);
    assert.ok(await evaluate("document.getElementById('lecteur').currentTime") > after.time, "La lecture continue sans appuyer sur Play.");
    await evaluate("document.getElementById('videoPrecedente').click()");
    await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === 'a'", "retour à la première vidéo");
    await evaluate("document.getElementById('videoSuivante').click()");
    await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === 'b' && document.getElementById('lecteur').currentTime >= 78", "reprise de la deuxième vidéo");
    await evaluate("document.getElementById('lecteur').currentTime=40"); await delay(300);
    async function hold(side) {
        const p = await evaluate(`(() => {const r=document.getElementById('filVideos').getBoundingClientRect();return {x:r.left+r.width*${side},y:r.top+r.height*.35};})()`);
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
        await delay(1250);
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await delay(200);
    }
    await hold(0.7);
    const forward = await evaluate("({ id:document.querySelector('.feed-card.is-active')?.dataset.videoId,time:document.getElementById('lecteur').currentTime })");
    assert.equal(forward.id, "b"); assert.ok(forward.time >= 58 && forward.time < 65, "Maintien droit : " + forward.time);
    await hold(0.25);
    const backward = await evaluate("({ id:document.querySelector('.feed-card.is-active')?.dataset.videoId,time:document.getElementById('lecteur').currentTime })");
    assert.equal(backward.id, "b"); assert.ok(backward.time >= 38 && backward.time < 48, "Maintien gauche : " + backward.time);
    await evaluate("document.getElementById('pleinEcran').click()");
    await until("document.getElementById('scene').classList.contains('video-fullscreen')", "plein écran pour les gestes paysage");
    await size(844, 390); await delay(400);
    await evaluate("document.getElementById('lecteur').currentTime=40");
    await hold(0.7);
    const landscapeForward = await evaluate("document.getElementById('lecteur').currentTime");
    assert.ok(landscapeForward >= 58 && landscapeForward < 65, "Maintien droit en paysage : " + landscapeForward);
    await hold(0.25);
    const landscapeBackward = await evaluate("document.getElementById('lecteur').currentTime");
    assert.ok(landscapeBackward >= 38 && landscapeBackward < 48, "Maintien gauche en paysage : " + landscapeBackward);
    const center = await evaluate("(() => {const r=document.getElementById('filVideos').getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.35};})()");
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: center.x, y: center.y }] });
    await delay(650);
    assert.equal(await evaluate("document.getElementById('lecteur').playbackRate"), 2, "Un maintien au centre accélère à 2x en paysage.");
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await delay(100);
    assert.equal(await evaluate("document.getElementById('lecteur').playbackRate"), 1, "Le relâchement restaure la vitesse normale.");
    await size(390, 844); await delay(400);
    await evaluate("document.getElementById('pleinEcran').click()");
    await until("!document.getElementById('scene').classList.contains('video-fullscreen')", "retour en portrait après les gestes");
    await until("!document.getElementById('lecteur').paused", "lecture après retour en portrait");
    await send("Page.navigate", { url: origin + "/app/upload.html" });
    await until("!!document.getElementById('fichier')", "navigation vers le studio");
    await send("Page.navigate", { url: origin + "/app/?video=b" });
    await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === 'b' && document.getElementById('lecteur')?.currentTime >= 38", "reprise après navigation dans l'application");
    await send("Page.reload");
    await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === 'b' && Number.isFinite(document.getElementById('lecteur')?.duration)", "rechargement du fil");
    assert.ok(await evaluate("document.getElementById('lecteur').currentTime < 4"), "Une actualisation ne restaure pas l'historique de session.");
    await send("Page.navigate", { url: origin + "/app/?video=photo" });
    await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === 'photo' && document.getElementById('compteurPhotos').textContent === '1/3'", "sélection du diaporama photo");
    await evaluate("document.getElementById('photoSuivante').click()");
    await until("document.getElementById('compteurPhotos').textContent === '2/3'", "navigation vers la deuxième photo");
    const swipe = await evaluate("(() => {const r=document.getElementById('filVideos').getBoundingClientRect();return {x:r.left+r.width*.7,y:r.top+r.height*.35};})()");
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: swipe.x, y: swipe.y }] });
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: swipe.x - 100, y: swipe.y }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until("document.getElementById('compteurPhotos').textContent === '3/3'", "balayage vers la photo suivante");
    assert.equal(await evaluate("document.getElementById('audioLabel').textContent.includes('Son choisi')"), true, "Le fil affiche le titre du son choisi.");
    console.log("OK : rotation, reprise immédiate, gestes de recherche et lecture 2x en paysage, historique et navigation.");
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    if (ws?.readyState === WebSocket.OPEN) { await send("Browser.close", {}, false).catch(() => {}); ws.close(); }
    if (browser?.exitCode === null) { await Promise.race([once(browser, "exit"), delay(3000)]); if (browser.exitCode === null) browser.kill(); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (path.resolve(profile).startsWith(tmp + path.sep)) await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
