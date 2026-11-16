"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("historique : ouvrir, reprendre, effacer et afficher les titres en texte", () => {
    class Element {
        constructor(text = "") { this.textContent = text; this.children = []; this.handlers = {}; this.disabled = false; }
        append(...nodes) { this.children.push(...nodes); }
        replaceChildren(...nodes) { this.children = nodes; }
        addEventListener(type, callback) { this.handlers[type] = callback; }
        click() { this.handlers.click?.(); }
        showModal() { this.open = true; }
        close() { this.open = false; }
    }
    const nodes = Object.fromEntries(["historiqueListe", "effacerHistorique", "historiqueDialog", "ouvrirHistorique", "recherche"].map(id => [id, new Element()]));
    const title = "<img src=x onerror=alert(1)>";
    let entries = [{ item: { id: "video", titre: title }, position: 42, duration: 100, finished: false }];
    let selected, remembered = 0, emitted;
    const context = {
        $: id => nodes[id],
        lecteur: { active: {}, remember() { remembered++; }, historyItems: () => entries, clearHistory() { entries = []; } },
        element: (_tag, _className, text) => new Element(text),
        icon: name => new Element(name),
        duration: seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`,
        catalogueComplet: [{ id: "video", titre: title }],
        document: { querySelector() { return null; } },
        fermerMenu() {}, appliquerFil(id) { selected = id; }, emit(name, value) { emitted = [name, value]; },
        filtre: "saved"
    };
    const source = fs.readFileSync(path.join(__dirname, "../www/js/player.js"), "utf8");
    const start = source.indexOf("    function afficherHistorique() {");
    const end = source.indexOf('    $("positionLecture").addEventListener', start);
    assert.ok(start >= 0 && end > start, "L'interface historique doit être présente dans le lecteur.");
    vm.runInNewContext(source.slice(start, end), context);

    nodes.ouvrirHistorique.click();
    assert.equal(remembered, 1);
    assert.equal(nodes.historiqueDialog.open, true);
    assert.deepEqual(emitted, ["modal", true]);
    const row = nodes.historiqueListe.children[0];
    assert.equal(row.children[0].children[0].textContent, title);
    assert.equal(row.children[0].children[1].textContent, "Reprendre à 0:42 / 1:40");
    nodes.recherche.value = "ancien filtre";
    row.click();
    assert.equal(selected, "video");
    assert.equal(context.filtre, "all");
    assert.equal(nodes.recherche.value, "");
    assert.equal(nodes.historiqueDialog.open, false);

    nodes.effacerHistorique.click();
    assert.equal(nodes.effacerHistorique.disabled, true);
    assert.match(nodes.historiqueListe.children[0].textContent, /session/);
});
