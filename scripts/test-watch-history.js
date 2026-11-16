"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(navigation = "navigate", saved = new Map()) {
    const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
    const context = { SV: {}, window: { sessionStorage: storage, performance: { getEntriesByType: () => [{ type: navigation }] },
        matchMedia: () => ({ matches: false }) }, document: {}, AbortController, URL, setTimeout, clearTimeout, console };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/video-feed.js"), "utf8"), context);
    const feed = Object.create(context.SV.VideoFeed.prototype);
    Object.assign(feed, { watchHistory: new Map(), historyKey: "sv.watch-history.session.v1", historyLastSave: 0 });
    return { feed, saved };
}

function makeSlot(id, time = 0) {
    const video = { currentTime: time, duration: 120, readyState: 1, muted: false, pause() {}, setAttribute() {}, removeAttribute() {} };
    const card = { classList: { add() {}, remove() {} }, append() {} };
    return { item: id ? { id, titre: id, duree: 120 } : null, video, card, resumePosition: null };
}

test("reprend une vidéo après le recyclage de son lecteur et conserve les autres positions", () => {
    const { feed } = fixture();
    const a = makeSlot("a", 42), spare = makeSlot();
    Object.assign(feed, { active: a, slots: [a, spare], items: ["a", "b", "c"].map(id => ({ id, titre: id, duree: 120 })),
        index: 0, callbacks: {}, destroyed: false, container: { scrollTo() {} },
        preloadCovers() {}, setStatus() {}, startActive() {}, reportLevels() {},
        prepare(slot, item, position) { slot.item = item; slot.video.currentTime = 0; slot.resumePosition = position; } });
    feed.select(1, { scroll: false });
    assert.equal(feed.historyItems()[0].position, 42);
    feed.active.video.currentTime = 15;
    feed.select(2, { scroll: false });
    feed.active.video.currentTime = 8;
    feed.select(0, { scroll: false });
    assert.equal(feed.active.video.currentTime, 42);
    assert.equal(feed.watchHistory.get("b").position, 15);
});

test("applique aussi la position à un lecteur déjà préchargé", () => {
    const { feed } = fixture();
    const a = makeSlot("a", 5), b = makeSlot("b", 0);
    feed.watchHistory.set("b", { item: { id: "b" }, position: 55 });
    Object.assign(feed, { active: a, slots: [a, b], items: [{ id: "a" }, { id: "b" }], index: 0, callbacks: {},
        destroyed: false, preloadCovers() {}, setStatus() {}, startActive() {}, reportLevels() {} });
    feed.select(1, { scroll: false });
    assert.equal(feed.active, b);
    assert.equal(b.video.currentTime, 55);
});

test("attend les métadonnées sans remplacer la position sauvegardée par zéro", () => {
    const { feed } = fixture();
    const slot = makeSlot("a", 0);
    slot.video.readyState = 0;
    slot.resumePosition = 42;
    feed.watchHistory.set("a", { item: { id: "a" }, position: 42 });
    feed.restorePosition(slot);
    feed.remember(slot, true);
    assert.equal(feed.watchHistory.get("a").position, 42);
    assert.equal(slot.resumePosition, 42);
    slot.video.readyState = 1;
    feed.restorePosition(slot);
    assert.equal(slot.video.currentTime, 42);
    assert.equal(slot.resumePosition, null);
});

test("retrouve la session entre pages mais efface l'historique à l'actualisation", () => {
    const initial = fixture();
    initial.feed.remember(makeSlot("a", 42), true);
    const next = fixture("navigate", initial.saved);
    next.feed.restoreHistory();
    assert.equal(next.feed.historyItems()[0].position, 42);
    const refreshed = fixture("reload", initial.saved);
    refreshed.feed.restoreHistory();
    assert.equal(refreshed.feed.historyItems().length, 0);
    assert.equal(initial.saved.size, 0);
});

test("une vidéo arrivée à la fin recommence au début lors de sa prochaine lecture", () => {
    const { feed } = fixture();
    feed.remember(makeSlot("a", 120), true);
    assert.equal(feed.watchHistory.get("a").position, 0);
    assert.equal(feed.watchHistory.get("a").finished, true);
});
