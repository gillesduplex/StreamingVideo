"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

async function waitFor(check) {
    const end = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > end) throw new Error("Délai de test dépassé");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

test("pause pendant la copie puis nouvelle sélection reprend la même session et les octets conservés", async () => {
    const size = 12 * 1024 * 1024;
    const file = { name: "film.mp4", size, lastModified: 123, type: "video/mp4" };
    const source = { id: "id1", name: file.name, size, kind: "cordova", originalLastModified: 123 };
    let progress, finishRecovery, offset = 0, deletes = 0, resumedAt = 0, removed = 0;
    const sent = [], stored = new Map();
    class Request {
        constructor() { this.upload = {}; this.headers = {}; }
        open() {}
        setRequestHeader(key, value) { this.headers[key] = value; }
        send(bytes) { setTimeout(() => {
            sent.push(Number(this.headers["Upload-Offset"])); offset += bytes.byteLength;
            this.status = 200; this.responseText = JSON.stringify({ offset }); this.onload(); this.onloadend();
        }, 0); }
        abort() { this.onabort?.(); this.onloadend?.(); }
    }
    const files = {
        begin: async (_file, _id, report, signal) => {
            progress = report;
            const complete = new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("pause"), { name: "AbortError" })), { once: true }));
            return { source, complete };
        },
        resumeCopy: async (_source, report, _signal, selected) => {
            assert.equal(selected, file);
            resumedAt = 5 * 1024 * 1024;
            report(resumedAt, size);
            return { source, complete: new Promise(resolve => { finishRecovery = () => { report(size, size); resolve(source); }; }) };
        },
        readAvailable: async (_source, start, end) => new ArrayBuffer(end - start),
        remove: async () => { removed++; }
    };
    const sandbox = {
        window: { addEventListener() {}, dispatchEvent() {} }, document: { addEventListener() {} },
        SVUploadFile: files, SVUploadStore: { put: async record => stored.set(record.id, { ...record }), remove: async id => stored.delete(id) },
        SV: { uuid: () => "id1", base: "/api", token: "test" }, XMLHttpRequest: Request, CustomEvent: class {},
        AbortController, setTimeout, clearTimeout, performance, console,
        fetch: async (url, options = {}) => {
            if (options.method === "DELETE") deletes++;
            let body = { id: "id1", status: "uploading", offset };
            if (url.endsWith("/complete")) body = { videoId: "vid1" };
            else if (url.endsWith("/videos/vid1")) body = { statut: "prete" };
            return { ok: true, json: async () => body };
        }
    };
    for (const name of ["resumable-upload.js", "upload-manager.js"]) {
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js", name), "utf8"), sandbox);
        if (name === "resumable-upload.js") sandbox.SVResumableUpload = sandbox.window.SVResumableUpload;
    }
    const manager = new sandbox.window.SVUploadManager();
    const starting = manager.start(file, { title: "Film", description: "" });
    await waitFor(() => progress);
    progress(5 * 1024 * 1024, size);
    await waitFor(() => offset === 5 * 1024 * 1024);
    const transfer = manager.transfers[0];
    await transfer.cancel(); await starting;
    assert.equal(transfer.record.state, "paused");
    assert.equal(transfer.record.hidden, true, "Annuler retire la fiche de la liste sans l'effacer");
    assert.equal(transfer.record.sessionId, "id1");
    assert.equal(deletes, 0);
    assert.equal(removed, 0);
    await manager.start(file, { title: "Film", description: "" });
    assert.equal(transfer.record.hidden, false);
    await waitFor(() => finishRecovery);
    assert.equal(manager.transfers.length, 1);
    assert.equal(resumedAt, 5 * 1024 * 1024);
    finishRecovery();
    await waitFor(() => offset === size);
    assert.equal(sent[0], 0);
    assert.equal(sent[1], 5 * 1024 * 1024, "Le premier bloc confirmé n'est pas renvoyé");
    await transfer.pause();
});

