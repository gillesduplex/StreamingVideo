# StreamingVideo

Application Cordova et navigateur avec lecture HLS adaptative, fil vertical de vidéos et de carrousels photo, recherche, tendances, favoris, likes, commentaires, réponses et partage.

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

`www` reste la source de l'application Cordova. Configurer l'adresse du serveur dans `www/js/config.js`, ainsi que les origines autorisées dans les politiques CSP de `www/index.html` et `www/upload.html` et dans `config.xml`. L'adresse de développement actuelle est `http://192.168.1.193:3001`. Le téléphone et l'ordinateur doivent pouvoir joindre ce serveur. L'écran d'ouverture Android utilise le logo StreamingVideo plutôt que l'icône Cordova.

```sh
npx cordova run android
```

La création de vidéos conserve la caméra native existante et l'import depuis la galerie. Dans un navigateur, l'accès à la caméra nécessite localhost ou HTTPS ; sur une adresse réseau en HTTP, utiliser la galerie.

## Publication avec reprise

- Sur Cordova, la vidéo est copiée par tranches dans le dossier privé `dataDirectory/streamingvideo-uploads` ; l'envoi peut commencer dès qu'un bloc entier a été copié. Prévoir assez d'espace pour cette copie. Sur navigateur, le Blob est conservé dans IndexedDB avant l'envoi et reste soumis au quota du navigateur.
- IndexedDB conserve les informations de la publication, son identité et le dernier avancement. Après fermeture et réouverture, une publication en cours reprend automatiquement ; une pause volontaire attend le bouton Continuer. La copie locale est retirée après publication réussie, sans toucher à la vidéo de la galerie.
- Quand tu reviens au fil, un petit indicateur affiche l'état de l'envoi et permet de rouvrir le suivi. Une notification reste affichée quand la vidéo est prête.
- Le client envoie des blocs séquentiels, initialement de 5 Mio, puis ajuste leur taille entre 5 et 8 Mio selon le débit confirmé (sauf dernier bloc). La vitesse et le temps restant sont des estimations ; la progression en cours peut inclure un bloc pas encore confirmé.
- Le serveur conserve la session et les fichiers partiels dans `backend/uploads/temporaires/reprises`. Les nouvelles routes sont `POST /api/uploads`, `GET /api/uploads/:id`, `PATCH /api/uploads/:id`, `POST /api/uploads/:id/complete` et `DELETE /api/uploads/:id`. La position confirmée par le serveur fait foi. Chaque bloc est limité à 8 Mio et la taille totale à 2 Gio.
- Ces sessions sur disque supposent un seul processus Node qui gère ce dossier. Aucune migration PostgreSQL supplémentaire n'est nécessaire. Un encodage FFmpeg déjà lancé lors d'un arrêt brutal reste signalé en erreur au redémarrage, afin d'éviter deux conversions simultanées. Une annulation effectuée sans connexion peut laisser un fichier partiel côté serveur.
- La reprise se fait à la réouverture de l'application. La poursuite pendant que l'application est complètement fermée nécessiterait un service Android natif supplémentaire.
- Une coupure réseau ne stoppe pas la copie locale. Si la copie n'est pas terminée à la fermeture, l'accès à la source d'origine peut avoir expiré ; l'application conserve alors le travail et indique si une nouvelle sélection ou une vérification est nécessaire. Une fois la copie complète, l'original de la galerie peut disparaître sans empêcher la reprise. La suppression de la source pendant la copie peut être détectée si Android refuse sa lecture ; certaines WebViews conservent une vue temporaire du fichier.
- Mettre une publication en pause conserve la session et la copie privée. « Reprendre » continue avec la source encore accessible. « Annuler » retire la fiche du suivi en gardant la copie et la session ; une nouvelle sélection du même fichier peut les retrouver après vérification. Si une ancienne copie est incomplète et que la source d'origine n'est plus accessible, l'application demande de confirmer la sélection, compare la partie déjà copiée et indique que l'identité de la partie manquante ne peut pas être vérifiée.
- Pour accélérer la préparation, le serveur encode jusqu'à deux qualités en parallèle lorsqu'au moins quatre processeurs logiques sont disponibles ; il attend la fin de toutes les qualités avant de publier le master. Le gain dépend du processeur et du disque.

