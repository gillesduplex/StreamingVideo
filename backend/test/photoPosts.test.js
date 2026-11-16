"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { creerPhotoPosts } = require("../services/photoPosts");
const { analyserVideo } = require("../services/videoProcessor");
const ffmpegPath = require("ffmpeg-static");

const uuid = "11111111-1111-4111-8111-111111111111";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r3sAAAAASUVORK5CYII=", "base64");
const root = path.join(os.tmpdir(), "streamingvideo-photo-posts-" + process.pid);
const paths = {
    temporaires: path.join(root, "temporaires"),
    originauxDir: path.join(root, "originaux"),
    sonsDir: path.join(root, "sounds")
};
let server;
let origin;
let insertion;
let queued;

function creerVideoAudio(file) {
    const result = spawnSync(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", file
    ], { windowsHide: true });
    assert.equal(result.status, 0, result.stderr.toString());
}

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
});

test("publishes an ordered photo slideshow and queues it for HLS", async () => {
    await Promise.all(Object.values(paths).map(directory => fs.mkdir(directory, { recursive: true })));
    const app = express();
    app.use((req, res, next) => { req.profile = req.get("X-Test-No-Profile") ? null : { id: uuid }; next(); });
    app.use("/api/photo-posts", creerPhotoPosts({
        ...paths,
        db: { async query(sql, values) { insertion = { sql, values }; return { rowCount: 1 }; } },
        enqueue(id, file) { queued = { id, file }; },
        analyser: analyserVideo
    }));
    app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = "http://127.0.0.1:" + server.address().port;

    const form = new FormData();
    form.append("titre", "Deux instants");
    form.append("photos", new Blob([png], { type: "image/png" }), "premiere.png");
    form.append("photos", new Blob([png], { type: "image/png" }), "deuxieme.png");
    const response = await fetch(origin + "/api/photo-posts", { method: "POST", body: form });
    const result = await response.json();

    assert.equal(response.status, 202);
    assert.equal(result.statut, "en_attente");
    assert.equal(result.media_type, "photo");
    assert.equal(result.photo_count, 2);
    assert.equal(insertion.values[6], 2);
    assert.equal(insertion.values[7], 3);
    assert.ok(insertion.values[9] >= 5.5 && insertion.values[9] <= 6.5, "Durée du diaporama: " + insertion.values[9]);
    assert.equal(queued.id, result.id);
    assert.equal(path.dirname(queued.file), paths.originauxDir);
    assert.equal((await fs.stat(queued.file)).isFile(), true);
});

test("rejects photo posts without a selected image", async () => {
    const response = await fetch(origin + "/api/photo-posts", { method: "POST", body: new FormData() });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.match(result.message, /au moins une photo/i);
});

test("rejects anonymous uploads before writing photo files", async () => {
    const form = new FormData();
    form.append("photos", new Blob([png], { type: "image/png" }), "photo.png");
    const response = await fetch(origin + "/api/photo-posts", {
        method: "POST",
        headers: { "X-Test-No-Profile": "1" },
        body: form
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await fs.readdir(paths.temporaires), []);
});

test("lists only administrator-provided sound files", async () => {
    await fs.writeFile(path.join(paths.sonsDir, "son_autorise.mp3"), "catalogue");
    await fs.writeFile(path.join(paths.sonsDir, "ignore.txt"), "not audio");
    const response = await fetch(origin + "/api/photo-posts/sounds");
    const sounds = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(sounds.map(sound => sound.id), ["son_autorise.mp3"]);
    assert.equal(sounds[0].title, "son autorise");
});

test("extracts audio from a selected video and keeps catalog files intact", async () => {
    const videoPath = path.join(root, "source.mp4");
    const soundPath = path.join(paths.sonsDir, "son_admin.mp3");
    creerVideoAudio(videoPath);
    const audio = spawnSync(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
        "-c:a", "libmp3lame", "-b:a", "64k", soundPath
    ], { windowsHide: true });
    assert.equal(audio.status, 0, audio.stderr.toString());

    const localForm = new FormData();
    localForm.append("photos", new Blob([png], { type: "image/png" }), "local.png");
    localForm.append("audio", new Blob([await fs.readFile(soundPath)], { type: "audio/mpeg" }), "musique.mp3");
    const localResponse = await fetch(origin + "/api/photo-posts", { method: "POST", body: localForm });
    assert.equal(localResponse.status, 202);
    assert.equal(insertion.values[8], "musique");

    const form = new FormData();
    form.append("photos", new Blob([png], { type: "image/png" }), "photo.png");
    form.append("sourceVideo", new Blob([await fs.readFile(videoPath)], { type: "video/mp4" }), "source.mp4");
    const response = await fetch(origin + "/api/photo-posts", { method: "POST", body: form });
    const result = await response.json();
    assert.equal(response.status, 202, result.message);
    assert.match(insertion.values[8], /son extrait/);
    assert.equal(queued.id, result.id);
    assert.equal((await fs.stat(soundPath)).isFile(), true);

    const catalogForm = new FormData();
    catalogForm.append("photos", new Blob([png], { type: "image/png" }), "catalogue.png");
    catalogForm.append("soundId", "son_admin.mp3");
    const catalogResponse = await fetch(origin + "/api/photo-posts", { method: "POST", body: catalogForm });
    assert.equal(catalogResponse.status, 202);
    assert.match(insertion.values[8], /son admin/);
    assert.equal((await fs.stat(soundPath)).isFile(), true, "La publication ne supprime pas le son administré.");
});
