"use strict";

// Vérifie les transitions du vrai script du studio sans caméra ni réseau.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("une nouvelle sélection reste éditable pendant les mises à jour d'une autre publication", async () => {
    class Classes {
        constructor() { this.values = new Set(); }
        add(value) { this.values.add(value); }
        remove(value) { this.values.delete(value); }
        contains(value) { return this.values.has(value); }
        toggle(value, force) { const next = force === undefined ? !this.contains(value) : force; next ? this.add(value) : this.remove(value); return next; }
    }
    class Element {
        constructor() { this.hidden = false; this.value = ""; this.textContent = ""; this.classList = new Classes(); this.handlers = {}; this.children = []; this.parts = {}; }
        addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
        async trigger(name, event = { target: this }) { for (const fn of this.handlers[name] || []) await fn(event); }
        appendChild(element) { this.children.push(element); }
        replaceChildren(...elements) { this.children = elements; }
        click() { this.clicked = true; }
        setAttribute() {}
        removeAttribute() {}
        pause() {}
        load() {}
        play() { return Promise.resolve(); }
        querySelector(selector) { return this.parts[selector] ||= new Element(); }
        remove() {}
    }
    const html = fs.readFileSync(path.join(__dirname, "../www/upload.html"), "utf8");
    const ids = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
    const body = new Element();
    const document = { body, head: new Element(), documentElement: new Element(),
        getElementById(id) { return ids.get(id) || null; }, createElement() { return new Element(); }, addEventListener() {} };
    // Éviter la construction décorative du bouton natif ; la caméra n'est pas nécessaire ici.
    ids.set("retournerBas", new Element());
    let manager;
    class Manager {
        constructor(options) { this.options = options; this.transfers = []; manager = this; }
        async restore() { return 0; }
        start(file, metadata) {
            const transfer = { record: { id: file.name, name: file.name, title: metadata.title, size: file.size,
                state: "uploading", offset: 0, copyComplete: true }, pause: async () => {}, resume() {}, cancel: async () => {} };
            this.transfers.push(transfer);
            this.options.onUpdate(transfer.record, {}, transfer);
            return Promise.resolve();
        }
        update(transfer, offset) { transfer.record.offset = offset; this.options.onUpdate(transfer.record, {}, transfer); }
    }
    const fakeURL = { createObjectURL: file => "blob:" + file.name, revokeObjectURL() {} };
    const window = { APP_CONFIG: {}, addEventListener() {} };
    const context = vm.createContext({ window, document, navigator: {}, location: { port: "", origin: "http://localhost" },
        SV: { api: async () => ({ pseudo: "Test" }) }, SVUploadManager: Manager, URL: fakeURL, Blob,
        console: { log() {}, error() {}, warn() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../www/upload.js"), "utf8"), context);
    await new Promise(resolve => setImmediate(resolve));

    const node = id => ids.get(id);
    const choose = async name => node("fichier").trigger("change", { target: { files: [{ name, size: 100, type: "video/mp4" }] } });
    await choose("a.mp4");
    await node("envoyer").trigger("click");
    assert.equal(manager.transfers.length, 1);
    assert.equal(body.classList.contains("publication-en-cours"), true);
    assert.equal(node("nouvellePublication").hidden, false);

    await node("nouvellePublication").trigger("click");
    await new Promise(resolve => setImmediate(resolve));
    await choose("b.mp4");
    node("descriptionPublication").value = "Mon brouillon";
    manager.update(manager.transfers[0], 50);
    assert.equal(body.classList.contains("publication-en-cours"), false, "L'ancien transfert ne masque pas le studio");
    assert.equal(node("commandesApercu").hidden, false);
    assert.equal(node("suivrePublications").hidden, false);

    await node("suivrePublications").trigger("click");
    assert.equal(body.classList.contains("publication-en-cours"), true);
    assert.equal(node("transfertListe").children.length, 1);
    assert.equal(node("transfertListe").children[0].querySelector(".pourcent").textContent, "50 %");
    await node("nouvellePublication").trigger("click");
    assert.equal(node("descriptionPublication").value, "Mon brouillon", "Le brouillon survit au suivi");
    assert.equal(node("commandesApercu").hidden, false);
    await node("envoyer").trigger("click");
    assert.equal(manager.transfers.length, 2);
    assert.equal(manager.transfers[1].record.name, "b.mp4");
    assert.equal(node("transfertListe").children.length, 2);
    assert.equal(node("transfertListe").children[0].querySelector(".pourcent").textContent, "50 %");

    // Sur Android, la galerie doit passer par le sélecteur à accès durable.
    let pickerCalls = 0;
    const durableFile = { name: "c.mp4", size: 100, type: "video/mp4", localURL: "content://video/c", previewURL: "content://video/c" };
    window.SVPersistentPicker = { available: () => true, select: async () => { pickerCalls++; return [durableFile]; } };
    await node("nouvellePublication").trigger("click");
    await node("galerie").trigger("click");
    assert.equal(pickerCalls, 1);
    assert.equal(node("apercu").src, durableFile.previewURL);
    await node("envoyer").trigger("click");
    assert.equal(manager.transfers.length, 3);
    assert.equal(manager.transfers[2].record.name, "c.mp4");

    await node("galeriePhotos").trigger("click");
    assert.equal(node("fichierPhotos").clicked, true, "Le bouton Photos ouvre le sélecteur d'images.");
    await node("fichierPhotos").trigger("change", { target: { files: [
        { name: "photo-a.jpg", size: 100, type: "image/jpeg" },
        { name: "photo-b.png", size: 100, type: "image/png" }
    ] } });
    assert.equal(node("apercuPhotos").hidden, false);
    assert.equal(node("compteurApercuPhotos").textContent, "1/2");
    await node("photoApercuSuivante").trigger("click");
    assert.equal(node("compteurApercuPhotos").textContent, "2/2", "L'aperçu permet de parcourir les photos sélectionnées.");
});