## Publications photo

Le studio propose **Photos** pour sélectionner plusieurs images. Elles avancent automatiquement toutes les trois secondes par défaut ; le compteur `1/N` suit la lecture et les flèches ou un balayage horizontal permettent de changer de photo manuellement. Le serveur assemble les images en un diaporama HLS afin de réutiliser le lecteur et le fil existants.

Une publication peut rester muette, recevoir un fichier audio local, extraire le son d'une vidéo ou choisir un son du catalogue. Le catalogue est administré côté serveur : déposer uniquement des fichiers audio dont l'application possède les droits dans `backend/storage/sounds`. Le serveur crée ce dossier au démarrage et `GET /api/photo-posts/sounds` liste les fichiers pris en charge ; aucune route publique ne permet d'y ajouter des sons.

La migration sociale `backend/migrations/001-social.sql` ajoute les métadonnées des publications photo ; la réexécuter avec le propriétaire de la base applique les nouveaux champs sans supprimer les vidéos. Le traitement conserve des limites techniques : 1 000 photos par envoi, 50 Mio par photo et 2 Gio au total.

## Interactions

- Toucher la vidéo pour lire ou mettre en pause ; double toucher pour aimer.
- Glisser verticalement, utiliser la molette ou les flèches pour changer de vidéo.
- Les vidéos de plus d'une minute proposent le plein écran. Le plugin Cordova local demande l'orientation paysage sur Android, puis rétablit l'orientation demandée précédemment en quittant le lecteur ou la page ; le lecteur retente automatiquement la lecture si la WebView la met en pause pendant la rotation. Sur navigateur, le lecteur essaie l'API d'orientation ; si elle est refusée, il propose de tourner l'appareil. La vidéo garde ses proportions et le bouton, la touche Échap ou le retour Android ramènent au fil.
- L'historique de lecture de la session se trouve dans le menu « ⋯ ». Les positions sont conservées lors d'un changement de vidéo ou de page dans l'application, puis effacées lors d'une actualisation. Un maintien au centre accélère la lecture à 2× jusqu'au relâchement ; maintenir le côté droit ou gauche avance ou recule par pas de 10 secondes, en portrait comme en plein écran paysage. La barre de progression reste utilisable.
- Le fil fait défiler la publication entière : vidéo, auteur, titre et boutons. Deux lecteurs au maximum sont réutilisés : la vidéo visible et le début de la suivante. Une couverture indépendante reste affichée jusqu'à la première image vidéo.
- Le téléchargement donne la priorité à la vidéo visible : le début de la suivante est préparé après 6 secondes de réserve, puis suspendu si la réserve descend sous 4 secondes. Si toute la fin est déjà en mémoire, la préparation peut commencer plus tôt. Elle respecte aussi la suspension de l'application et l'économie de données signalée par l'appareil. La qualité automatique conserve une marge de débit pour limiter les interruptions.
- La vidéo active peut accumuler environ 30 à 45 secondes de réserve sans attendre ce remplissage pour démarrer. Après une interruption réelle, le lecteur garde son image et sa position, attend 1,5 seconde de données contiguës (ou toute la fin restante), puis reprend. Les erreurs réseau déclenchent des tentatives espacées de 1 à 8 secondes ; elles ne recommencent pas la vidéo à zéro.
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
npm run test:upload
npm run test:upload:browser
node --test scripts/test-progressive.js
```

Les tests d'API utilisent PostgreSQL et créent leurs propres vidéos et profils de test, supprimés à la fin. Les tests de navigateur utilisent Chrome installé sur Windows, un serveur temporaire et un profil de test indépendant. Ils sauvegardent les captures dans `.artifacts/qa/`. Aucun téléchargement de navigateur n'est nécessaire.

La vérification navigateur couvre les vrais gestes tactiles, le déplacement de toute la publication, la lecture à 2,5 Mbit/s, l'adaptation 5 → 0,8 → 5 Mbit/s et une coupure qui épuise réellement le tampon alors que l'appareil reste connecté. Elle vérifie la conservation de l'image, de la position et du lecteur, puis la reprise sans saut de segment.
