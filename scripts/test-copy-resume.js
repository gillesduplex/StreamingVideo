"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup({ missing = false, modified = false } = {}) {
    const original = Buffer.from("une vidéo pour vérifier la reprise");
    let saved = Buffer.from(original.subarray(0, 7));
    const writes = [];
    const entry = {
        file(callback) { callback(new Blob([saved])); },
        createWriter(callback) {
            let position = 0;
            callback({
                seek(value) { position = value; },
                write(bytes) {
                    const chunk = Buffer.from(bytes);
                    writes.push(position);
                    saved = Buffer.concat([saved.subarray(0, position), chunk, saved.subarray(position + chunk.length)]);
                    setTimeout(() => this.onwriteend(), 0);
                }
            });
        }
    };
    const dir = { getFile(_name, _options, callback) { callback(entry); } };
    const root = { getDirectory(_name, _options, callback) { callback(dir); } };
    const originalEntry = { file(callback) {
        const blob = new Blob([modified ? Buffer.from("différent") : original]);
        callback(blob);
    } };
    const window = {
        cordova: { file: { dataDirectory: "private" } },
        resolveLocalFileSystemURL(uri, resolve, reject) {
            if (uri === "private") resolve(root);
            else if (uri === "original" && !missing) resolve(originalEntry);
            else reject(new Error("source absente"));
        }
    };
    class FileReader {
        readAsArrayBuffer(blob) {
            blob.arrayBuffer().then(value => { this.result = value; this.onload(); }, error => { this.error = error; this.onerror(); });
        }
    }
    const sandbox = { window, document: { addEventListener() {} }, Blob, FileReader, ArrayBuffer, DOMException, setTimeout, console };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/upload-file.js"), "utf8"), sandbox);
    const source = { id: "test-1", kind: "cordova", originalUri: "original", size: original.length };
    return { files: window.SVUploadFile, source, original, saved: () => saved, writes };
}

test("reprend la copie privée à sa taille réelle quand l'original reste accessible", async () => {
    const e = setup();
    const progress = [];
    const task = await e.files.resumeCopy(e.source, value => progress.push(value));
    await task.complete;
    assert.deepEqual(e.saved(), e.original);
    assert.equal(progress[0], 7);
    assert.equal(progress.at(-1), e.original.length);
    assert.deepEqual(e.writes, [7], "Les octets déjà copiés ne sont pas réécrits");
});

test("reprend avec le fichier choisi à nouveau sans URI, après comparaison du préfixe", async () => {
    const e = setup({ missing: true });
    delete e.source.originalUri;
    const selected = new Blob([e.original]);
    const task = await e.files.resumeCopy(e.source, () => {}, undefined, selected);
    await task.complete;
    assert.deepEqual(e.saved(), e.original);
    assert.deepEqual(e.writes, [7]);
});

test("refuse un fichier différent de même taille avant toute écriture", async () => {
    const e = setup();
    const different = Buffer.from(e.original);
    different[0] ^= 1;
    const task = await e.files.resumeCopy(e.source, () => {}, undefined, new Blob([different]));
    await assert.rejects(task.complete, /ne correspond pas/);
    assert.equal(e.saved().length, 7);
    assert.deepEqual(e.writes, []);
});

test("signale un original perdu ou modifié sans compléter la copie", async () => {
    for (const options of [{ missing: true }, { modified: true }]) {
        const e = setup(options);
        const task = await e.files.resumeCopy(e.source);
        await assert.rejects(task.complete, /inaccessible|changé/);
        assert.equal(e.saved().length, 7);
    }
});
