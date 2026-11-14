# Yo’llins Tacos – site de gestion et vitrine

Ce dossier contient un **vrai site internet** avec comptes, identifiants et mots de passe :

- `/` : la **vitrine publique** (la carte et les menus, visibles par tout le monde).
- `/gestion` : l’**outil de gestion**, réservé aux comptes de l’entreprise (ventes, dépenses, personnel, fiches, fidélité, historique).

Il n’y a **aucune dépendance** à installer : seulement Node.js (version 18 ou plus).

---

## 1. Les grades et ce qu’ils peuvent faire

| | Patron | Co-Patron | Vendeur | Stagiaire |
|---|:-:|:-:|:-:|:-:|
| Saisir des ventes (panier, remises) | ✅ | ✅ | ✅ | ✅ |
| Annuler **sa propre** vente (15 min) | ✅ | ✅ | ✅ | ✅ |
| Enregistrer ses **courses** (produit, revenu) et voir les siennes | ✅ | ✅ | ✅ | ✅ |
| Voir **toutes** les courses, par employé | ✅ | ✅ | ❌ | ❌ |
| Voir fidélité et choisir ses couleurs | ✅ | ✅ | ✅ | ✅ |
| Tableau de bord, dépenses, personnel | ✅ | ✅ | ❌ | ❌ |
| Fiches employés et notes | ✅ | ✅ | ❌ | ❌ |
| Ajouter des dépenses, verser les salaires | ✅ | ✅ | ❌ | ❌ |
| Modifier le portefeuille, les prix, les % de salaires | ✅ | ❌ | ❌ | ❌ |
| Créer/supprimer des comptes, changer un grade, réinitialiser un mot de passe | ✅ | ❌ | ❌ | ❌ |
| Clôturer la semaine (code 040212 + droits patron) | ✅ | ❌ | ❌ | ❌ |
| Télécharger une sauvegarde | ✅ | ❌ | ❌ | ❌ |

Ces règles sont **appliquées par le serveur**, pas seulement affichées : un vendeur ne peut pas les contourner en modifiant la page.
Le nom du vendeur est rempli automatiquement avec le compte connecté et ne peut pas être falsifié.

---

## 2. Essayer sur ton ordinateur (5 minutes)

1. Installe Node.js (version LTS) depuis nodejs.org.
2. Ouvre un terminal dans ce dossier et lance : `node server.js`
3. Ouvre `http://localhost:3000/gestion` dans ton navigateur.
4. Au **premier lancement**, une page te demande de créer le **compte du patron** (nom, identifiant, mot de passe de 8 caractères minimum).
5. Dans l’onglet **Personnel**, crée les comptes de tes employés (identifiant + mot de passe + grade). Donne-leur leurs identifiants.

Les données sont enregistrées dans le dossier `data/` (fichier `data.json`). Des sauvegardes quotidiennes sont gardées dans `data/backups/` (30 jours).

---

## 3. Mettre le site en ligne

**Règle essentielle : il faut un disque qui conserve les fichiers.** Les offres gratuites effacent les fichiers à chaque redémarrage ou mise à jour : tu perdrais tes ventes et tes comptes. Choisis donc une offre avec **disque persistant** (volume).

Le serveur lit deux réglages (variables d’environnement), tous deux facultatifs :

| Variable | Rôle | Valeur par défaut |
|---|---|---|
| `PORT` | port d’écoute (en général fourni par l’hébergeur) | 3000 |
| `DATA_DIR` | dossier des données = **le chemin du disque persistant** | `./data` |
| `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` | stockage gratuit en ligne à la place du disque (voir 3 bis) | aucun |

### Option A – Render (service web payant + disque)

D’après la documentation de Render, les disques persistants sont réservés aux services **payants** (pas à l’offre gratuite).

1. Mets ce dossier sur un dépôt GitHub (compte gratuit) : « New repository », puis envoie les fichiers (le fichier `.gitignore` empêche d’envoyer tes données).
2. Sur render.com : **New → Web Service**, choisis ton dépôt.
3. Runtime : **Node**. Build command : laisse vide (ou `echo ok`). Start command : `node server.js`. Type d’instance : **payante** (pas Free).
4. Dans **Advanced → Add Disk** : mount path `/opt/render/project/src/data`, taille 1 Go suffit largement.
   → Ce chemin correspond au dossier `data/` par défaut, donc **aucune variable à régler**.
5. Valide. Une fois déployé, ouvre l’adresse fournie : `/` pour la vitrine, `/gestion` pour l’outil.

### Option B – Railway (avec volume)

Railway propose des volumes persistants (la documentation indique des volumes selon les offres).

