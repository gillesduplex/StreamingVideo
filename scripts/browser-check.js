"use strict";

// Vérification avec Chrome installé, via son protocole DevTools, sans dépendance.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { randomUUID, createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const db = require("../backend/config/db");
const { app } = require("../backend/server");
const { initialiserSocial } = require("../backend/services/social");

const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, ".artifacts", "qa");
const token = randomUUID();
const profileDirectory = path.join(root, ".tmp", "chrome-" + randomUUID());
let server, browser, ws;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    await initialiserSocial(db);
    const videos = await db.query("SELECT id, chemin_original, chemin_hls, chemin_affiche, duree_secondes AS duree FROM public.videos WHERE statut = 'prete' ORDER BY date_ajout DESC");
    assert.ok(videos.rows.length, "Une vidéo prête est nécessaire pour vérifier la lecture réelle.");
    // Les anciennes entrées dont le flux a été supprimé servent à vérifier l'état
    // d'erreur, sans masquer les nouvelles erreurs HTTP sur les fichiers présents.
    const missingPlaylists = new Set();
    const adaptiveVideos = [];
    for (const video of videos.rows) {
        if (!video.chemin_hls?.startsWith("/hls/")) continue;
        const local = path.resolve(root, "backend/storage/videos", video.chemin_hls.slice(5));
        try {
            await fs.access(local);
            if (Number(video.duree) >= 100) {
                const master = await fs.readFile(local, "utf8");
                if ((master.match(/#EXT-X-STREAM-INF:/g) || []).length >= 2) adaptiveVideos.push(video);
            }
        } catch { missingPlaylists.add(video.chemin_hls); }
    }
    await fs.mkdir(artifacts, { recursive: true });
    await fs.mkdir(profileDirectory, { recursive: true });
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    const candidates = [process.env.CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
    let executable;
    for (const candidate of candidates) { try { await fs.access(candidate); executable = candidate; break; } catch {} }
    assert.ok(executable, "Chrome ou Edge doit être installé, ou défini dans CHROME_PATH.");
    browser = spawn(executable, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--user-data-dir=" + profileDirectory, "about:blank"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Chrome n'a pas ouvert son interface de test.")), 15000);
        browser.once("error", error => { clearTimeout(timer); reject(error); });
        browser.stderr.on("data", chunk => {
            output += chunk.toString();
            const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        browser.once("exit", code => { clearTimeout(timer); reject(new Error("Chrome s'est arrêté : " + code)); });
    });
    ws = new WebSocket(endpoint); await once(ws, "open");
    let sequence = 0, session;
    const waiting = new Map(), exceptions = [], badResponses = [];
    const bandwidthSamples = [], bandwidthProbes = new Set();
    const masterVideoIds = new Map(videos.rows.filter(video => video.chemin_hls).map(video =>
        [new URL(video.chemin_hls, origin).pathname, String(video.id)]));
    let observeLowBandwidth = false, lowBandwidthLoaderId = null, bandwidthProbeError = null;
    const heldMediaRequests = new Set();
    let holdMediaRequests = false, interceptionError = null;
    ws.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const pending = waiting.get(message.id); if (!pending) return;
            waiting.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
        }
        if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
        if (message.method === "Network.responseReceived" && message.params.response.status >= 400) {
            badResponses.push({ url: message.params.response.url, status: message.params.response.status });
        }
        if (observeLowBandwidth && message.method === "Network.requestWillBeSent" && message.params.loaderId === lowBandwidthLoaderId) {
            const requested = message.params.request.url;
            const pathname = new URL(requested).pathname;
            const masterId = masterVideoIds.get(pathname);
            const kind = masterId ? "master" : /\/segment_\d+\.m4s$/.test(pathname) ? "fragment" : null;
            const requestedId = masterId || pathname.match(/^\/hls\/([^/]+)\//)?.[1];
            if (kind && requestedId) {
                const probe = evaluate("(() => {const video=document.getElementById('lecteur');if(!video)return null;let ahead=0,end=0;for(let i=0;i<video.buffered.length;i++){if(video.buffered.start(i)<=video.currentTime+.1&&video.buffered.end(i)>video.currentTime){end=video.buffered.end(i);ahead=end-video.currentTime;break;}}return {id:video.closest('.feed-card')?.dataset.videoId,ahead,current:video.currentTime,duration:video.duration,fullyBuffered:Number.isFinite(video.duration)&&video.duration>0&&end>=video.duration-.25,paused:video.paused,ready:video.readyState};})()")
                    .then(state => { if (state) bandwidthSamples.push({ ...state, kind, requestedId, requested, timestamp: message.params.timestamp }); })
                    .catch(error => { bandwidthProbeError = error; })
                    .finally(() => bandwidthProbes.delete(probe));
                bandwidthProbes.add(probe);
            }
        }
        if (message.method === "Fetch.requestPaused") {
            const requestId = message.params.requestId;
            if (holdMediaRequests) heldMediaRequests.add(requestId);
            else send("Fetch.continueRequest", { requestId }).catch(error => { interceptionError = error; });
        }
    });
    const send = (method, params = {}, withSession = true) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error("Délai DevTools : " + method)); }, 20000);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(withSession && session ? { sessionId: session } : {}) }));
    });
    const target = await send("Target.createTarget", { url: "about:blank" }, false);
    session = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false)).sessionId;
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
        source: "localStorage.setItem('sv.visitor', " + JSON.stringify(token) + ");localStorage.setItem('defilementAutomatique','false');"
    });
    // L'instrumentation appartient au navigateur de test. Le code de production
    // n'expose ni son lecteur ni des réglages réservés aux tests.
    await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
            window.__qaHls = [];
            let wrapped;
            Object.defineProperty(window, "Hls", { configurable: true,
                get() { return wrapped; },
                set(Constructor) {
                    wrapped = new Proxy(Constructor, { construct(Target, args, NewTarget) {
                        const hls = Reflect.construct(Target, args, NewTarget);
                        const trace = { hls, events: [] };
                        const mediaEvents = new AbortController();
                        window.__qaHls.push(trace);
                        const record = (kind, data = {}) => {
                            const media = hls.media;
                            trace.events.push({ kind, at: performance.now(), time: media?.currentTime,
                                level: data.frag?.level ?? data.level ?? (media ? hls.currentLevel : -1),
                                fragmentStart: data.frag?.start, fragmentDuration: data.frag?.duration,
                                fatal: !!data.fatal, detail: data.details });
                            if (trace.events.length > 2000) trace.events.shift();
                        };
                        for (const [key, kind] of [["FRAG_LOADING", "fragment-loading"], ["FRAG_BUFFERED", "fragment-buffered"],
                            ["LEVEL_SWITCHED", "level-switched"], ["BUFFER_FLUSHING", "buffer-flushing"], ["ERROR", "error"]]) {
                            hls.on(Constructor.Events[key], (_, data) => record(kind, data));
                        }
                        hls.on(Constructor.Events.MEDIA_ATTACHED, () => {
                            for (const kind of ["seeking", "waiting", "playing", "ended"]) {
                                hls.media.addEventListener(kind, () => record(kind), { signal: mediaEvents.signal });
                            }
                        });
                        hls.on(Constructor.Events.DESTROYING, () => mediaEvents.abort());
                        return hls;
                    } });
                }
            });
        })();`
    });
    await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }, false);
    async function evaluate(expression) {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
    async function until(expression, label, timeout = 12000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (await evaluate(expression)) return;
            await delay(120);
        }
        const state = await evaluate("(() => {const video=document.getElementById('lecteur');const trace=window.__qaHls?.find(entry=>entry.hls.media===video);return {url:location.href,ready:video?.readyState,paused:video?.paused,time:video?.currentTime,active:document.querySelector('.feed-card.is-active')?.dataset.videoId,frame:document.querySelector('.feed-card.is-active')?.classList.contains('has-frame'),network:document.getElementById('chargement')?.textContent,auto:trace?.hls.autoLevelEnabled,level:trace?.hls.currentLevel,trace:trace?.events.slice(-12)}})()").catch(() => null);
        throw new Error("Attente échouée : " + label + " " + JSON.stringify(state));
    }
    const click = selector => evaluate("document.querySelector(" + JSON.stringify(selector) + ").click()");
    const type = (selector, value) => evaluate("(() => {const e=document.querySelector(" + JSON.stringify(selector) + ");e.value=" + JSON.stringify(value) + ";e.dispatchEvent(new Event('input',{bubbles:true}));})()");
    async function screenshot(name) {
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        await fs.writeFile(path.join(artifacts, name + ".png"), Buffer.from(shot.data, "base64"));
    }
    async function loaded(timeout = 20000) {
        await until("typeof SV !== 'undefined' && !document.getElementById('aimer').disabled", "catalogue et commandes");
        await until("document.getElementById('lecteur')?.readyState >= 2 && !!document.querySelector('.feed-card.is-active.has-frame')", "première image HLS présentée", timeout);
    }
    async function touchTap(x = 120, y = 300) {
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
        await delay(60);
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    async function assertRealTouchPause(label) {
        // Ces événements passent par touchend puis le clic synthétique du navigateur.
        // Un element.click() ne détecte pas l'annulation d'un tap par le scroll-snap.
        await delay(500);
        await until("!document.getElementById('lecteur').paused", "lecture avant tap " + label);
        await touchTap();
        await until("document.getElementById('lecteur').paused", "pause par vrai tap " + label, 4000);
        const pausedTime = await evaluate("document.getElementById('lecteur').currentTime");
        await delay(1400);
        const paused = await evaluate("({paused:document.getElementById('lecteur').paused,time:document.getElementById('lecteur').currentTime,networkHidden:document.getElementById('chargement').hidden})");
        assert.equal(paused.paused, true, "La pause tactile reste effective après les temporisations de sélection.");
        assert.ok(Math.abs(paused.time - pausedTime) < .1, "La vidéo n'avance pas pendant la pause tactile.");
        assert.equal(paused.networkHidden, true, "Une pause tactile volontaire ne devient pas une erreur de connexion.");
        await touchTap();
        await until("!document.getElementById('lecteur').paused && document.getElementById('lecteur').currentTime > " + JSON.stringify(pausedTime) + "+.1", "reprise par vrai tap " + label, 7000);
    }
    async function assertSinglePlayback() {
        const state = await evaluate("(() => { const videos=[...document.querySelectorAll('#filVideos video.feed-video')];return {count:videos.length,activeIds:document.querySelectorAll('#lecteur').length,playing:videos.filter(v=>!v.paused&&!v.ended).length,inactiveSilent:videos.filter(v=>v.id!=='lecteur').every(v=>v.paused&&v.muted)};})()");
        assert.ok(state.count <= 2, "Le fil conserve au maximum deux lecteurs vidéo.");
        assert.equal(state.activeIds, 1, "Un seul lecteur porte l'identifiant actif.");
        assert.ok(state.playing <= 1, "Une seule vidéo joue à la fois.");
        assert.equal(state.inactiveSilent, true, "Le lecteur préparé reste en pause et muet.");
    }
    const vodState = () => evaluate(`(() => {
        const video = document.getElementById("lecteur");
        const trace = window.__qaHls.find(entry => entry.hls.media === video);
        let ahead = 0;
        for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime + .15 && video.buffered.end(i) > video.currentTime) {
                ahead = video.buffered.end(i) - video.currentTime; break;
            }
        }
        return { time: video.currentTime, ready: video.readyState, paused: video.paused,
            duration: video.duration, ahead, online: navigator.onLine, wall: performance.now(),
            auto: trace?.hls.autoLevelEnabled, level: trace?.hls.currentLevel,
            levels: trace?.hls.levels.map(level => ({ bitrate: level.bitrate, width: level.width, height: level.height })),
            trace: trace?.events.slice(-40), state: document.getElementById("chargement").dataset.state,
            frame: video.closest(".feed-card").classList.contains("has-frame") };
    })()`);
    async function assertVodContinuity(durationMs, previous, label) {
        const samples = [previous];
        const start = Date.now();
        while (Date.now() - start < durationMs) {
            await delay(180);
            const state = await vodState();
            const elapsed = (state.wall - previous.wall) / 1000;
            const advanced = state.time - previous.time;
            assert.ok(advanced >= -.2 && advanced <= elapsed + .4,
                "La VOD reprend sans retour ni saut de segment (" + label + ") : " + JSON.stringify({ previous, state }));
            samples.push(state); previous = state;
        }
        return samples;
    }
    async function assertSelectionConsistent() {
        await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === new URL(location.href).searchParams.get('video')", "carte active et lien synchronisés");
        const current = await evaluate("(async()=>{const id=new URL(location.href).searchParams.get('video');const social=await SV.api('/videos/'+id+'/social');return {videoId:id,cardId:document.getElementById('lecteur')?.closest('.feed-card')?.dataset.videoId,liked:document.getElementById('aimer').getAttribute('aria-pressed'),expectedLiked:String(social.liked),likes:document.getElementById('nombreLikes').textContent,expectedLikes:SV.number(social.likes)};})()");
        assert.equal(current.cardId, current.videoId);
        assert.equal(current.liked, current.expectedLiked);
        assert.equal(current.likes, current.expectedLikes);
    }
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: origin + "/app/?video=" + videos.rows[0].id });
    await loaded();
    assert.equal(await evaluate("document.getElementById('message').hidden"), true);
    assert.equal(await evaluate("document.getElementById('chargement').hidden"), true, "Aucun chargement n'est affiché pendant une lecture normale.");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('chargement'),'::before').animationName"), "none", "L'indicateur réseau ne contient aucun rond animé.");
    assert.equal(await evaluate("document.querySelector('.scene').getBoundingClientRect().bottom <= innerHeight"), true);
    await assertSinglePlayback();
    await screenshot("desktop");
    const videoLongue = videos.rows.find(video => Number(video.duree) > 60);
    if (videoLongue) {
        if (String(videoLongue.id) !== String(videos.rows[0].id)) {
            await send("Page.navigate", { url: origin + "/app/?video=" + videoLongue.id });
            await loaded();
        }
        assert.equal(await evaluate("document.getElementById('pleinEcran').hidden"), false, "Le bouton plein écran apparaît au-delà d'une minute.");
        await click("#pleinEcran");
        await until("document.getElementById('scene').classList.contains('video-fullscreen')", "activation du plein écran");
        await click("#pleinEcran");
        await until("!document.getElementById('scene').classList.contains('video-fullscreen')", "retour au fil");
        if (String(videoLongue.id) !== String(videos.rows[0].id)) {
            await send("Page.navigate", { url: origin + "/app/?video=" + videos.rows[0].id });
            await loaded();
        }
    }
    const videoCourte = videos.rows.find(video => Number(video.duree) <= 60);
    if (videoCourte) {
        if (String(videoCourte.id) !== String(videos.rows[0].id)) {
            await send("Page.navigate", { url: origin + "/app/?video=" + videoCourte.id });
            await loaded();
        }
        assert.equal(await evaluate("document.getElementById('pleinEcran').hidden"), true, "Le bouton plein écran reste masqué pour une vidéo d'une minute ou moins.");
        if (String(videoCourte.id) !== String(videos.rows[0].id)) {
            await send("Page.navigate", { url: origin + "/app/?video=" + videos.rows[0].id });
            await loaded();
        }
    }
    console.log("OK : lecture HLS et mise en page ordinateur.");

    await click(".profile-shortcut"); await until("document.getElementById('profilDialog').open", "profil");
    await type("#pseudo", "Camille"); await evaluate("document.getElementById('profilForm').requestSubmit()");
    await until("!document.getElementById('profilDialog').open && document.querySelector('.my-name').textContent === 'Camille'", "enregistrement du pseudo");
    const id = videos.rows[0].id;
    const center = await evaluate("(() => { const r=document.getElementById('lecteur').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
    for (const clickCount of [1, 2]) {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...center, button: "left", clickCount });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...center, button: "left", clickCount });
    }
    await until("!document.getElementById('aimer').disabled && document.getElementById('aimer').getAttribute('aria-pressed') === 'true'", "like enregistré");
    const likedStats = await evaluate("(async()=>{const id=new URL(location.href).searchParams.get('video');return SV.api('/videos/'+id+'/social')})()");
    await evaluate(`window.__qaOriginalFetch=window.fetch;window.fetch=async(...args)=>{const [input,options={}] = args;const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname.endsWith('/like')&&options.method==='DELETE')await new Promise(resolve=>setTimeout(resolve,700));return window.__qaOriginalFetch(...args);}`);
    await click("#aimer");
    await until("document.getElementById('aimer').disabled && document.getElementById('aimer').getAttribute('aria-pressed') === 'false'", "retrait du J’aime affiché avant la réponse serveur");
    assert.equal(await evaluate("document.getElementById('nombreLikes').textContent"), await evaluate("SV.number(" + Math.max(0, likedStats.likes - 1) + ")"), "Le compteur diminue immédiatement au retrait du J’aime.");
    await evaluate("window.fetch=window.__qaOriginalFetch");
    await until("!document.getElementById('aimer').disabled && document.getElementById('aimer').getAttribute('aria-pressed') === 'false'", "retrait du J’aime confirmé");
    await click("#aimer");
    await until("!document.getElementById('aimer').disabled && document.getElementById('aimer').getAttribute('aria-pressed') === 'true'", "J’aime réactivé");
    await send("Page.reload"); await loaded();
    assert.equal(await evaluate("document.getElementById('aimer').getAttribute('aria-pressed')"), "true");
    await until("[...document.querySelectorAll('#filVideos video.feed-video')].some(v=>v.id!=='lecteur'&&v.readyState>=2)", "lecteur suivant préparé", 20000);
    await evaluate("window.__qaPreparedVideo=[...document.querySelectorAll('#filVideos video.feed-video')].find(v=>v.id!=='lecteur'&&v.readyState>=2)");
    await click("#videoSuivante"); await until("new URL(location.href).searchParams.get('video') !== " + JSON.stringify(id), "vidéo suivante");
    await loaded();
    assert.equal(await evaluate("document.getElementById('lecteur') === window.__qaPreparedVideo"), true, "Le changement réutilise le lecteur déjà préparé.");
    assert.equal(await evaluate("document.getElementById('chargement').hidden"), true);
    await assertSinglePlayback();
    await click("#videoPrecedente"); await until("new URL(location.href).searchParams.get('video') === " + JSON.stringify(id), "retour à la vidéo aimée");
    await loaded();
    await until("document.getElementById('aimer').getAttribute('aria-pressed') === 'true'", "like après navigation");
    console.log("OK : pseudo, double-clic, likes persistants et réutilisation du lecteur préparé.");

    await click("#commenter"); await until("!document.getElementById('commentairesListe').textContent.includes('Les commentaires arrivent.')", "chargement des commentaires");
    const text = "Ce moment mérite d’être partagé. Super découverte !";
    await type("#texteCommentaire", text); await evaluate("document.getElementById('commentaireForm').requestSubmit()");
    await until("[...document.querySelectorAll('.comment-text')].some(e=>e.textContent === " + JSON.stringify(text) + ")", "commentaire publié");
    await click(".comment-thread .comment-like"); await until("document.querySelector('.comment-thread .comment-like').getAttribute('aria-pressed') === 'true'", "like du commentaire");
    await evaluate("[...document.querySelectorAll('.comment-thread .comment-actions button')].find(e=>e.textContent==='Répondre').click()");
    await type("#texteCommentaire", "Merci pour ce partage !"); await evaluate("document.getElementById('commentaireForm').requestSubmit()");
    await until("document.querySelector('.replies .comment-text')?.textContent === 'Merci pour ce partage !'", "réponse publiée");
    await screenshot("desktop-commentaires");

    // Un texte malveillant reste du texte, sans élément HTML exécutable.
    const xss = "<img src=x onerror=window.__xss=true>";
    await type("#texteCommentaire", xss); await evaluate("document.getElementById('commentaireForm').requestSubmit()");
    await until("[...document.querySelectorAll('.comment-text')].some(e=>e.textContent === " + JSON.stringify(xss) + ")", "texte HTML affiché littéralement");
    assert.equal(await evaluate("!!window.__xss || !!document.querySelector('.comment-text img')"), false);
    const xssId = await evaluate("[...document.querySelectorAll('.comment-item')].find(e=>e.querySelector('.comment-text').textContent === " + JSON.stringify(xss) + ").id.replace('comment-','')");
    await evaluate("SV.api('/comments/' + " + JSON.stringify(xssId) + ", {method:'DELETE'})");

    await send("Network.setBlockedURLs", { urls: ["*/api/videos/*/comments"] });
    await type("#texteCommentaire", "Mon brouillon reste présent si le réseau coupe."); await evaluate("document.getElementById('commentaireForm').requestSubmit()");
    await until("document.getElementById('erreurCommentaire').classList.contains('error')", "erreur réseau visible");
    assert.equal(await evaluate("document.getElementById('texteCommentaire').value"), "Mon brouillon reste présent si le réseau coupe.");
    await send("Network.setBlockedURLs", { urls: [] });
    await evaluate("document.getElementById('commentaireForm').requestSubmit()");
    await until("document.getElementById('texteCommentaire').value === ''", "nouvel envoi après retour du réseau");
    await click('[data-close="commentairesDialog"]');
    console.log("OK : commentaires, réponses, likes de commentaire, texte sécurisé et brouillon conservé hors ligne.");

    await click("#enregistrerVideo"); await until("document.getElementById('enregistrerVideo').getAttribute('aria-pressed') === 'true' && !document.getElementById('enregistrerVideo').disabled", "favori enregistré");
    await click('.feed-tab[data-feed="saved"]');
    assert.equal(await evaluate("new URL(location.href).searchParams.get('video')"), id);
    await click('.feed-tab[data-feed="all"]');
    await type("#recherche", "aucune-video-ne-porte-ce-nom-qa");
    await until("document.getElementById('message').textContent.includes('Aucune vidéo ne correspond')", "recherche sans résultat");
    assert.equal(await evaluate("document.getElementById('aimer').disabled"), true);
    await type("#recherche", ""); await loaded();

    await evaluate("Object.defineProperty(navigator, 'share', {value:undefined, configurable:true})");
    await click("#partager"); await until("document.getElementById('partageDialog').open", "menu de partage");
    await click("#copierPartage"); await until("document.getElementById('etatPartage').textContent.includes('copié')", "copie du lien");
    await click('[data-close="partageDialog"]');
    console.log("OK : favoris, recherche et copie du lien de partage.");

    const delayedIndex = videos.rows.findIndex((video, index) => index >= 4 && video.chemin_affiche && Number(video.duree) >= 30);
    if (delayedIndex >= 0) {
        const delayedVideo = videos.rows[delayedIndex];
        holdMediaRequests = true;
        await send("Fetch.enable", { patterns: [{ urlPattern: origin + delayedVideo.chemin_hls, requestStage: "Request" }] });
        try {
            // La playlist d'une vidéo non encore visitée reste réellement en attente réseau.
            // Son JPEG n'est pas intercepté : la couverture doit pouvoir être affichée.
            for (let index = 0; index < delayedIndex; index++) {
                const previous = await evaluate("new URL(location.href).searchParams.get('video')");
                await click("#videoSuivante");
                await until("new URL(location.href).searchParams.get('video') !== " + JSON.stringify(previous), "navigation jusqu'à la vidéo ralentie");
            }
            await until("new URL(location.href).searchParams.get('video') === " + JSON.stringify(delayedVideo.id), "sélection de la vidéo ralentie");
            await until("(() => {const wrapper=document.querySelector('.feed-card.is-active .card-cover');const image=wrapper?.querySelector('img.video-cover');if(!wrapper||!image)return false;const style=getComputedStyle(wrapper);return !wrapper.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>.9&&image.complete&&image.naturalWidth>0;})()", "couverture visible avant les données HLS");
            assert.equal(await evaluate("document.querySelector('.feed-card.is-active').classList.contains('has-frame')"), false, "La couverture reste affichée tant qu'aucune image vidéo n'est présentée.");
            assert.equal(await evaluate("document.getElementById('chargement').hidden"), true, "La transition ne montre pas de chargement immédiatement.");
            await until("!document.getElementById('chargement').hidden && document.getElementById('chargement').dataset.state === 'unstable' && document.getElementById('chargement').textContent.includes('Connexion instable')", "signalement d'une attente réseau prolongée", 7000);
            await screenshot("connexion-instable");
        } finally {
            holdMediaRequests = false;
            for (const requestId of heldMediaRequests) {
                await send("Fetch.continueRequest", { requestId }).catch(error => {
                    if (!/Invalid|not found/i.test(error.message)) throw error;
                });
            }
            heldMediaRequests.clear();
            await send("Fetch.disable");
        }
        await loaded();
        await until("(() => {const wrapper=document.querySelector('.feed-card.is-active .card-cover');if(!wrapper)return false;const style=getComputedStyle(wrapper);return document.getElementById('chargement').hidden&&(wrapper.hidden||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)<.1);})()", "retrait de la couverture et du message après reprise");
        await assertSinglePlayback();
        assert.equal(interceptionError, null);
        console.log("OK : couverture conservée pendant l'attente HLS, message Connexion instable retardé et reprise sans écran vide.");

        await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
        let soughtTime;
        try {
            soughtTime = await evaluate("(() => {const video=document.getElementById('lecteur');const target=Math.min(video.duration-2,Math.max(video.currentTime+15,video.duration*.8));video.currentTime=target;return target;})()");
            await until("!document.getElementById('chargement').hidden && document.getElementById('chargement').dataset.state === 'offline' && document.getElementById('chargement').textContent.includes('Hors connexion')", "connexion interrompue visible", 7000);
            assert.equal(await evaluate("getComputedStyle(document.getElementById('chargement'),'::before').animationName"), "chargement-tourne", "Un rond tourne pendant la coupure réseau.");
            assert.equal(await evaluate("(() => {const card=document.querySelector('.feed-card.is-active');const wrapper=card.querySelector('.card-cover');const image=wrapper?.querySelector('img.video-cover');const style=wrapper&&getComputedStyle(wrapper);return card.classList.contains('has-frame') || (!!wrapper&&!wrapper.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>.9&&image.complete&&image.naturalWidth>0);})()"), true, "Une image vidéo ou sa couverture reste affichée hors ligne.");
            await screenshot("connexion-interrompue");
        } finally {
            await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        }
        await until("(() => {const video=document.getElementById('lecteur');return video.readyState>=2&&!video.paused&&video.currentTime>" + JSON.stringify(soughtTime) + "+.05&&document.getElementById('chargement').hidden;})()", "reprise automatique au retour de la connexion", 20000);
        await click("#lecteur"); await until("document.getElementById('lecteur').paused", "pause volontaire");
        await delay(3200);
        assert.equal(await evaluate("document.getElementById('chargement').hidden"), true, "Une pause volontaire ne déclenche aucun faux message réseau.");
        await click("#lecturePause"); await until("!document.getElementById('lecteur').paused", "lecture après pause volontaire");
        await click("#son"); assert.equal(await evaluate("document.getElementById('lecteur').muted"), false);
        await assertSinglePlayback(); await click("#son");
        console.log("OK : coupure réseau réelle, reprise automatique, pause volontaire sans faux chargement et un seul son actif.");

        // Plusieurs sélections se succèdent avant que les anciennes requêtes soient terminées.
        for (const index of [0, delayedIndex, 1]) {
            await evaluate("(() => {const card=document.querySelector('.feed-card[data-video-id=\"" + videos.rows[index].id + "\"]');if(!card)throw new Error('Carte attendue absente');document.getElementById('filVideos').scrollTo({top:card.offsetTop,behavior:'instant'});})()");
            await delay(140);
        }
        await until("new URL(location.href).searchParams.get('video') === " + JSON.stringify(videos.rows[1].id), "dernière sélection après défilement rapide");
        await loaded(); await assertSelectionConsistent(); await assertSinglePlayback();
        await evaluate("document.getElementById('filVideos').scrollTo({top:0,behavior:'instant'})");
        await until("new URL(location.href).searchParams.get('video') === " + JSON.stringify(id), "retour au début du fil");
        await loaded();
        console.log("OK : défilement rapide, lecteur et compteurs associés à la bonne vidéo.");
    } else {
        console.log("Vérifications réseau différé ignorées : une vidéo distante d'au moins 30 secondes avec miniature est nécessaire.");
    }

    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await send("Page.reload"); await loaded();
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.mobile-nav')).display"), "flex");
    assert.equal(await evaluate("Math.round(document.querySelector('.scene').getBoundingClientRect().bottom) <= Math.round(document.querySelector('.mobile-nav').getBoundingClientRect().top)"), true);
    await screenshot("mobile");
    await assertRealTouchPause("sur téléphone");
    const beforeSwipe = await evaluate("new URL(location.href).searchParams.get('video')");
    async function swipe(from, to, inspectDuringDrag) {
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 130, y: from, id: 1 }] });
        for (let step = 1; step <= 4; step++) {
            await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 130, y: from + (to - from) * step / 4, id: 1 }] });
            await delay(40);
        }
        if (inspectDuringDrag) await inspectDuringDrag();
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    const geometry = () => evaluate("(() => {const card=document.querySelector('.feed-card.is-active');const hud=document.getElementById('publicationCourante');return {card:card.getBoundingClientRect().top,hud:hud.getBoundingClientRect().top,caption:document.getElementById('titreVideo').getBoundingClientRect().top,actions:document.getElementById('aimer').getBoundingClientRect().top,header:document.querySelector('.workspace-header').getBoundingClientRect().top,nav:document.querySelector('.mobile-nav').getBoundingClientRect().top,owner:hud.closest('.feed-card')?.dataset.videoId};})()");
    const beforeDrag = await geometry();
    assert.equal(beforeDrag.owner, beforeSwipe, "Les commandes et la description appartiennent à la publication active.");
    await swipe(370, 170, async () => {
        const duringDrag = await geometry();
        const movement = duringDrag.card - beforeDrag.card;
        assert.ok(movement < -10, "La publication suit le doigt avant le relâchement.");
        for (const part of ["hud", "caption", "actions"]) {
            assert.ok(Math.abs((duringDrag[part] - beforeDrag[part]) - movement) < 3, "La partie " + part + " monte avec la vidéo.");
        }
        assert.ok(Math.abs(duringDrag.header - beforeDrag.header) < 1, "L'en-tête de l'application reste fixe.");
        assert.ok(Math.abs(duringDrag.nav - beforeDrag.nav) < 1, "La navigation de l'application reste fixe.");
        const preview = await evaluate("(() => {const next=document.querySelector('.feed-card.is-active')?.nextElementSibling;const preview=next?.querySelector('.publication-preview');return {cardId:next?.dataset.videoId,previewId:preview?.dataset.videoId,title:preview?.querySelector('.informations > strong')?.textContent,actions:preview?.querySelectorAll('.action').length,duplicateIds:preview?.querySelectorAll('[id]').length};})()");
        assert.equal(preview.previewId, preview.cardId, "La publication entrante présente ses propres informations.");
        assert.ok(preview.title?.trim(), "La publication entrante a son titre avant sélection.");
        assert.ok(preview.actions >= 4, "Les actions de la prochaine publication accompagnent sa vidéo.");
        assert.equal(preview.duplicateIds, 0, "Les aperçus n'introduisent pas d'identifiants DOM dupliqués.");
    });
    await until("new URL(location.href).searchParams.get('video') !== " + JSON.stringify(beforeSwipe), "balayage vers la vidéo suivante");
    await loaded();
    await assertRealTouchPause("après défilement");
    await swipe(200, 400);
    await until("new URL(location.href).searchParams.get('video') === " + JSON.stringify(beforeSwipe), "balayage vers la vidéo précédente");
    await click("#commenter"); await until("!!document.querySelector('.comment-thread')", "commentaires sur téléphone");
    assert.equal(await evaluate("document.querySelector('.comment-composer').getBoundingClientRect().bottom <= innerHeight + 1"), true);
    await screenshot("mobile-commentaires");
    await click('[data-close="commentairesDialog"]');
    console.log("OK : vrais taps pause/reprise, publication entière en mouvement et commentaires au format téléphone 390 × 844.");

    const slowIndex = videos.rows.findIndex((video, index) => Number(video.duree) >= 45 &&
        !missingPlaylists.has(video.chemin_hls) && index < videos.rows.length - 1 &&
        !missingPlaylists.has(videos.rows[index + 1].chemin_hls));
    if (slowIndex >= 0) {
        const slowVideo = videos.rows[slowIndex];
        bandwidthSamples.length = 0;
        bandwidthProbeError = null;
        await send("Network.setCacheDisabled", { cacheDisabled: true });
        await send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 312500, uploadThroughput: 312500 });
        try {
            const startup = Date.now();
            const navigation = await send("Page.navigate", { url: origin + "/app/?video=" + slowVideo.id });
            assert.ok(navigation.loaderId, "La vérification réseau observe uniquement le document nouvellement chargé.");
            lowBandwidthLoaderId = navigation.loaderId;
            observeLowBandwidth = true;
            await loaded(30000);
            const startupMs = Date.now() - startup;
            const start = await evaluate("document.getElementById('lecteur').currentTime");
            let stalledSince = 0, longestStall = 0;
            const observing = Date.now();
            while (Date.now() - observing < 8000) {
                const state = await evaluate("({ready:document.getElementById('lecteur').readyState,paused:document.getElementById('lecteur').paused,time:document.getElementById('lecteur').currentTime})");
                if (!state.paused && state.ready < 3) stalledSince ||= Date.now();
                else if (stalledSince) { longestStall = Math.max(longestStall, Date.now() - stalledSince); stalledSince = 0; }
                await delay(250);
            }
            if (stalledSince) longestStall = Math.max(longestStall, Date.now() - stalledSince);
            const progressed = await evaluate("document.getElementById('lecteur').currentTime") - start;
            assert.ok(progressed >= 5, "À 2,5 Mbit/s, la lecture avance d'au moins cinq secondes sur huit secondes observées.");
            assert.ok(longestStall < 2500, "Le préchargement n'impose pas une attente prolongée à la vidéo regardée.");
            await assertRealTouchPause("à 2,5 Mbit/s");
            await assertSinglePlayback();
            await screenshot("mobile-2-5mbps");
            observeLowBandwidth = false;
            await Promise.all([...bandwidthProbes]);
            assert.equal(bandwidthProbeError, null);
            const spare = bandwidthSamples.filter(sample => sample.requestedId !== sample.id);
            const firstMasters = new Map();
            for (const sample of spare.filter(sample => sample.kind === "master").sort((a, b) => a.timestamp - b.timestamp)) {
                if (!firstMasters.has(sample.requestedId)) firstMasters.set(sample.requestedId, sample);
            }
            // Le premier master mesure l'autorisation de préparer la réserve. Les
            // fragments arrivent après ses manifestes et respectent le seuil bas.
            // 0,5 s couvre le décalage entre l'événement réseau et la mesure CDP.
            const prematureMasters = [...firstMasters.values()].filter(sample => !sample.fullyBuffered && sample.ahead < 5.5);
            const lowBufferFragments = spare.filter(sample => sample.kind === "fragment" && !sample.fullyBuffered && sample.ahead < 3.5);
            assert.equal(prematureMasters.length, 0, "La prochaine vidéo démarre après environ six secondes de réserve : " + JSON.stringify(prematureMasters));
            assert.equal(lowBufferFragments.length, 0, "Les fragments de réserve préservent environ quatre secondes pour la vidéo active : " + JSON.stringify(lowBufferFragments));
            assert.ok(bandwidthSamples.some(sample => sample.requestedId === String(slowVideo.id) && sample.kind === "fragment"), "Les requêtes de la nouvelle navigation ont bien été observées.");
            console.log("OK : lecture 2,5 Mbit/s, première image en " + startupMs + " ms, progression " + progressed.toFixed(1) + " s, pause tactile et priorité réseau vérifiées (" + firstMasters.size + " master(s), " + spare.filter(sample => sample.kind === "fragment").length + " fragment(s) de réserve).");
        } finally {
            observeLowBandwidth = false;
            await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await send("Network.setCacheDisabled", { cacheDisabled: false });
        }
        await send("Page.navigate", { url: origin + "/app/?video=" + id });
        await loaded();
    } else {
        console.log("Vérification 2,5 Mbit/s ignorée : une vidéo valide d'au moins 45 secondes suivie d'une autre vidéo valide est nécessaire.");
    }

    const adaptiveVideo = adaptiveVideos.find(video => {
        const index = videos.rows.findIndex(item => item.id === video.id);
        return index >= 0 && index + 1 < videos.rows.length && !missingPlaylists.has(videos.rows[index + 1].chemin_hls);
    }) || adaptiveVideos[0];
    if (adaptiveVideo) {
        // Un téléphone avec un écran dense autorise plusieurs résolutions utiles ;
        // à DPR 1, le plafond à la taille du lecteur peut légitimement rester au niveau 0.
        await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        const masterUrl = new URL(adaptiveVideo.chemin_hls, origin);
        const masterFile = path.resolve(root, "backend/storage/videos", adaptiveVideo.chemin_hls.slice(5));
        const masterText = await fs.readFile(masterFile, "utf8");
        const variantPath = masterText.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith("#"));
        const variantText = await fs.readFile(path.resolve(path.dirname(masterFile), variantPath), "utf8");
        const segmentPath = variantText.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith("#") && /\.m4s$/.test(line));
        const segmentUrl = new URL(segmentPath, new URL(variantPath, masterUrl));
        const playlistHead = await fetch(masterUrl, { method: "HEAD" });
        const segmentHead = await fetch(segmentUrl, { method: "HEAD" });
        assert.equal(playlistHead.status, 200);
        assert.equal(segmentHead.status, 200);
        assert.match(playlistHead.headers.get("cache-control") || "", /max-age=60(?:,|$)/);
        assert.match(segmentHead.headers.get("cache-control") || "", /max-age=31536000(?:,|$)/);
        assert.match(segmentHead.headers.get("cache-control") || "", /\bimmutable\b/);
        console.log("OK : playlists mises en cache 60 s et segments VOD immuables un an.");
        await send("Network.setCacheDisabled", { cacheDisabled: true });
        const network = throughput => send("Network.emulateNetworkConditions", {
            offline: false, latency: 80, downloadThroughput: throughput, uploadThroughput: throughput
        });
        await network(625000); // 5 Mbit/s réels, exprimés en octets/s pour DevTools.
        try {
            await send("Page.navigate", { url: origin + "/app/?video=" + adaptiveVideo.id });
            await loaded(30000);
            await until(`(() => {
                const video = document.getElementById("lecteur");
                const trace = window.__qaHls.find(entry => entry.hls.media === video);
                return trace?.hls.autoLevelEnabled && trace.events.some(event => event.kind === "fragment-buffered" && event.level > 0);
            })()`, "Auto télécharge une qualité supérieure quand le débit le permet", 35000);
            const high = await vodState();
            assert.ok(high.levels.length >= 2, "La VOD utilisée expose plusieurs qualités réelles.");

            // Revenir sur Auto pendant la lecture ne doit ni vider le tampon ni
            // déplacer la tête de lecture. Aucun niveau n'est injecté par le test.
            await evaluate(`(() => {
                const video = document.getElementById("lecteur");
                const trace = window.__qaHls.find(entry => entry.hls.media === video);
                window.__qaAutoMark = trace.events.length;
                const select = document.getElementById("choixQualite");
                select.value = "-1"; select.dispatchEvent(new Event("change", { bubbles: true }));
            })()`);
            await assertVodContinuity(1500, high, "sélection Automatique");
            const autoEvents = await evaluate(`(() => {
                const video = document.getElementById("lecteur");
                const trace = window.__qaHls.find(entry => entry.hls.media === video);
                return trace.events.slice(window.__qaAutoMark);
            })()`);
            assert.equal(autoEvents.filter(event => ["seeking", "buffer-flushing"].includes(event.kind)).length, 0,
                "Sélectionner Auto ne vide pas la réserve et ne provoque pas de saut : " + JSON.stringify(autoEvents));

            const dropMark = await evaluate("performance.now()");
            await network(100000); // 0,8 Mbit/s : sous le débit de la variante haute.
            await until(`(() => {
                const video = document.getElementById("lecteur");
                const trace = window.__qaHls.find(entry => entry.hls.media === video);
                return trace?.hls.autoLevelEnabled && trace.events.some(event =>
                    event.kind === "fragment-buffered" && event.level === 0 && event.at > ${dropMark});
            })()`, "Auto redescend sur les fragments téléchargés après la baisse de débit", 50000);
            const low = await vodState();
            assert.equal(low.auto, true, "La baisse de qualité conserve le mode automatique.");
            const riseMark = await evaluate("performance.now()");
            await network(625000);
            await until(`(() => {
                const video = document.getElementById("lecteur");
                const trace = window.__qaHls.find(entry => entry.hls.media === video);
                return trace?.hls.autoLevelEnabled && trace.events.some(event =>
                    event.kind === "fragment-buffered" && event.level > 0 && event.at > ${riseMark});
            })()`, "Auto remonte quand les téléchargements retrouvent du débit", 45000);
            console.log("OK : Auto adapte les fragments aux débits 5 → 0,8 → 5 Mbit/s sans effacement du tampon lors de la sélection Auto.");

            // Repartir sur le même film garantit assez de contenu restant pour
            // épuiser naturellement la réserve, quelle que soit la durée de l'ABR.
            await send("Page.navigate", { url: origin + "/app/?video=" + adaptiveVideo.id });
            await loaded(30000);
            const reserveStart = Date.now();
            while ((await vodState()).ahead < 20) {
                assert.ok(Date.now() - reserveStart < 18000, "La vidéo active constitue une réserve réelle avant le test de coupure.");
                await delay(200);
            }

            // Un réseau peut rester connecté tout en ne transmettant plus rien.
            // Retenir les vrais segments simule ce cas sans événement online/offline.
            holdMediaRequests = true;
            await send("Fetch.enable", { patterns: [{
                urlPattern: origin + "/hls/" + adaptiveVideo.id + "/*", requestStage: "Request"
            }] });
            await evaluate(`(() => {
                window.__qaFrozenVideo = document.getElementById("lecteur");
                window.__qaFrozenHls = window.__qaHls.find(entry => entry.hls.media === window.__qaFrozenVideo).hls;
            })()`);
            let frozen;
            try {
                const buffered = await vodState();
                const briefOutage = await assertVodContinuity(3200, buffered, "coupure courte couverte par la réserve");
                assert.ok(briefOutage[briefOutage.length - 1].time - buffered.time >= 2.5,
                    "Une coupure courte n'arrête pas la lecture des segments déjà en mémoire.");
                await until(`(() => {
                    const video = document.getElementById("lecteur");
                    const indicator = document.getElementById("chargement");
                    return navigator.onLine && video.currentTime > 2 && !indicator.hidden &&
                        ["unstable", "loading"].includes(indicator.dataset.state);
                })()`, "gel réseau réel après épuisement de la réserve, sans état hors ligne", 55000);
                frozen = await vodState();
                assert.equal(frozen.online, true, "Le test n'utilise pas un événement de déconnexion pour provoquer la reprise.");
                assert.equal(frozen.frame, true, "La dernière image vidéo reste présentée pendant l'attente.");
                const held = await assertVodContinuity(1600, frozen, "attente réseau");
                const still = held[held.length - 1];
                assert.ok(still.time - frozen.time < .3, "Une VOD en attente ne saute pas des images pour rattraper une horloge.");
                assert.equal(await evaluate("document.getElementById('lecteur') === window.__qaFrozenVideo && window.__qaHls.find(entry=>entry.hls.media===document.getElementById('lecteur')).hls === window.__qaFrozenHls"), true,
                    "L'attente conserve le même média et sa réserve.");
                // Exercer également la commande de reprise réseau. Elle ne doit
                // pas reconstruire une VOD déjà positionnée et repartir de zéro.
                await click("#reessayerFil");
                await delay(250);
                frozen = await vodState();
                assert.ok(Math.abs(frozen.time - still.time) < .3, "Réessayer conserve la position interrompue.");
                assert.equal(await evaluate("document.getElementById('lecteur') === window.__qaFrozenVideo && window.__qaHls.find(entry=>entry.hls.media===document.getElementById('lecteur')).hls === window.__qaFrozenHls"), true,
                    "Réessayer une connexion conserve le lecteur et ses segments.");
                await screenshot("vod-reseau-fige");
            } finally {
                holdMediaRequests = false;
                for (const requestId of heldMediaRequests) {
                    await send("Fetch.continueRequest", { requestId }).catch(error => {
                        if (!/Invalid|not found/i.test(error.message)) throw error;
                    });
                }
                heldMediaRequests.clear();
                await send("Fetch.disable");
            }
            // Les premiers échantillons après libération détectent aussi un saut
            // au redémarrage ; attendre seulement currentTime > anciennePosition
            // aurait laissé passer un retour à zéro ou un saut de quatre secondes.
            const resumed = await assertVodContinuity(6500, frozen, "retour des segments");
            assert.ok(resumed[resumed.length - 1].time > frozen.time + 1,
                "La lecture reprend automatiquement quand les segments reviennent, même sans événement online.");
            assert.equal(await evaluate("document.getElementById('chargement').hidden"), true);
            assert.equal(interceptionError, null);
            await assertSinglePlayback();
            console.log("OK : réserve épuisée sur réseau toujours connecté, dernière image conservée et reprise au même endroit sans saut de segment.");

            const index = videos.rows.findIndex(video => video.id === adaptiveVideo.id);
            const next = videos.rows[index + 1];
            if (next && !missingPlaylists.has(next.chemin_hls)) {
                await until("[...document.querySelectorAll('#filVideos video.feed-video')].some(video=>video.id!=='lecteur'&&video.readyState>=2&&video.closest('.feed-card')?.dataset.videoId===" + JSON.stringify(next.id) + ")",
                    "préparation de la publication suivante à 5 Mbit/s", 20000);
                const warmStart = Date.now();
                await swipe(370, 170);
                await until("new URL(location.href).searchParams.get('video') === " + JSON.stringify(next.id), "swipe vers la publication préparée");
                await loaded();
                const warmMs = Date.now() - warmStart;
                assert.ok(warmMs < 1800, "La publication préparée démarre rapidement après le vrai geste : " + warmMs + " ms.");
                console.log("OK : vrai swipe sur publication préparée, première image en " + warmMs + " ms à 5 Mbit/s.");
            }
        } finally {
            holdMediaRequests = false;
            await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await send("Network.setCacheDisabled", { cacheDisabled: false });
            await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        }
        await send("Page.navigate", { url: origin + "/app/?video=" + id });
        await loaded();
    } else {
        console.log("Vérification VOD adaptative ignorée : une vidéo valide d'au moins 100 secondes avec plusieurs qualités est nécessaire.");
    }

    const unavailable = videos.rows.find(video => missingPlaylists.has(video.chemin_hls));
    if (unavailable) {
        await evaluate("(() => {const card=document.querySelector('.feed-card[data-video-id=\"" + unavailable.id + "\"]');document.getElementById('filVideos').scrollTo({top:card.offsetTop,behavior:'instant'});})()");
        await until("document.querySelector('.feed-card.is-active')?.dataset.videoId === " + JSON.stringify(unavailable.id) + " && !document.getElementById('message').hidden && document.getElementById('message').textContent.includes('introuvable')", "vidéo sans flux HLS signalée comme indisponible");
        assert.equal(await evaluate("document.getElementById('chargement').hidden"), true, "Un fichier absent ne déclenche pas une attente réseau infinie.");
        await evaluate("document.getElementById('filVideos').scrollTo({top:0,behavior:'instant'})");
        await until("new URL(location.href).searchParams.get('video') === " + JSON.stringify(id), "navigation après vidéo indisponible");
        await loaded();
        assert.equal(await evaluate("document.getElementById('message').hidden"), true);
        console.log("OK : ancienne entrée sans fichiers HLS signalée, navigation suivante utilisable.");
    }

    await send("Page.navigate", { url: origin + "/app/upload.html" });
    await until("!!document.getElementById('fichier') && typeof SV !== 'undefined'", "studio");
    const original = videos.rows.find(video => video.chemin_original);
    if (original) {
        const source = path.resolve(root, "backend", original.chemin_original);
        const documentNode = await send("DOM.getDocument");
        const input = await send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: "#fichier" });
        await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [source] });
        await until("!document.getElementById('commandesApercu').hidden", "import d'une vidéo");
        assert.ok(await evaluate("document.getElementById('titrePublication').value.length > 0"));
        assert.equal(await evaluate("document.querySelectorAll('script[src=\"upload.js\"]').length"), 1);
        await screenshot("mobile-publication");
    }
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    const unexpected = badResponses.filter(response => !response.url.endsWith("/favicon.ico") &&
        !(response.status === 404 && missingPlaylists.has(new URL(response.url).pathname)));
    assert.equal(unexpected.length, 0, "Réponses HTTP inattendues : " + unexpected.map(response => response.status + " " + response.url).join(", "));
    console.log("OK : studio et galerie, aucune exception JavaScript. Captures : .artifacts/qa/");
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ id: 999999, method: "Browser.close" })); ws.close(); }
    if (browser && browser.exitCode === null) { await Promise.race([once(browser, "exit"), delay(3000)]); if (browser.exitCode === null) browser.kill(); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    try {
        const hash = createHash("sha256").update(token).digest("hex");
        if ((await db.query("SELECT to_regclass('public.stream_profiles') IS NOT NULL AS ready")).rows[0].ready) {
            await db.query("DELETE FROM public.stream_profiles WHERE token_hash = $1", [hash]);
        }
    } finally { await db.end(); }
    // Le dossier supprimé appartient uniquement à ce lancement de test.
    const tempRoot = path.join(root, ".tmp") + path.sep;
    if (path.resolve(profileDirectory).startsWith(tempRoot)) await fs.rm(profileDirectory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
