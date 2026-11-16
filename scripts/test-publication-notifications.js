"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../www/js/publication-notifications.js"), "utf8");

function page(storage, channel = null, href = "http://localhost/app/upload.html", failWrites = false) {
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; }
        setAttribute() {}
        append(...nodes) { this.children.push(...nodes); }
        replaceChildren(...nodes) { this.children = nodes; }
        remove() { document.body.children = document.body.children.filter(node => node !== this); }
        addEventListener(event, callback) { this.listeners[event] = callback; }
    }
    const document = { readyState: "complete", body: new Element("body"), createElement: tag => new Element(tag), addEventListener() {} };
    const listeners = {};
    const window = { addEventListener(name, callback) { (listeners[name] ||= []).push(callback); } };
    const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => {
        if (failWrites) throw new Error("Stockage indisponible");
        storage.set(key, value);
        // Comme l'événement storage du navigateur : seulement les autres vues.
        for (const other of channel || []) if (other !== listeners) {
            for (const callback of other.storage || []) callback({ key });
        }
    } };
    channel?.push(listeners);
    vm.runInNewContext(source, { document, window, localStorage, URL, location: { href }, console });
    return { document, window, notifications: window.SVPublicationNotifications };
}

test("l'avis persiste entre les pages, vise la vidéo et ne se répète pas", () => {
    const storage = new Map();
    const first = page(storage);
    first.notifications.complete({ id: "upload-1", videoId: "video-1", title: "Ma vidéo" });
    first.notifications.complete({ id: "upload-1", videoId: "video-1", title: "Ma vidéo" });
    assert.equal(first.document.body.children.length, 1);
    const second = page(storage);
    const content = second.document.body.children[0].children[0];
    assert.equal(content.children[1].textContent, "Ma vidéo est prête à être regardée.");
    const actions = content.children[2];
    assert.equal(actions.children[0].href, "http://localhost/app/index.html?video=video-1");
    actions.children[1].listeners.click();
    assert.equal(second.document.body.children.length, 0);
    assert.equal(page(storage).document.body.children.length, 0);
});

test("une publication terminée dans le studio caché apparaît sur l'accueil déjà ouvert", () => {
    const storage = new Map(), views = [];
    const studio = page(storage, views);
    const accueil = page(storage, views, "http://localhost/app/index.html");
    studio.notifications.complete({ id: "upload-1", videoId: "video-1", title: "Film" });
    studio.notifications.complete({ id: "upload-1", videoId: "video-1", title: "Film" });
    assert.equal(accueil.document.body.children.length, 1);
    let content = accueil.document.body.children[0].children[0];
    assert.equal(content.children[1].textContent, "Film est prête à être regardée.");
    assert.equal(content.children[2].children[0].href, "http://localhost/app/index.html?video=video-1");
    content.children[2].children[1].listeners.click();
    assert.equal(accueil.document.body.children.length, 0);
    assert.equal(studio.document.body.children.length, 0, "La fermeture est propagée à l'autre vue.");
});

test("ouvrir une vidéo annoncée ne recharge pas la page des transferts actifs", () => {
    const accueil = page(new Map(), null, "http://localhost/app/index.html");
    let opened, prevented = false;
    accueil.window.SVStudio = { showVideo(id) { opened = id; } };
    accueil.notifications.complete({ id: "upload", videoId: "video-cible", title: "Film" });
    const actions = accueil.document.body.children[0].children[0].children[2];
    actions.children[0].listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(opened, "video-cible");
    assert.equal(prevented, true, "Le lien ne recharge pas l'accueil.");
    assert.equal(accueil.document.body.children.length, 0);
});

test("le lien du studio intégré utilise la navigation de sa fenêtre parente", () => {
    const studio = page(new Map());
    let opened, prevented = false;
    studio.window.parent = { SVStudio: { showVideo(id) { opened = id; } } };
    studio.notifications.complete({ id: "upload", videoId: "video-cible" });
    studio.document.body.children[0].children[0].children[2].children[0].listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(opened, "video-cible");
    assert.equal(prevented, true);
});

test("plusieurs avis sont présentés successivement", () => {
    const instance = page(new Map());
    instance.notifications.complete({ id: "one", videoId: "a", title: "Première" });
    instance.notifications.complete({ id: "two", videoId: "b", title: "Deuxième" });
    let content = instance.document.body.children[0].children[0];
    assert.match(content.children[1].textContent, /Première/);
    content.children[2].children[1].listeners.click();
    content = instance.document.body.children[0].children[0];
    assert.match(content.children[1].textContent, /Deuxième/);
});

test("une notification reste visible dans la page si l'écriture locale échoue", () => {
    const storage = new Map([["sv.publication.notifications.v1", JSON.stringify({ pending: [], seen: [] })]]);
    const instance = page(storage, null, "http://localhost/app/index.html", true);
    instance.notifications.complete({ id: "one", videoId: "a", title: "Film" });
    assert.equal(instance.document.body.children.length, 1);
    const content = instance.document.body.children[0].children[0];
    assert.match(content.children[1].textContent, /Film/);
    content.children[2].children[1].listeners.click();
    assert.equal(instance.document.body.children.length, 0);
});
