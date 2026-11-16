"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function classes() {
    const values = new Set();
    return { contains: name => values.has(name), remove: name => values.delete(name),
        toggle(name, state) { state ? values.add(name) : values.delete(name); } };
}

test("le studio conserve un seul cadre et le fil reçoit retour et lien vidéo", () => {
    const handlers = {}, messages = [], frames = [], emitted = [];
    const document = { body: { classList: classes(), append(node) { frames.push(node); } },
        documentElement: { classList: classes() },
        addEventListener(name, fn) { handlers[name] = fn; },
        dispatchEvent(event) { emitted.push(event); },
        createElement() { return { hidden: false, setAttribute() {}, addEventListener(name, fn) { this[name] = fn; },
            contentWindow: { postMessage(data) { messages.push(data); } } }; } };
    const context = { window: { addEventListener() {} }, document, CustomEvent: class { constructor(type, args) { this.type = type; this.detail = args?.detail; } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/studio-shell.js"), "utf8"), context);
    const studio = context.window.SVStudio;
    studio.open();
    assert.equal(frames.length, 1);
    assert.equal(studio.isVisible(), true);
    studio.cameraMode(true);
    assert.equal(document.documentElement.classList.contains("sv-studio-camera"), true);
    studio.close();
    assert.equal(frames[0].hidden, true);
    assert.equal(document.documentElement.classList.contains("sv-studio-camera"), false);
    studio.open();
    assert.equal(frames.length, 1, "Le studio conserve son contexte entre deux ouvertures.");
    let prevented = false;
    handlers.backbutton({ preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
    assert.equal(prevented, true);
    assert.equal(studio.isVisible(), false);
    studio.showVideo("video-id");
    assert.ok(emitted.some(event => event.type === "sv:show-video" && event.detail.id === "video-id"));
    assert.ok(messages.some(message => message.visible === false));
});

test("le studio intégré réutilise le pont Cordova parent et relaye deviceready", () => {
    const childHandlers = {}, parentHandlers = {}, channelCallbacks = [];
    const parent = { SVStudio: {}, CameraPreview: { marker: 1 }, resolveLocalFileSystemURL() {}, document: {
        addEventListener(name, fn) { parentHandlers[name] = fn; }
    }, cordova: { require(name) {
        assert.equal(name, "cordova/channel");
        return { onDeviceReady: { subscribe(fn) { channelCallbacks.push(fn); } } };
    } } };
    const document = { addEventListener(name, fn) { childHandlers[name] = fn; }, dispatchEvent(event) { this.events.push(event.type); },
        events: [], write() { throw new Error("Le cadre ne doit pas charger un second pont."); } };
    const window = { parent };
    const context = { window, document, Event: class { constructor(type) { this.type = type; } }, Object };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/upload-bootstrap.js"), "utf8"), context);
    assert.equal(window.cordova, parent.cordova);
    assert.equal(window.CameraPreview, parent.CameraPreview);
    assert.equal(window.resolveLocalFileSystemURL, parent.resolveLocalFileSystemURL);
    childHandlers.DOMContentLoaded();
    channelCallbacks[0]();
    parentHandlers.pause();
    parentHandlers.resume();
    assert.deepEqual(document.events, ["deviceready", "pause", "resume"]);
});

test("deux pages qui attendent la restauration partagent une seule lecture et un seul transfert", async () => {
    let release, calls = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const context = { window: { dispatchEvent() {} }, CustomEvent: class {},
        SVUploadStore: { async list() { calls++; return pending; } },
        SVResumableUpload: class { async restore(record) { this.record = record; } }, console };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/upload-manager.js"), "utf8"), context);
    const manager = new context.window.SVUploadManager();
    const first = manager.restore();
    const second = manager.restore();
    release([{ id: "a", state: "paused", createdAt: 1 }]);
    assert.deepEqual(await Promise.all([first, second]), [1, 1]);
    assert.equal(calls, 1);
    assert.equal(manager.transfers.length, 1);
    assert.equal(manager.transfers[0].record.state, "paused");
});