test("une copie partielle sans source de comparaison fiable n'est jamais mélangée à une nouvelle vidéo", async () => {
    const stored = new Map();
    const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} }, AbortController, setTimeout, clearTimeout,
        SVUploadFile: { compareFiles: async () => true }, SVUploadStore: { put: async record => stored.set(record.id, { ...record }) },
        console, performance };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/resumable-upload.js"), "utf8"), sandbox);
    const upload = new sandbox.window.SVResumableUpload();
    upload.record = { id: "id1", name: "film.mp4", size: 100, source: { id: "id1", kind: "cordova", size: 100 },
        state: "paused", copyComplete: false, offset: 50, hidden: true };
    await assert.rejects(upload.continueWithFile({ name: "film.mp4", size: 100 }), /Impossible de vérifier toute/);
    assert.equal(upload.record.hidden, false);
    assert.equal(upload.record.state, "error");
    assert.equal(upload.record.offset, 50);
});

test("Reprendre utilise directement l'original encore accessible sans le demander à nouveau", async () => {
    const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} }, AbortController, setTimeout, clearTimeout,
        SVUploadFile: {}, SVUploadStore: { put: async () => {} }, console, performance };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/resumable-upload.js"), "utf8"), sandbox);
    const upload = new sandbox.window.SVResumableUpload();
    const original = { name: "film.mp4", size: 100 };
    upload.record = { id: "id1", name: original.name, size: 100, source: { id: "id1", kind: "cordova", size: 100 },
        state: "paused", copyComplete: false, needsFile: true, copiedBytes: 40, sessionId: "session" };
    upload.originalFile = original;
    let recoveries = 0;
    upload.startCopyRecovery = () => { recoveries++; upload.copying = true; };
    upload.json = async () => ({ status: "complete", videoId: "video" });
    upload.watch = async () => {};
    await upload.resume();
    assert.equal(recoveries, 1);
    assert.equal(upload.record.needsFile, false);
    assert.equal(upload.record.videoId, "video");
});

test("la comparaison apparaît dans le suivi et une annulation pendant cette étape ne relance pas l'envoi", async () => {
    let finishComparison;
    const records = [];
    const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} }, AbortController, setTimeout, clearTimeout,
        SVUploadFile: { compareFiles: () => new Promise(resolve => { finishComparison = resolve; }) },
        SVUploadStore: { put: async record => records.push({ ...record }) }, console, performance };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/resumable-upload.js"), "utf8"), sandbox);
    const upload = new sandbox.window.SVResumableUpload();
    const selected = { name: "film.mp4", size: 100 };
    upload.originalFile = { name: "film.mp4", size: 100 };
    upload.record = { id: "id1", name: selected.name, size: selected.size, source: { id: "id1", kind: "cordova", size: 100 },
        state: "paused", hidden: true, copyComplete: false, offset: 40 };
    let recoveryStarted = false;
    upload.startCopyRecovery = () => { recoveryStarted = true; };
    const matching = upload.continueWithFile(selected);
    await waitFor(() => !!finishComparison);
    assert.equal(upload.record.hidden, false);
    assert.equal(upload.record.copyVerifying, true);
    await upload.cancel();
    finishComparison(true);
    await matching;
    assert.equal(upload.record.hidden, true);
    assert.equal(upload.record.copyVerifying, false);
    assert.equal(recoveryStarted, false);
    assert.equal(upload.record.offset, 40);
});

test("une ancienne copie incomplète reste visible en pause et Reprendre demande la source seulement si nécessaire", async () => {
    const stored = new Map();
    const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} }, AbortController, setTimeout, clearTimeout,
        SVUploadFile: { validate: async () => { throw new Error("incomplète"); } },
        SVUploadStore: { put: async record => stored.set(record.id, { ...record }) }, console, performance };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/resumable-upload.js"), "utf8"), sandbox);
    const upload = new sandbox.window.SVResumableUpload();
    await upload.restore({ id: "id1", name: "film.mp4", size: 100, source: { id: "id1", kind: "cordova", size: 100 },
        state: "paused", copyComplete: false, createdAt: 1 });
    assert.equal(upload.record.state, "paused");
    assert.equal(upload.record.needsFile, true);
    await upload.resume();
    assert.equal(upload.record.state, "error");
    assert.match(upload.record.error, /ne donne plus accès/);
});

