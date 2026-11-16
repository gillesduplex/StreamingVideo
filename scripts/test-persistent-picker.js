"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = file => fs.readFileSync(path.join(__dirname, "..", "www", "js", file), "utf8");

test("sélection multiple conserve le nom, les URI Cordova et l'aperçu", async () => {
    const items = ["a", "b"].map(name => ({ uri: "content://provider/" + name, name: name + ".mp4", size: 7, type: "video/mp4" }));
    const host = {
        cordova: { plugins: { SVVideoPicker: { select(resolve) { resolve(items); } } } },
        resolveLocalFileSystemURL(uri, resolve) {
            resolve({ toURL: () => uri, file(ok) { ok({ size: 7, type: "", localURL: "cdvfile://localhost/" + uri, slice() {} }); } });
        }
    };
    // Le module peut s'exécuter dans le studio iframe et trouver les plugins du parent.
    const window = { parent: host };
    vm.runInNewContext(source("persistent-picker.js"), { window, Promise, Error, String });
    assert.equal(window.SVPersistentPicker.available(), true);
    const result = await window.SVPersistentPicker.select();
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "a.mp4");
    assert.equal(result[0].type, "video/mp4");
    assert.equal(result[1].localURL, "cdvfile://localhost/content://provider/b");
    assert.equal(result[1].previewURL, "content://provider/b");
});

test("une sélection annulée retourne une liste vide et un refus reste explicite", async () => {
    let fail = false;
    const window = { cordova: { plugins: { SVVideoPicker: { select(ok, error) { fail ? error("Accès refusé") : ok([]); } } } },
        resolveLocalFileSystemURL() {} };
    window.parent = window;
    vm.runInNewContext(source("persistent-picker.js"), { window, Promise, Error, String });
    assert.equal((await window.SVPersistentPicker.select()).length, 0);
    fail = true;
    await assert.rejects(window.SVPersistentPicker.select(), /Accès refusé/);
});

test("un Blob provenant d'une autre fenêtre reste accepté pour sa copie", async () => {
    // Même propriété que deux realms : l'objet n'est pas instanceof le Blob de la fenêtre hôte.
    class HostBlob extends Blob {}
    const foreign = new Blob(["video"], { type: "video/mp4" });
    Object.defineProperty(foreign, "name", { value: "video.mp4" });
    assert.equal(foreign instanceof HostBlob, false);
    let stored;
    const window = { cordova: null };
    const context = { window, document: {}, Blob: HostBlob, ArrayBuffer, DOMException, setTimeout, clearTimeout,
        SVUploadStore: { putBlob: async (_id, value) => { stored = value; } }, console };
    vm.runInNewContext(source("upload-file.js"), context);
    const task = await window.SVUploadFile.begin(foreign, "id1");
    await task.complete;
    assert.equal(stored, foreign);
});

function uploadFixture() {
    const records = [], opened = [];
    const window = { addEventListener() {} }, document = { addEventListener() {} };
    const file = { name: "content", size: 12, localURL: "cdvfile://localhost/content/provider/video", slice() {} };
    const store = { put: async record => records.push({ ...record }) };
    const files = {
        openOriginal: async record => { opened.push(record.originalUri); return file; },
        findPartial: async () => null,
        begin: async () => new Promise(() => {})
    };
    const context = { window, document, SVUploadStore: store, SVUploadFile: files, SV: { uuid: () => "id1" },
        AbortController, setTimeout, clearTimeout, performance, console };
    vm.runInNewContext(source("resumable-upload.js"), context);
    return { transfer: new window.SVResumableUpload(), file, opened, records };
}

test("la fiche conserve l'URI d'origine avant même la création de la copie", async () => {
    const e = uploadFixture();
    e.file.name = "film.mp4";
    void e.transfer.start(e.file, { title: "Film", description: "" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.records[0].originalUri, e.file.localURL);
    assert.equal(e.records[0].state, "preparing");
});

test("une copie non initialisée retrouve automatiquement l'original après réouverture", async () => {
    const e = uploadFixture();
    const record = { id: "id1", name: "film.mp4", size: 12, state: "preparing", originalUri: e.file.localURL, createdAt: 1 };
    let resumed;
    e.transfer.continueWithFile = async file => { resumed = file; };
    await e.transfer.restore(record);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.opened[0], e.file.localURL);
    assert.equal(resumed, e.file);
    assert.equal(resumed.name, "film.mp4");
    assert.equal(record.needsFile, false);
});

test("une pause volontaire attend Reprendre avant de rouvrir l'original", async () => {
    const e = uploadFixture();
    const record = { id: "id1", name: "film.mp4", size: 12, state: "paused", originalUri: e.file.localURL, createdAt: 1 };
    let resumed;
    e.transfer.continueWithFile = async file => { resumed = file; };
    await e.transfer.restore(record);
    assert.equal(e.opened.length, 0);
    await e.transfer.resume();
    assert.equal(resumed, e.file);
});

test("recrée la copie depuis l'URI après vérification de la session serveur", async () => {
    const e = uploadFixture();
    const record = { id: "id1", name: "film.mp4", size: 12, state: "preparing", offset: 0, originalUri: e.file.localURL, createdAt: 1 };
    let restarted;
    e.transfer.json = async () => { throw Object.assign(new Error("session inexistante"), { status: 404 }); };
    e.transfer.start = async (file, metadata, retained) => { restarted = { file, metadata, retained }; };
    await e.transfer.restore(record);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restarted.file, e.file);
    assert.equal(restarted.retained, record);
});

test("ne recrée pas une copie perdue si le serveur a déjà confirmé des octets", async () => {
    const e = uploadFixture();
    const record = { id: "id1", name: "film.mp4", size: 12, state: "preparing", offset: 0, originalUri: e.file.localURL, createdAt: 1 };
    let restarted = false;
    e.transfer.json = async () => ({ status: "uploading", offset: 4 });
    e.transfer.start = async () => { restarted = true; };
    await e.transfer.restore(record);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restarted, false);
    assert.equal(record.state, "error");
    assert.match(record.error, /octets existent déjà/);
});
