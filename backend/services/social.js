"use strict";

const express = require("express");
const { randomUUID, createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function initialiserSocial(db) {
    const ready = await db.query(`
        SELECT (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ANY($1::text[])) = 6
            AND (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'videos' AND column_name = ANY($2::text[])) = 7 AS ready
    `, [["stream_profiles", "video_likes", "video_saves", "video_shares", "video_comments", "comment_likes"],
        ["auteur_id", "description", "chemin_affiche", "media_type", "photo_count", "photo_interval_seconds", "audio_title"]]);
    if (ready.rows[0].ready) return;
    const sql = await fs.readFile(path.join(__dirname, "../migrations/001-social.sql"), "utf8");
    // Une connexion unique garde toute la migration dans la même transaction.
    const client = await db.connect();
    try {
        await client.query(sql);
    } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "42501") {
            throw new Error("Mise à jour PostgreSQL nécessaire : exécute backend/migrations/001-social.sql avec le propriétaire de la base (postgres), puis redémarre le serveur.", { cause: error });
        }
        throw error;
    } finally {
        client.release();
    }
}

async function enrichirVideos(db, videos, profileId = null) {
    if (!videos.length) return videos;
    const { rows } = await db.query(`
        SELECT v.id, COALESCE(p.pseudo, 'La communauté') AS author,
            v.auteur_id AS "authorId", v.description, v.chemin_affiche AS poster,
            (SELECT COUNT(*)::int FROM public.video_likes l WHERE l.video_id = v.id) AS likes,
            (SELECT COUNT(*)::int FROM public.video_comments c WHERE c.video_id = v.id) AS comments,
            (SELECT COUNT(*)::int FROM public.video_shares s WHERE s.video_id = v.id) AS shares,
            EXISTS(SELECT 1 FROM public.video_likes l WHERE l.video_id = v.id AND l.profile_id = $2) AS liked,
            EXISTS(SELECT 1 FROM public.video_saves s WHERE s.video_id = v.id AND s.profile_id = $2) AS saved
        FROM public.videos v
        LEFT JOIN public.stream_profiles p ON p.id = v.auteur_id
        WHERE v.id = ANY($1::uuid[])
    `, [videos.map(v => v.id), profileId]);
    const social = new Map(rows.map(v => [v.id, v]));
    return videos.map(v => ({ ...v, ...social.get(v.id) }));
}