test("les publications annulées conservées restent accessibles sans ouvrir un suivi vide au retour", async () => {
    const records = [{ id: "one", state: "paused", hidden: true, createdAt: 1 }];
    const sandbox = { window: {}, SVUploadStore: { list: async () => records },
        SVResumableUpload: class { async restore(record) { this.record = record; } }, console };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/upload-manager.js"), "utf8"), sandbox);
    const manager = new sandbox.window.SVUploadManager();
    assert.equal(await manager.restore(), 0);
    assert.equal(manager.transfers.length, 1);
    assert.equal(await manager.restore(), 0);
});

test("un ancien fichier non vérifiable demande un accord explicite avant reprise", async () => {
    let confirmed = false;
    const attempts = [];
    const sandbox = { window: {}, console };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/upload-manager.js"), "utf8"), sandbox);
    const manager = new sandbox.window.SVUploadManager({ confirmUnverified: () => confirmed });
    const transfer = { async continueWithFile(_file, options = {}) {
        attempts.push(!!options.allowUnverified);
        if (!options.allowUnverified) { const error = new Error("source absente"); error.code = "SOURCE_NON_VERIFIEE"; throw error; }
        return "reprise";
    } };
    await assert.rejects(manager.continueWithFile(transfer, {}), /source absente/);
    assert.deepEqual(attempts, [false]);
    confirmed = true;
    assert.equal(await manager.continueWithFile(transfer, {}), "reprise");
    assert.deepEqual(attempts, [false, false, true]);
});

test("sans copie locale, seul le serveur peut autoriser une nouvelle copie à partir de zéro", async () => {
    const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} }, AbortController, setTimeout, clearTimeout,
        SVUploadFile: {}, SVUploadStore: { put: async () => {} }, console, performance };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/resumable-upload.js"), "utf8"), sandbox);
    const upload = new sandbox.window.SVResumableUpload();
    const file = { name: "film.mp4", size: 100 };
    upload.record = { id: "id1", name: file.name, size: 100, state: "paused", source: null, offset: 0, sessionId: "id1" };
    let offset = 50, starts = 0;
    upload.json = async () => ({ status: "uploading", offset });
    upload.start = async (_file, _meta, record) => { starts++; assert.equal(record.id, "id1"); };
    await assert.rejects(upload.continueWithFile(file), /octets existent déjà/);
    assert.equal(starts, 0);
    offset = 0;
    await upload.continueWithFile(file);
    assert.equal(starts, 1);
});

test("pause pendant la vérification retire l'indicateur de vérification", async () => {
    let ready;
    const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} }, AbortController, setTimeout, clearTimeout,
        SVUploadFile: { resumeCopy: async (_source, _progress, signal) => ({
            complete: new Promise((_resolve, reject) => { ready = true; signal.addEventListener("abort", () => reject(Object.assign(new Error("pause"), { name: "AbortError" }))); })
        }) }, SVUploadStore: { put: async () => {} }, console, performance };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/resumable-upload.js"), "utf8"), sandbox);
    const upload = new sandbox.window.SVResumableUpload();
    upload.record = { id: "id1", state: "paused", source: { kind: "cordova" }, copiedBytes: 30, copyComplete: false };
    upload.startCopyRecovery({});
    await waitFor(() => ready);
    assert.equal(upload.record.copyVerifying, true);
    assert.equal(upload.record.copiedBytes, 30);
    await upload.pause();
    assert.equal(upload.record.copyVerifying, false);
    assert.equal(upload.record.copiedBytes, 30);
});
