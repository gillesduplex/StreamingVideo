# StreamingVideo

Application Cordova et navigateur avec lecture HLS adaptative, fil vidéo vertical, recherche, tendances, favoris, likes, commentaires, réponses et partage.

## Démarrer

Le projet utilise les dépendances déjà présentes dans `node_modules` et `backend/node_modules`. Si nécessaire, les installer avec `npm install` puis `npm --prefix backend install`.

La connexion PostgreSQL est configurée dans `backend/.env` : `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` et éventuellement `PORT` (3001 par défaut). Ce fichier doit rester privé.

Avant le premier lancement de cette version, ouvrir **la base du projet** dans pgAdmin avec son propriétaire (`postgres` dans l'installation actuelle) et exécuter **`backend/migrations/001-social.sql`**. La migration conserve les vidéos et crée les tables sociales. Elle donne les droits de lecture et d'écriture au compte existant `streamingvideo_app`, sans lui donner les droits de modification de la structure. Pour une autre installation, adapter ce nom de rôle dans la ligne `GRANT` du script.

```sh
npm start
```

Ouvrir **http://localhost:3001/app/**. La publication est disponible depuis le bouton **Créer**, à **http://localhost:3001/app/upload.html**. L'ancienne adresse `/upload.html` redirige vers cette page unique.

Pour créer les miniatures des vidéos déjà enregistrées, sans les réencoder :

```sh
npm --prefix backend run thumbnails
```

Les nouvelles vidéos reçoivent automatiquement leur miniature.

## Sur Android

`www` reste la source de l'application Cordova. Configurer l'adresse du serveur dans `www/js/config.js`, ainsi que les origines autorisées dans les politiques CSP de `www/index.html` et `www/upload.html` et dans `config.xml`. L'adresse de développement actuelle est `http://192.168.1.193:3001`. Le téléphone et l'ordinateur doivent pouvoir joindre ce serveur.

```sh
npx cordova run android
```

La création de vidéos conserve la caméra native existante et l'import depuis la galerie. Dans un navigateur, l'accès à la caméra nécessite localhost ou HTTPS ; sur une adresse réseau en HTTP, utiliser la galerie.

## Interactions

- Toucher la vidéo pour lire ou mettre en pause ; double toucher pour aimer.
- Glisser verticalement, utiliser la molette ou les flèches pour changer de vidéo.
- Le fil fait défiler la publication entière : vidéo, auteur, titre et boutons. Deux lecteurs au maximum sont réutilisés : la vidéo visible et le début de la suivante. Une couverture indépendante reste affichée jusqu'à la première image vidéo.
- Le téléchargement donne la priorité à la vidéo visible : le début de la suivante est préparé après 8 secondes de réserve, puis suspendu si la réserve descend sous 5 secondes. Si toute la fin est déjà en mémoire, la préparation peut commencer plus tôt. Elle respecte aussi la suspension de l'application et l'économie de données signalée par l'appareil. La qualité automatique conserve une marge de débit pour limiter les interruptions.
- La vidéo active peut accumuler environ 30 à 45 secondes de réserve sans attendre ce remplissage pour démarrer. Après une interruption réelle, le lecteur garde son image et sa position, attend 3 secondes de données contiguës (ou toute la fin restante), puis reprend. Les erreurs réseau déclenchent des tentatives espacées de 1 à 8 secondes ; elles ne recommencent pas la vidéo à zéro.
- Le mode Automatique adapte les prochains segments au débit mesuré et réutilise une estimation récente entre publications. Le choix de qualité conserve les segments déjà chargés. Une ancienne vidéo qui ne possède qu'une variante reste à cette résolution ; le menu le signale. Les segments publiés sont mis en cache pour les passages suivants.
- Aucun rond de chargement n'est affiché entre les vidéos. Une attente de données prolongée affiche « Connexion instable », puis « Chargement… Connexion instable ». Lorsque l'appareil est hors ligne et que la lecture ne peut plus avancer, « Connexion interrompue. Chargement… » apparaît. Une pause volontaire ne déclenche pas ces messages.
- Les cœurs, favoris, commentaires, réponses et likes de commentaires sont enregistrés dans PostgreSQL.
- Le panneau de commentaires permet de répondre et de supprimer ses propres commentaires. Les réponses à des réponses restent dans le même fil.
- Le partage utilise le menu natif quand il est disponible, ou un lien copiable qui ouvre directement la vidéo. Un partage est compté après un partage natif réussi ou une copie réussie du lien.
- **Mon espace** permet de choisir un pseudo. Un secret aléatoire enregistré sur l'appareil identifie ce profil ; il n'est pas publié avec les commentaires. Il ne s'agit pas encore d'un compte avec connexion et récupération. Effacer les données du navigateur crée un nouveau profil.
- **Tendances** trie le catalogue selon les likes et commentaires. **Mes favoris** et **Vidéos aimées** affichent les choix de cet appareil.

## Vérification

```sh
npm test
npm run test:browser
```

Les tests d'API utilisent PostgreSQL et créent leurs propres vidéos et profils de test, supprimés à la fin. Les tests de navigateur utilisent Chrome installé sur Windows, un serveur temporaire et un profil de test indépendant. Ils sauvegardent les captures dans `.artifacts/qa/`. Aucun téléchargement de navigateur n'est nécessaire.

La vérification navigateur couvre les vrais gestes tactiles, le déplacement de toute la publication, la lecture à 2,5 Mbit/s, l'adaptation 5 → 0,8 → 5 Mbit/s et une coupure qui épuise réellement le tampon alors que l'appareil reste connecté. Elle vérifie la conservation de l'image, de la position et du lecteur, puis la reprise sans saut de segment.
