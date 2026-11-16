"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

function environment(failNetwork = false) {
    let progress, resolveCopy, rejectCopy, offset = 0, finalizations = 0;
    const sent = [], records = new Map();
    const size = 12 * 1024 * 1024;
    class Request {
        constructor() { this.upload = {}; this.headers = {}; }
        open() {}
        setRequestHeader(key, value) { this.headers[key] = value; }
        send(bytes) {
            sent.push({ start: Number(this.headers["Upload-Offset"]), size: bytes.byteLength });
            setTimeout(() => {
                if (failNetwork) { this.onerror(); this.onloadend(); return; }
                offset += bytes.byteLength;
                this.status = 200; this.responseText = JSON.stringify({ offset });
                this.onload(); this.onloadend();
            }, 0);
        }
        abort() { this.onabort?.(); this.onloadend?.(); }
    }
    const copy = new Promise((resolve, reject) => { resolveCopy = resolve; rejectCopy = reject; });
    const source = { id: "00000000-0000-4000-8000-000000000001", kind: "cordova", size };
    const store = { put: async record => records.set(record.id, { ...record }), list: async () => [...records.values()], remove: async id => records.delete(id) };
    const files = { begin: async (_file, _id, onProgress) => { progress = onProgress; return { source, complete: copy }; },
        readAvailable: async (_source, start, end) => new ArrayBuffer(end - start), remove: async () => {} };
    const sandbox = { window: { addEventListener() {} }, document: { addEventListener() {} }, SVUploadStore: store,
        SVUploadFile: files, SV: { uuid: () => source.id, base: "/api", token: "test" }, XMLHttpRequest: Request,
        AbortController, setTimeout, clearTimeout, performance, console, fetch: async (url, options = {}) => {
            let body = { id: source.id, status: "uploading", size, offset };
            if (url.endsWith("/complete")) { finalizations++; body = { ...body, status: "complete", videoId: "video" }; }
            return { ok: true, json: async () => body };
        } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/resumable-upload.js"), "utf8"), sandbox);
    return { manager: new sandbox.window.SVResumableUpload(), size, sent, progress: value => progress(value, size),
        resolveCopy, rejectCopy, finalizations: () => finalizations };
}

async function until(check) {
    const start = Date.now();
    while (!check()) { if (Date.now() - start > 4000) throw new Error("Délai de test dépassé"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test("le premier bloc part pendant la copie et une source perdue empêche la publication", async () => {
    const e = environment();
    const starting = e.manager.start({ name: "video.mp4", size: e.size }, { title: "", description: "" }).catch(error => error);
    await until(() => !!e.manager.record?.source);
    e.progress(5 * 1024 * 1024);
    await until(() => e.sent.length === 1 && e.manager.record.offset === 5 * 1024 * 1024);
    assert.equal(e.manager.record.copyComplete, false);
    assert.equal(e.sent[0].size, 5 * 1024 * 1024);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(e.sent.length, 1, "Aucun bloc non copié n'est envoyé");
    e.rejectCopy(new Error("Source supprimée"));
    assert.match((await starting).message, /Source supprimée/);
    await until(() => e.manager.record.state === "error");
    assert.equal(e.finalizations(), 0);
});

test("une panne réseau n'arrête pas la copie locale", async () => {
    const e = environment(true);
    const starting = e.manager.start({ name: "video.mp4", size: e.size }, { title: "", description: "" });
    await until(() => !!e.manager.record?.source);
    e.progress(5 * 1024 * 1024);
    await until(() => e.manager.record.state === "interrupted");
    e.progress(e.size); e.resolveCopy(e.manager.record.source);
    await starting;
    assert.equal(e.manager.record.copyComplete, true);
    assert.equal(e.manager.record.state, "interrupted");
    assert.equal(e.finalizations(), 0);
    clearTimeout(e.manager.timer);
});
