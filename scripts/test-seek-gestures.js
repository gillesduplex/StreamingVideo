"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function environment({ current = 30, duration = 90, portrait = true } = {}) {
    let now = 0, next = 0;
    const timers = new Map(), handlers = new Map();
    const createTimer = (fn, delay, repeat) => { const id = ++next; timers.set(id, { fn, at: now + delay, delay, repeat }); return id; };
    const clock = { setTimeout: (fn, ms) => createTimer(fn, ms, false), setInterval: (fn, ms) => createTimer(fn, ms, true),
        clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id) };
    const advance = ms => {
        const end = now + ms;
        while (true) {
            const due = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            const [id, timer] = due; now = timer.at;
            if (timer.repeat) timer.at += timer.delay; else timers.delete(id);
            timer.fn();
        }
        now = end;
    };
    const badge = { className: "", hidden: true, textContent: "", setAttribute() {}, classList: { toggle() {} } };
    const scene = { classList: { contains: () => false }, addEventListener: (type, fn) => handlers.set(type, fn),
        getBoundingClientRect: () => ({ left: 0, width: 100 }), append() {} };
    const video = { currentTime: current, duration, playbackRate: 1, paused: false };
    const feed = { video, seek(value) { video.currentTime = value * duration; } };
    const context = { window: { matchMedia: () => ({ matches: portrait }), addEventListener() {} },
        document: { createElement: () => badge, addEventListener() {} }, Date, console, ...clock };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/seek-gestures.js"), "utf8"), context);
    const gesture = new context.window.SVSeekGestures({ scene, feed });
    const target = { closest: selector => selector === ".feed-card" ? {} : null };
    const touch = (x, y = 10) => ({ identifier: 1, clientX: x, clientY: y });
    const start = (x, element = target) => handlers.get("touchstart")({ touches: [touch(x)], target: element });
    const move = (x, y) => handlers.get("touchmove")({ touches: [touch(x, y)], cancelable: true, preventDefault() { this.prevented = true; } });
    const end = () => { const e = { changedTouches: [touch(10)], cancelable: true, preventDefault() { this.prevented = true; } }; handlers.get("touchend")(e); return e; };
    return { video, badge, feed, gesture, handlers, advance, start, move, end };
}

test("un maintien à droite avance de 10 puis 20 secondes sans changer la vitesse", () => {
    const e = environment(); e.start(90); e.advance(499);
    assert.equal(e.video.currentTime, 30);
    e.advance(1); assert.equal(e.video.currentTime, 40); assert.equal(e.badge.textContent, "+10 s");
    e.advance(650); assert.equal(e.video.currentTime, 50); assert.equal(e.badge.textContent, "+20 s");
    assert.equal(e.video.playbackRate, 1);
    assert.equal(e.end().prevented, true);
    e.advance(3000); assert.equal(e.video.currentTime, 50); assert.equal(e.badge.hidden, true);
});

test("un maintien à gauche recule et s'arrête à zéro", () => {
    const e = environment({ current: 15 }); e.start(10); e.advance(500);
    assert.equal(e.video.currentTime, 5); assert.equal(e.badge.textContent, "−10 s");
    e.advance(650); assert.equal(e.video.currentTime, 0); assert.equal(e.badge.textContent, "−15 s");
    e.end();
});

test("un balayage et les commandes ne déclenchent pas le geste, mais le paysage reste disponible", () => {
    const e = environment(); e.start(90); e.move(90, 40); e.advance(2000); assert.equal(e.video.currentTime, 30);
    const control = { closest: selector => selector === ".feed-card" ? {} : {} };
    e.start(90, control); e.advance(1000); assert.equal(e.video.currentTime, 30);
    const landscape = environment({ portrait: false }); landscape.start(90); landscape.advance(1000);
    assert.equal(landscape.video.currentTime, 40);
    landscape.end();
});

test("un maintien au centre accélère à 2x en paysage puis restaure la vitesse précédente", () => {
    const e = environment({ portrait: false });
    e.video.playbackRate = 1.5;
    e.start(50); e.advance(499);
    assert.equal(e.video.playbackRate, 1.5);
    e.advance(1);
    assert.equal(e.video.playbackRate, 2);
    assert.equal(e.badge.textContent, "2×");
    e.advance(600);
    e.end();
    assert.equal(e.video.playbackRate, 1.5);
});

test("un clic après maintien est annulé mais une nouvelle tape normale reste disponible", () => {
    const e = environment(); e.start(90); e.advance(500); e.end();
    const target = { closest: selector => selector === ".feed-card" ? {} : null };
    const click = { target, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    e.handlers.get("click")(click); assert.equal(click.prevented, true); assert.equal(click.stopped, true);
    e.start(50); e.end();
    const next = { target, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
    e.handlers.get("click")(next); assert.equal(next.prevented, undefined);
});

test("l'avance reste en deçà de la fin et s'arrête si la vidéo change", () => {
    const e = environment({ current: 88, duration: 90 }); e.start(90); e.advance(500);
    assert.equal(e.video.currentTime, 89.75);
    e.feed.video = { currentTime: 0, duration: 90 }; e.advance(650);
    assert.equal(e.feed.video.currentTime, 0); assert.equal(e.gesture.hold, null);
});