1. Dépôt GitHub comme ci-dessus, puis **New Project → Deploy from GitHub repo**.
2. Dans le service : ajoute un **Volume** avec le chemin de montage `/data`.
3. Dans **Variables**, ajoute `DATA_DIR` = `/data`.
4. Génère un domaine public dans les réglages réseau du service. Start command : `node server.js` (détecté automatiquement via `package.json`).

### Option C – Serveur privé (VPS) ou Docker

Convient si tu as déjà un serveur. Avec Docker : `docker build -t yollins .` puis
`docker run -d -p 3000:3000 -v yollins-data:/data --restart unless-stopped yollins`.
Mets ensuite un **proxy HTTPS** devant (par exemple Caddy, qui gère le certificat tout seul).

### Nom de domaine

Chez Render comme Railway, ajoute ton propre nom de domaine dans les réglages « Custom domain », puis crée l’enregistrement DNS demandé chez ton fournisseur de domaine. Le HTTPS est mis en place par l’hébergeur.

---

## 3 bis. Version 100 % gratuite (sans disque, sans serveur à gérer)

Le site peut enregistrer ses données dans une **base gratuite en ligne (Upstash Redis)** au lieu d’un fichier. Il peut alors tourner sur un hébergeur gratuit **sans disque**. Rien d’autre à modifier : si les deux réglages ci-dessous sont présents, le site les utilise tout seul.

Limites à connaître : l’hébergeur gratuit **met le site en veille après environ 15 minutes sans visite** et il met alors environ une minute à se réveiller. Les données, elles, ne sont pas perdues. Vérifie sur les pages des deux services que leur offre gratuite existe toujours et si une carte bancaire est demandée à l’inscription.

1. **Base de données** : crée un compte gratuit sur upstash.com, puis « Create Database » (Redis, offre gratuite). Sur la page de la base, copie les deux valeurs de la partie **REST** : `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`.
2. **Dépôt GitHub** : mets ce dossier sur un dépôt GitHub (compte gratuit).
3. **Hébergeur gratuit** : sur render.com, **New → Web Service**, choisis ton dépôt. Runtime **Node**, start command `node server.js`, type d’instance **Free**.
4. Dans **Environment**, ajoute les deux variables : `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` (valeurs copiées à l’étape 1).
5. Valide. Ouvre l’adresse fournie : `/` pour la vitrine, `/gestion` pour l’outil. Crée le compte patron au premier lancement.

Sauvegarde : dans ce mode, les sauvegardes quotidiennes automatiques n’existent pas. **Télécharge une sauvegarde de temps en temps** (onglet *Couleurs* → *Mon compte*).

---

## 4. Sécurité : ce qui est en place

- Mots de passe **chiffrés (scrypt)**, jamais stockés en clair.
- Sessions par cookie **HttpOnly, SameSite=Strict**, et **Secure** dès que le site est en HTTPS. Valables 7 jours.
- **Verrouillage 15 minutes** après 5 échecs de connexion (par identifiant et par adresse).
- Quand tu **changes un mot de passe**, supprimes un compte ou changes un grade, les droits s’appliquent tout de suite : l’ancienne session ne marche plus.
- Contrôle d’origine des requêtes, en-têtes de sécurité, limite de taille des envois.
- Le dossier `data/` n’est jamais servi sur internet.

À faire de ton côté :

- Choisis des mots de passe **différents** pour chaque personne.
- Le code de clôture de semaine n’est pas écrit en clair dans la page (seule son empreinte y figure), mais il n’est qu’une confirmation de plus : la vraie protection est le compte patron. **Garde son mot de passe pour toi.**
- **Télécharge une sauvegarde** de temps en temps : onglet *Couleurs* → *Mon compte* → « Télécharger une sauvegarde des données ». Pour restaurer, remets ce fichier sous le nom `data.json` dans le dossier de données et redémarre.

### Mot de passe patron oublié

Dans les variables d’environnement de l’hébergeur, ajoute :
`RESET_PASSWORD_USER` = ton identifiant et `RESET_PASSWORD_NEW` = un nouveau mot de passe (8 caractères min.), puis redémarre. Connecte-toi, **puis supprime ces deux variables**.

---

## 5. Au quotidien

- **Prix** : le patron les modifie dans l’onglet *Ventes* (catalogue). La vitrine publique se met à jour toute seule pour les produits du catalogue (hors nouveaux produits, qui demandent une modification du code).
- **Fin de semaine** : onglet *Personnel* → verser les salaires, puis onglet *Historique* → saisir le code → « Clôturer la semaine ». Les ventes et dépenses sont archivées, le portefeuille et les points de fidélité sont conservés.
- **Ajouter un produit ou un grade** : cela demande une modification du code (liste `MENU` dans `public/gestion.html`, liste `GRADES` dans `gestion.html` et `server.js`).
- Les couleurs (onglet *Couleurs*) sont enregistrées dans le navigateur de chacun.
