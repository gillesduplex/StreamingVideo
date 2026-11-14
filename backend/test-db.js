
const db = require("./config/db");

async function testerConnexion() {

    try {
        const resultat = await db.query(`
            SELECT
                current_database() AS base,
                current_user AS utilisateur
        `);

        console.log("Connexion PostgreSQL réussie !");
        console.log("Base :", resultat.rows[0].base);
        console.log(
            "Utilisateur :",
            resultat.rows[0].utilisateur
        );

        const tables = await db.query(`
            SELECT COUNT(*)::integer AS nombre
            FROM public.videos
        `);

        console.log(
            "Nombre de vidéos enregistrées :",
            tables.rows[0].nombre
        );

    } catch (erreur) {
        console.error(
            "Erreur PostgreSQL :",
            erreur.message
        );
        process.exitCode = 1;

    } finally {
        await db.end();
    }
}

testerConnexion();