function creerSocial(db) {
    const router = express.Router();

    // Le secret de l'appareil n'est jamais exposé dans un commentaire public.
    router.use(route(async (req, res, next) => {
        const token = req.get("X-Visitor-Token");
        req.profile = null;
        if (!token) return next();
        if (!UUID.test(token)) return res.status(400).json({ message: "Identifiant d'appareil invalide." });
        const hash = createHash("sha256").update(token).digest("hex");
        let { rows } = await db.query("SELECT id, pseudo FROM public.stream_profiles WHERE token_hash = $1", [hash]);
        if (!rows.length) {
            ({ rows } = await db.query(`
                INSERT INTO public.stream_profiles (id, token_hash, pseudo)
                VALUES ($1, $2, $3)
                ON CONFLICT (token_hash) DO UPDATE SET token_hash = EXCLUDED.token_hash
                RETURNING id, pseudo
            `, [randomUUID(), hash, "Visiteur " + hash.slice(0, 4).toUpperCase()]));
        }
        req.profile = rows[0];
        next();
    }));

    const identifier = (req, res, next) => req.profile
        ? next() : res.status(401).json({ message: "Ton profil n'a pas pu être identifié. Recharge la page." });

    for (const param of ["videoId", "commentId"]) {
        router.param(param, (req, res, next, value) => UUID.test(value)
            ? next() : res.status(400).json({ message: "Identifiant invalide." }));
    }

    const videoExiste = route(async (req, res, next) => {
        const { rowCount } = await db.query("SELECT id FROM public.videos WHERE id = $1 AND statut = 'prete'", [req.params.videoId]);
        if (!rowCount) return res.status(404).json({ message: "Vidéo introuvable." });
        next();
    });

    async function statistiques(videoId, profileId) {
        return (await enrichirVideos(db, [{ id: videoId }], profileId))[0];
    }

    router.get("/profile", identifier, route(async (req, res) => {
        const { rows } = await db.query(`
            SELECT (SELECT COUNT(*)::int FROM public.video_likes WHERE profile_id = $1) AS likes,
                (SELECT COUNT(*)::int FROM public.video_saves WHERE profile_id = $1) AS saves,
                (SELECT COUNT(*)::int FROM public.video_comments WHERE profile_id = $1) AS comments,
                (SELECT COUNT(*)::int FROM public.videos WHERE auteur_id = $1) AS publications
        `, [req.profile.id]);
        res.json({ ...req.profile, ...rows[0] });
    }));

    router.patch("/profile", identifier, route(async (req, res) => {
        const pseudo = typeof req.body?.pseudo === "string" ? req.body.pseudo.trim() : "";
        if (pseudo.length < 2 || pseudo.length > 32 || /[\u0000-\u001f\u007f]/.test(pseudo)) {
            return res.status(400).json({ message: "Choisis un pseudo de 2 à 32 caractères." });
        }
        const { rows } = await db.query("UPDATE public.stream_profiles SET pseudo = $1 WHERE id = $2 RETURNING id, pseudo", [pseudo, req.profile.id]);
        res.json(rows[0]);
    }));

    router.get("/videos/:videoId/social", videoExiste, route(async (req, res) => {
        res.json(await statistiques(req.params.videoId, req.profile?.id));
    }));

    for (const [resource, table] of [["like", "video_likes"], ["save", "video_saves"]]) {
        router.put(`/videos/:videoId/${resource}`, identifier, videoExiste, route(async (req, res) => {
            await db.query(`INSERT INTO public.${table} (video_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.params.videoId, req.profile.id]);
            res.json(await statistiques(req.params.videoId, req.profile.id));
        }));
        router.delete(`/videos/:videoId/${resource}`, identifier, videoExiste, route(async (req, res) => {
            await db.query(`DELETE FROM public.${table} WHERE video_id = $1 AND profile_id = $2`, [req.params.videoId, req.profile.id]);
            res.json(await statistiques(req.params.videoId, req.profile.id));
        }));
    }

    router.post("/videos/:videoId/share", identifier, videoExiste, route(async (req, res) => {
        if (!UUID.test(req.body?.eventId || "")) return res.status(400).json({ message: "Identifiant de partage invalide." });
        await db.query(`INSERT INTO public.video_shares (video_id, profile_id, event_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [req.params.videoId, req.profile.id, req.body.eventId]);
        res.json(await statistiques(req.params.videoId, req.profile.id));
    }));

    const commentaireSQL = `
        SELECT c.id, c.video_id AS "videoId", c.parent_id AS "parentId", c.texte,
            c.created_at AS date, p.pseudo, p.id AS "authorId", target.pseudo AS "replyTo",
            c.profile_id = $2::uuid AS mine,
            (SELECT COUNT(*)::int FROM public.comment_likes l WHERE l.comment_id = c.id) AS likes,
            EXISTS(SELECT 1 FROM public.comment_likes l WHERE l.comment_id = c.id AND l.profile_id = $2) AS liked,
            (SELECT COUNT(*)::int FROM public.video_comments r WHERE r.parent_id = c.id) AS "replyCount"
        FROM public.video_comments c
        JOIN public.stream_profiles p ON p.id = c.profile_id
        LEFT JOIN public.video_comments replied ON replied.id = c.reply_to_id
        LEFT JOIN public.stream_profiles target ON target.id = replied.profile_id
    `;

    router.get("/videos/:videoId/comments", videoExiste, route(async (req, res) => {
        const before = req.query.before || null;
        if (before && !UUID.test(before)) return res.status(400).json({ message: "Page de commentaires invalide." });
        const { rows } = await db.query(commentaireSQL + `
            WHERE c.video_id = $1 AND c.parent_id IS NULL
                AND ($3::uuid IS NULL OR (c.created_at, c.id) <
                    (SELECT created_at, id FROM public.video_comments WHERE id = $3 AND video_id = $1 AND parent_id IS NULL))
            ORDER BY c.created_at DESC, c.id DESC LIMIT $4
        `, [req.params.videoId, req.profile?.id || null, before, PAGE_SIZE + 1]);
        const hasMore = rows.length > PAGE_SIZE;
        const items = rows.slice(0, PAGE_SIZE);
        const stats = await statistiques(req.params.videoId, req.profile?.id);
        res.json({ items, nextCursor: hasMore ? items.at(-1).id : null, total: stats.comments });
    }));

    router.get("/comments/:commentId/replies", route(async (req, res) => {
        const after = req.query.after || null;
        if (after && !UUID.test(after)) return res.status(400).json({ message: "Page de réponses invalide." });
        const parent = await db.query("SELECT id FROM public.video_comments WHERE id = $1 AND parent_id IS NULL", [req.params.commentId]);
        if (!parent.rowCount) return res.status(404).json({ message: "Commentaire introuvable." });
        const { rows } = await db.query(commentaireSQL + `
            WHERE c.parent_id = $1
                AND ($3::uuid IS NULL OR (c.created_at, c.id) >
                    (SELECT created_at, id FROM public.video_comments WHERE id = $3 AND parent_id = $1))
            ORDER BY c.created_at, c.id LIMIT $4
        `, [req.params.commentId, req.profile?.id || null, after, PAGE_SIZE + 1]);
        const hasMore = rows.length > PAGE_SIZE;
        const items = rows.slice(0, PAGE_SIZE);
        res.json({ items, nextCursor: hasMore ? items.at(-1).id : null });
    }));

    router.post("/videos/:videoId/comments", identifier, videoExiste, route(async (req, res) => {
        const texte = typeof req.body?.texte === "string" ? req.body.texte.trim() : "";
        if (!texte || texte.length > 1000 || texte.includes("\u0000")) {
            return res.status(400).json({ message: "Écris un commentaire de 1 à 1 000 caractères." });
        }
        let parentId = null;
        const replyTo = req.body?.parentId || null;
        if (replyTo) {
            if (!UUID.test(replyTo)) return res.status(400).json({ message: "Réponse invalide." });
            const parent = await db.query("SELECT id, parent_id FROM public.video_comments WHERE id = $1 AND video_id = $2", [replyTo, req.params.videoId]);
            if (!parent.rowCount) return res.status(404).json({ message: "Le commentaire auquel tu réponds n'existe plus." });
            parentId = parent.rows[0].parent_id || parent.rows[0].id;
        }
        const recent = await db.query("SELECT COUNT(*)::int AS total FROM public.video_comments WHERE profile_id = $1 AND created_at > NOW() - INTERVAL '1 minute'", [req.profile.id]);
        if (recent.rows[0].total >= 10) return res.status(429).json({ message: "Tu publies très vite. Réessaie dans une minute." });
        const id = randomUUID();
        await db.query(`INSERT INTO public.video_comments (id, video_id, profile_id, parent_id, reply_to_id, texte)
            VALUES ($1, $2, $3, $4, $5, $6)`, [id, req.params.videoId, req.profile.id, parentId, replyTo, texte]);
        const { rows } = await db.query(commentaireSQL + " WHERE c.id = $1", [id, req.profile.id]);
        res.status(201).json({ comment: rows[0], social: await statistiques(req.params.videoId, req.profile.id) });
    }));

    for (const method of ["put", "delete"]) {
        router[method]("/comments/:commentId/like", identifier, route(async (req, res) => {
            const existing = await db.query("SELECT id FROM public.video_comments WHERE id = $1", [req.params.commentId]);
            if (!existing.rowCount) return res.status(404).json({ message: "Commentaire introuvable." });
            if (method === "put") {
                await db.query("INSERT INTO public.comment_likes (comment_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.params.commentId, req.profile.id]);
            } else {
                await db.query("DELETE FROM public.comment_likes WHERE comment_id = $1 AND profile_id = $2", [req.params.commentId, req.profile.id]);
            }
            const { rows } = await db.query(commentaireSQL + " WHERE c.id = $1", [req.params.commentId, req.profile.id]);
            res.json(rows[0]);
        }));
    }

    router.delete("/comments/:commentId", identifier, route(async (req, res) => {
        const { rows } = await db.query("DELETE FROM public.video_comments WHERE id = $1 AND profile_id = $2 RETURNING video_id", [req.params.commentId, req.profile.id]);
        if (!rows.length) return res.status(404).json({ message: "Ce commentaire n'existe plus ou ne t'appartient pas." });
        res.json(await statistiques(rows[0].video_id, req.profile.id));
    }));

    return router;
}

module.exports = { initialiserSocial, enrichirVideos, creerSocial };
