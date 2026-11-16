"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ deferred = false, web = false, webLock = false } = {}) {
    const handlers = new Map(), classes = new Set(), attrs = {};
    let releaseLock, landscape = 0, restore = 0, toast = 0;
    const steps = [];
    let isLandscape = false;
    const windowHandlers = new Map();
    const changeOrientation = value => {
        isLandscape = value;
        windowHandlers.get("orientationchange")?.();
        windowHandlers.get("resize")?.();
    };
    const document = {
        fullscreenElement: null,
        addEventListener(name, fn) { handlers.set(name, fn); },
        removeEventListener(name, fn) { if (handlers.get(name) === fn) handlers.delete(name); },
        dispatchEvent(event) { steps.push(event.type); },
        async exitFullscreen() { steps.push("exit"); this.fullscreenElement = null; handlers.get("fullscreenchange")?.(); }
    };
    const scene = { classList: {
        add(name) { classes.add(name); steps.push("scene-enter"); },
        remove(name) { classes.delete(name); steps.push("scene-exit"); },
        contains: name => classes.has(name)
    }, async requestFullscreen() { steps.push("fullscreen"); document.fullscreenElement = scene; handlers.get("fullscreenchange")?.(); } };
    const button = { addEventListener(_event, fn) { this.click = fn; }, setAttribute(name, value) { attrs[name] = value; }, replaceChildren() {} };
    const native = {
        landscape(ok) {
            landscape++; steps.push("landscape");
            if (deferred) releaseLock = () => { changeOrientation(true); ok(); };
            else { changeOrientation(true); ok(); }
        },
        restore(ok) { restore++; steps.push("restore"); changeOrientation(false); ok(); }
    };
    const window = {
        cordova: web ? null : { plugins: { SVScreenOrientation: native } },
        screen: { orientation: web ? {
            async lock() {
                if (!webLock) throw new Error("non autorisé");
                changeOrientation(true);
            },
            unlock() { restore++; changeOrientation(false); }
        } : {} },
        addEventListener(name, fn) { windowHandlers.set(name, fn); },
        removeEventListener(name, fn) { if (windowHandlers.get(name) === fn) windowHandlers.delete(name); },
        matchMedia: query => ({ get matches() { return query.includes("portrait") ? !isLandscape : isLandscape; } })
    };
    const screen = window.screen;
    const context = { window, document, screen, console: { warn() {} }, Promise, Event: class { constructor(type) { this.type = type; } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/fullscreen-player.js"), "utf8"), context);
    const player = new window.SVFullscreenPlayer({ scene, button, icon: name => name, toast: () => toast++ });
    return { player, button, attrs, document, scene, handlers, classes, steps, releaseLock: () => releaseLock(), counts: () => ({ landscape, restore, toast }) };
}

test("affiche le bouton seulement pour une durée strictement supérieure à une minute", () => {
    const e = fixture();
    for (const seconds of [0, 59, 60]) { e.player.setDuration(seconds); assert.equal(e.button.hidden, true); }
    e.player.setDuration(60.1); assert.equal(e.button.hidden, false);
});

test("verrouille le paysage et restaure l'orientation au retour Android", async () => {
    const e = fixture(); e.player.setDuration(90); await e.player.open();
    assert.equal(e.classes.has("video-fullscreen"), true);
    assert.equal(e.attrs["aria-pressed"], "true");
    assert.equal(e.counts().landscape, 1);
    let prevented = false;
    e.handlers.get("backbutton")({ preventDefault() { prevented = true; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prevented, true);
    assert.equal(e.counts().restore, 1);
    assert.equal(e.classes.has("video-fullscreen"), false);
    assert.equal(e.handlers.has("backbutton"), false);
    assert.ok(e.steps.indexOf("landscape") < e.steps.indexOf("scene-enter"), "Le téléphone pivote avant l'agrandissement du lecteur.");
    assert.ok(e.steps.indexOf("restore") < e.steps.indexOf("scene-exit"), "Le lecteur reste agrandi jusqu'au retour en portrait.");
    assert.equal(e.steps.includes("fullscreen"), false, "Cordova évite le changement de plein écran natif qui interrompait la lecture.");
    assert.ok(e.steps.lastIndexOf("sv:feed-layout-change") > e.steps.indexOf("restore"), "Le fil est réévalué après le retour d'orientation.");
});

test("restaure une demande d'orientation qui se termine après la sortie", async () => {
    const e = fixture({ deferred: true }); e.player.setDuration(90);
    const opening = e.player.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.counts().landscape, 1);
    const closing = e.button.click();
    e.releaseLock();
    await Promise.all([opening, closing]);
    assert.equal(e.counts().restore, 1);
    assert.equal(e.classes.has("video-fullscreen"), false);
    assert.equal(e.document.fullscreenElement, null);
});

test("la sortie du plein écran par le système restaure aussi l'orientation", async () => {
    const e = fixture({ web: true, webLock: true }); e.player.setDuration(90); await e.player.open();
    await e.document.exitFullscreen();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.counts().restore, 1);
    assert.equal(e.classes.has("video-fullscreen"), false);
});

test("lorsque le navigateur refuse l'orientation le lecteur reste utilisable et explique le repli", async () => {
    const e = fixture({ web: true }); e.player.setDuration(90); await e.player.open();
    assert.equal(e.classes.has("video-fullscreen"), true);
    assert.equal(e.counts().toast, 1);
    e.player.close();
    assert.equal(e.classes.has("video-fullscreen"), false);
});
