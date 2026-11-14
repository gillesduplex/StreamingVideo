
const { Pool } = require("pg");
const path = require("node:path");

require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });

const db = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5000
});

db.on("error", (erreur) => {
    console.error(
        "Erreur de connexion PostgreSQL :",
        erreur.message
    );
});

module.exports = db;
