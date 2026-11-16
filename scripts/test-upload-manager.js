"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = name => fs.readFileSync(path.join(__dirname, "..", "www", "js", name), "utf8");

function contexte(overrides = {}) {
    const window = { addEventListener() {}, dispatchEvent() {} };
    const context = vm.createContext({ window, document: { addEventListener() {} }, console, AbortController,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        setTimeout, clearTimeout, performance, ...overrides });
    return context;
}

test("deux places seulement, libération et annulation d'une attente", async () => {
    const context = contexte();
    vm.runInContext(source("upload-manager.js"), context);
    const manager = new context.window.SVUploadManager();
    const first = await manager.acquire("upload");
    const second = await manager.acquire("upload");
    const controller = new AbortController();
    const paused = manager.acquire("upload", controller.signal);
    let entered = false;
    const fourth = manager.acquire("upload").then(release => { entered = true; return release; });
    await Promise.resolve();
    assert.equal(manager.uploadActive, 2);
    assert.equal(entered, false);
    controller.abort();
    await assert.rejects(paused, { name: "AbortError" });
    first();
    const releaseFourth = await fourth;
    assert.equal(manager.uploadActive, 2);
    second(); releaseFourth();
    assert.equal(manager.uploadActive, 0);
});

test("retrouve toutes les fiches actives dans leur ordre d'arrivée", async () => {
    const records = [{ id: "b", createdAt: 2, state: "paused" }, { id: "a", createdAt: 1, state: "uploading" }, { id: "c", createdAt: 3, state: "done" }];
    const restored = [];
    const context = contexte({ SVUploadStore: { list: async () => records }, SVResumableUpload: class {
        async restore(record) { this.record = record; restored.push(record.id); }
    } });
    vm.runInContext(source("upload-manager.js"), context);
    const manager = new context.window.SVUploadManager();
    assert.equal(await manager.restore(), 2);
    assert.deepEqual(restored, ["a", "b"]);
    assert.equal(await manager.restore(), 2);
    assert.equal(restored.length, 2);
});

test("la fin de conversion notifie et conserve la fiche si le nettoyage échoue", async () => {
    const events = [];
    const context = contexte({ SVUploadFile: { remove: async () => { events.push("remove"); throw Error("disque"); } },
        SVUploadStore: { put: async record => events.push(record.state), remove: async () => events.push("forget") } });
    context.window.SVPublicationNotifications = { complete: () => events.push("notification") };
    vm.runInContext(source("resumable-upload.js"), context);
    const upload = new context.window.SVResumableUpload();
    upload.record = { id: "a", videoId: "v", source: {}, state: "processing" };
    upload.json = async () => ({ statut: "prete" });
    await upload.watch();
    assert.deepEqual(events, ["notification", "remove", "done"]);
    assert.equal(upload.record.cleanupPending, true);
});

test("nettoie ultérieurement une copie sans bloquer la reprise des autres fiches", async () => {
    let finishCleanup;
    const cleanup = new Promise(resolve => { finishCleanup = resolve; });
    const removed = [], restored = [];
    const context = contexte({ SVUploadFile: { remove: () => cleanup }, SVUploadStore: {
        list: async () => [{ id: "done", state: "done", cleanupPending: true, source: {} }, { id: "active", state: "paused", createdAt: 1 }],
        remove: async id => removed.push(id)
    }, SVResumableUpload: class { async restore(record) { restored.push(record.id); this.record = record; } } });
    vm.runInContext(source("upload-manager.js"), context);
    const manager = new context.window.SVUploadManager();
    assert.equal(await manager.restore(), 1);
    assert.deepEqual(restored, ["active"]);
    assert.deepEqual(removed, []);
    finishCleanup();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(removed, ["done"]);
});

test("trois vrais transferts utilisent deux places et finalisent leurs sessions indépendantes", async () => {
    const sessions = new Map(), records = new Map(), pending = [], finalised = [], notifications = [];
    let id = 0, active = 0, maximum = 0;
    class Request {
        constructor() { this.upload = {}; this.headers = {}; }
        open(method, url) { this.url = url; }
        setRequestHeader(name, value) { this.headers[name] = value; }
        send(bytes) {
            const sessionId = decodeURIComponent(this.url.split("/").pop());
            const session = sessions.get(sessionId);
            assert.ok(session, "la session du bloc existe");
            assert.equal(Number(this.headers["Upload-Offset"]), session.offset);
            active++;
            maximum = Math.max(maximum, active);
            pending.push(() => {
                active--;
                session.offset += bytes.byteLength;
                this.status = 200;
                this.responseText = JSON.stringify({ offset: session.offset });
                this.onload();
                this.onloadend();
            });
        }
        abort() { this.onabort?.(); this.onloadend?.(); }
    }
    const store = {
        async put(record) { records.set(record.id, { ...record }); },
        async remove(key) { records.delete(key); }
    };
    const files = {
        async begin(file, key, progress) {
            progress(file.size, file.size);
            return { source: { id: key, size: file.size }, complete: Promise.resolve() };
        },
        async readAvailable(source, start, end) { return new ArrayBuffer(end - start); },
        async remove() {}
    };
    async function fetch(url, options = {}) {
        const endpoint = new URL(url).pathname.replace(/^\/api/, "");
        let data;
        if (endpoint === "/uploads" && options.method === "POST") {
            const body = JSON.parse(options.body);
            const sessionId = "session-" + body.clientId;
            sessions.set(sessionId, { id: sessionId, offset: 0, size: body.size });
            data = { id: sessionId };
        } else if (/^\/uploads\/[^/]+\/complete$/.test(endpoint)) {
            const key = endpoint.split("/")[2];
            const session = sessions.get(key);
            assert.equal(session.offset, session.size);
            finalised.push(key);
            data = { videoId: "video-" + key };
        } else if (endpoint.startsWith("/uploads/")) {
            data = sessions.get(endpoint.split("/")[2]);
        } else if (endpoint.startsWith("/videos/")) data = { statut: "prete" };
        else throw new Error("Requête inattendue : " + endpoint);
        return { ok: true, async json() { return data; } };
    }
    const context = contexte({ XMLHttpRequest: Request, fetch, SVUploadStore: store, SVUploadFile: files,
        SV: { base: "http://test/api", token: "token", uuid: () => String(++id) } });
    context.window.SVPublicationNotifications = { complete: record => notifications.push(record.id) };
    vm.runInContext(source("resumable-upload.js"), context);
    context.SVResumableUpload = context.window.SVResumableUpload;
    vm.runInContext(source("upload-manager.js"), context);
    const manager = new context.window.SVUploadManager();
    const starts = ["A", "B", "C"].map(name => manager.start({ name, size: 10, type: "video/mp4" }, { title: name, description: "" }));
    await Promise.all(starts);
    async function until(condition) {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (condition()) return;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error("Délai dépassé : les transferts ne progressent pas.");
    }
    await until(() => pending.length === 2);
    assert.equal(active, 2);
    assert.equal(manager.uploadWaiting.length, 1);
    assert.equal(new Set([...sessions.keys()]).size, 2);
    pending.shift()();
    await until(() => pending.length === 2 && sessions.size === 3);
    assert.equal(active, 2);
    while (pending.length) pending.shift()();
    await until(() => notifications.length === 3);
    assert.equal(maximum, 2);
    assert.equal(new Set(finalised).size, 3);
    assert.equal(new Set(notifications).size, 3);
    assert.equal(records.size, 0);
});
