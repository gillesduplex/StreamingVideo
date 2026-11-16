const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { creerFileTraitement } = require("../services/processingQueue");

async function attendre(predicate) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Délai dépassé dans la file de traitement");
}

test("deux vidéos courtes ensemble, une vidéo longue exclusive, FIFO et sans doublon", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sv-file-"));
    const source = path.join(dir, "source");
    await fs.writeFile(source, "test");
    const commences = [];
    const terminer = new Map();
    const ajouter = creerFileTraitement({
        analyser: async chemin => ({ duree: chemin.endsWith("long") ? 300 : 15, largeur: 640, hauteur: 360, fpsSource: 30 }),
        cpus: () => 4,
        memoireLibre: () => 2 * 1024 ** 3,
        traiter: id => new Promise(resolve => { commences.push(id); terminer.set(id, resolve); })
    });
    try {
        const long = path.join(dir, "long");
        await fs.writeFile(long, "test");
        ajouter("a", source);
        ajouter("a", source);
        ajouter("b", source);
        ajouter("c", long);
        ajouter("d", source);
        await attendre(() => commences.length === 2);
        assert.deepEqual(commences, ["a", "b"]);
        terminer.get("a")();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(commences, ["a", "b"]);
        terminer.get("b")();
        await attendre(() => commences.length === 3);
        assert.deepEqual(commences, ["a", "b", "c"]);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(commences.length, 3);
        terminer.get("c")();
        await attendre(() => commences.length === 4);
        assert.deepEqual(commences, ["a", "b", "c", "d"]);
        terminer.get("d")();
    } finally {
        await fs.unlink(source).catch(() => {});
        await fs.unlink(path.join(dir, "long")).catch(() => {});
        await fs.rmdir(dir);
    }
});

test("une seule vidéo en cas de mémoire insuffisante", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sv-file-"));
    const source = path.join(dir, "source");
    await fs.writeFile(source, "test");
    const commences = [];
    const terminer = new Map();
    const ajouter = creerFileTraitement({
        analyser: async () => ({ duree: 15, largeur: 640, hauteur: 360, fpsSource: 30 }),
        cpus: () => 4,
        memoireLibre: () => 100,
        traiter: id => new Promise(resolve => { commences.push(id); terminer.set(id, resolve); })
    });
    try {
        ajouter("a", source);
        ajouter("b", source);
        await attendre(() => commences.length === 1);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(commences, ["a"]);
        terminer.get("a")();
        await attendre(() => commences.length === 2);
        terminer.get("b")();
    } finally {
        await fs.unlink(source).catch(() => {});
        await fs.rmdir(dir);
    }
});
