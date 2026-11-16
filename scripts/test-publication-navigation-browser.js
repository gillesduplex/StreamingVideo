"use strict";

// Test du fil et du studio avec un serveur local et une copie lente simulée.
// SV_TEST_NO_SANDBOX=1 ne doit être utilisé que pour ce contenu de test fiable.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const express = require("../backend/node_modules/express");

const root = path.resolve(__dirname, "..");
const tempRoot = path.join(root, ".tmp");
const profile = path.join(tempRoot, "publication-navigation-" + randomUUID());
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
    const deadline = Date.now() + 18000;
    while (!await evaluate(expression)) {
        if (Date.now() > deadline) throw new Error("Délai : " + label);
        await delay(100);
    }
}

async function main() {
    assert.ok(profile.startsWith(path.resolve(tempRoot) + path.sep));
    await fs.mkdir(profile, { recursive: true });
    const app = express();
    const sessions = new Map();
    let published = false;
    app.use(express.json({ limit: "16kb" }));
    app.get("/api/profile", (_req, res) => res.json({ id: "profile", pseudo: "Test" }));
    app.get("/api/videos", (_req, res) => res.json(published ? [{ id: "video", titre: "Film", statut: "prete", url_hls: "/video.m3u8", duree: 30, date_ajout: new Date().toISOString() }] : []));
    app.get("/api/videos/:id", (_req, res) => res.json({ id: "video", statut: "prete" }));
    app.get("/api/videos/:id/social", (_req, res) => res.json({ likes: 0, comments: 0, shares: 0, saves: 0 }));
    app.post("/api/uploads", (req, res) => {
        const id = req.body.clientId;
        sessions.set(id, { id, size: req.body.size, offset: 0, status: "uploading" });
        res.json({ id });
    });
    app.get("/api/uploads/:id", (req, res) => res.json(sessions.get(req.params.id)));
    app.patch("/api/uploads/:id", express.raw({ type: "application/octet-stream", limit: "8mb" }), (req, res) => {
        const item = sessions.get(req.params.id);
        if (!item || Number(req.get("Upload-Offset")) !== item.offset) return res.status(409).json({ message: "Décalage" });
        item.offset += req.body.length;
        res.json(item);
    });
    app.post("/api/uploads/:id/complete", (req, res) => {
        const item = sessions.get(req.params.id);
        assert.equal(item.offset, item.size);
        published = true;
        item.status = "complete";
        item.videoId = "video";
        res.json(item);
    });
    app.get("/app/cordova.js", (_req, res) => res.type("application/javascript").send("// Test navigateur isolé"));
    app.use("/app", express.static(path.join(root, "www")));
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    const candidates = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
    let executable;
    for (const candidate of candidates) { try { await fs.access(candidate); executable = candidate; break; } catch {} }
    assert.ok(executable, "Chrome ou Edge est requis.");
    browser = spawn(executable, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
        ...(process.env.SV_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "--user-data-dir=" + profile, "about:blank"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    await send("Page.navigate", { url: origin + "/app/" });
    await until("!!window.SVStudio && !!window.SVBackgroundUploads", "fil et gestionnaire racine");
    await evaluate("window.SVStudio.open()");
    await until("document.querySelector('iframe.studio-frame')?.contentWindow?.SVParentStudio", "studio intégré");
    await evaluate(`(() => {
        window.__manager = SVBackgroundUploads;
        window.__size = 10 * 1024 * 1024;
        SVUploadFile.begin = async (file, id, progress) => {
            window.__progressCopy = progress;
            return { source: { id, size: file.size, kind: 'test' }, complete: new Promise(resolve => window.__finishCopy = resolve) };
        };
        SVUploadFile.readAvailable = async (_source, start, end) => new Uint8Array(end - start).buffer;
        SVUploadFile.remove = async () => {};
        const child = document.querySelector('iframe.studio-frame').contentWindow;
        const file = new child.File([new Uint8Array(window.__size)], 'film.mp4', { type: 'video/mp4' });
        window.__start = SVBackgroundUploads.start(file, { title: 'Film', description: '' });
    })()`);
    await until("!!window.__progressCopy && SVBackgroundUploads.transfers[0]?.record?.copyComplete === false", "copie commencée");
    await evaluate("SVStudio.close()");
    assert.equal(await evaluate("SVStudio.isVisible()"), false);
    assert.equal(await evaluate("SVBackgroundUploads === window.__manager"), true);
    await evaluate("window.__progressCopy(5 * 1024 * 1024, window.__size)");
    await until("SVBackgroundUploads.transfers[0]?.record?.offset === 5 * 1024 * 1024", "premier bloc envoyé pendant copie et fil visibles");
    assert.equal(await evaluate("SVBackgroundUploads.transfers[0].record.copyComplete"), false);
    await until("!!document.querySelector('.upload-background-status')", "message d'envoi sur le fil");
    assert.match(await evaluate("document.querySelector('.upload-background-status').textContent"), /publication en cours/i);
    await evaluate("document.querySelector('.upload-background-status').click()");
    assert.equal(await evaluate("SVStudio.isVisible()"), true, "Le message rouvre le studio de suivi.");
    await evaluate("SVStudio.close()");
    await evaluate("window.__progressCopy(window.__size, window.__size); window.__finishCopy();");
    await until("!!document.querySelector('.publication-notice')", "notification sur le fil");
    await until("!document.querySelector('.upload-background-status')", "fin du message d'envoi");
    assert.equal(await evaluate("document.querySelector('.publication-notice p').textContent"), "Film est prête à être regardée.");
    assert.equal(await evaluate("SVBackgroundUploads === window.__manager"), true);
    await evaluate("document.querySelector('.publication-notice a').click()");
    await until("!document.querySelector('.publication-notice')", "notification consultée");
    assert.equal(await evaluate("SVBackgroundUploads === window.__manager"), true, "Voir la vidéo ne recharge pas la racine.");
    console.log("OK : copie partielle et envoi continuent pendant le fil ; notification et lien sans rechargement.");
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    if (ws?.readyState === WebSocket.OPEN) { await send("Browser.close", {}, false).catch(() => {}); ws.close(); }
    if (browser?.exitCode === null) { await Promise.race([once(browser, "exit"), delay(3000)]); if (browser.exitCode === null) browser.kill(); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (path.resolve(profile).startsWith(path.resolve(tempRoot) + path.sep)) await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
