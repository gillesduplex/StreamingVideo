"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createFeed() {
    const context = { SV: {}, window: {}, document: {}, AbortController, URL, setTimeout, clearTimeout,
        requestAnimationFrame: fn => setTimeout(fn, 0), console };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/video-feed.js"), "utf8"), context);
    const feed = Object.create(context.SV.VideoFeed.prototype);
    const container = { clientHeight: 800, scrollTop: 800, scrollTo({ top }) { this.scrollTop = top; } };
    const video = { currentTime: 42, paused: true, pause() { this.paused = true; } };
    Object.assign(feed, { container, index: 1, items: [{ id: "a" }, { id: "b" }, { id: "c" }],
        active: { item: { id: "b" }, video }, wantPlayback: false, scrolling: false, touching: false, mutating: false,
        destroyed: false, scrollTarget: null, startActive() {}, preloadCovers() {}, setStatus() {},
        select(index) { this.index = index; this.selections.push(index); }, selections: [] });
    return { feed, container, video };
}

test("la rotation conserve carte, position et pause sans interpréter le déplacement comme un défilement", async () => {
    const { feed, container, video } = createFeed();
    feed.protectLayout();
    container.clientHeight = 400;
    // L'ancien scrollTop correspondrait à la troisième carte après rotation.
    container.scrollTop = 800;
    feed.handleScroll();
    feed.settle();
    assert.equal(feed.index, 1);
    assert.equal(feed.active.video, video);
    assert.equal(video.currentTime, 42);
    assert.equal(feed.wantPlayback, false);
    assert.equal(video.paused, true);
    const deadline = Date.now() + 1500;
    while (feed.layoutLocked && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(feed.layoutLocked, false);
    assert.equal(container.scrollTop, 400);
    assert.deepEqual(feed.selections, []);
    // Le défilement volontaire reste possible une fois la transition finie.
    container.scrollTop = 800;
    feed.handleScroll();
    feed.settle();
    assert.deepEqual(feed.selections, [2]);
    clearTimeout(feed.scrollTimer);
});

function playableFeed(play) {
    const result = createFeed();
    const { feed, video } = result;
    delete feed.startActive;
    Object.assign(feed, { callbacks: {}, sound: false, suspended: false, requestFrame() {} });
    Object.assign(feed.active, { generation: 1, manifestReady: true, blocked: false, fatal: false,
        rebuffering: false, loading: true, playPromise: null });
    feed.slots = [feed.active];
    video.ended = false;
    video.play = play || (() => { video.paused = false; return Promise.resolve(); });
    return result;
}

test("une pause système pendant l'entrée et la sortie du plein écran reprend au même endroit", async () => {
    const { feed, video } = playableFeed();
    feed.wantPlayback = true;
    video.paused = false;
    for (let transition = 0; transition < 2; transition++) {
        feed.protectLayout();
        // Android met le lecteur en pause après l'événement de changement de taille.
        video.paused = true;
        feed.scheduleLayoutResume(feed.active);
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(video.paused, false);
        assert.equal(video.currentTime, 42);
        assert.equal(feed.index, 1);
    }
    clearTimeout(feed.layoutTimer);
    clearTimeout(feed.layoutResumeTimer);
});

test("une pause volontaire ou une suspension ne relance jamais la vidéo", async () => {
    const { feed, video } = playableFeed();
    let count = 0;
    video.play = () => { count++; video.paused = false; return Promise.resolve(); };
    feed.wantPlayback = false;
    feed.protectLayout();
    feed.scheduleLayoutResume(feed.active);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(count, 0);
    assert.equal(video.paused, true);
    feed.wantPlayback = true;
    feed.suspended = true;
    feed.scheduleLayoutResume(feed.active);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(count, 0);
    clearTimeout(feed.layoutTimer);
    clearTimeout(feed.layoutResumeTimer);
});

test("après plusieurs lectures interrompues, le bouton de reprise reste disponible", async () => {
    const { feed, video } = playableFeed();
    let count = 0;
    video.play = () => { count++; return Promise.reject(Object.assign(new Error("interrompu"), { name: "AbortError" })); };
    feed.wantPlayback = true;
    feed.layoutRecoveryUntil = Date.now() + 5000;
    feed.scheduleLayoutResume(feed.active);
    await new Promise(resolve => setTimeout(resolve, 3400));
    assert.equal(count, 15);
    assert.equal(feed.active.blocked, true);
    assert.equal(video.currentTime, 42);
    clearTimeout(feed.layoutResumeTimer);
});

test("une interruption temporaire pendant la rotation finit par reprendre", async () => {
    const { feed, video } = playableFeed();
    let count = 0;
    video.play = () => {
        count++;
        if (count < 6) return Promise.reject(Object.assign(new Error("rotation"), { name: "AbortError" }));
        video.paused = false;
        return Promise.resolve();
    };
    feed.wantPlayback = true;
    feed.layoutRecoveryUntil = Date.now() + 5000;
    feed.scheduleLayoutResume(feed.active);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(count, 6);
    assert.equal(video.paused, false);
    assert.equal(feed.active.blocked, false);
    clearTimeout(feed.layoutResumeTimer);
});

test("la reprise après une coupure repart dès qu'une réserve de 1,5 seconde est prête", () => {
    const { feed, video } = playableFeed();
    video.duration = 90;
    video.currentTime = 20;
    feed.wantPlayback = true;
    feed.active.rebuffering = true;
    let ahead = 1.49, starts = 0;
    feed.bufferedAhead = () => ahead;
    feed.startActive = () => starts++;
    feed.resumeAfterBuffer(feed.active);
    assert.equal(feed.active.rebuffering, true);
    ahead = 1.5;
    feed.resumeAfterBuffer(feed.active);
    assert.equal(feed.active.rebuffering, false);
    assert.equal(starts, 1);
});
