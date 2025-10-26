# Guide de déploiement sur Render.com

## 📋 Prérequis

- Un compte GitHub
- Un compte Render.com (gratuit)
- Une clé API OpenAI valide
- Une base de données PostgreSQL (Render en fournit gratuitement)

---

## 🚀 Étapes de déploiement

### 1. Préparer le dépôt GitHub

#### A. Créer un fichier `.gitignore` (si pas déjà fait)

Créez `.gitignore` à la racine du projet avec ce contenu :

```
node_modules/
.env
.env.local
logs/*.log
dist/
.DS_Store
```

**⚠️ IMPORTANT** : Ne JAMAIS commit le fichier `.env` avec vos clés secrètes !

#### B. Initialiser Git et pousser sur GitHub

Dans le terminal (cmd) :

```cmd
cd /d e:\02.[Travail]\promptr

rem Initialiser git si pas déjà fait
git init

rem Ajouter tous les fichiers (sauf ceux dans .gitignore)
git add .

rem Créer le premier commit
git commit -m "Initial commit - X402 Prompt Refiner"

rem Se connecter à GitHub (si pas déjà fait)
rem Créer un nouveau repo sur github.com (exemple: promptr)

rem Lier le repo local au repo GitHub (remplacer YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/promptr.git

rem Pousser le code
git branch -M main
git push -u origin main
```

---

### 2. Créer une base de données PostgreSQL sur Render

1. Allez sur https://render.com et connectez-vous
2. Cliquez sur **"New +"** → **"PostgreSQL"**
3. Configurez :
   - **Name** : `promptr-db`
   - **Database** : `promptr_postgre`
   - **User** : `promptr_postgre_user`
   - **Region** : Frankfurt (ou proche de vous)
   - **Plan** : Free
4. Cliquez **"Create Database"**
5. Une fois créée, copiez l'**Internal Database URL** (commence par `postgresql://`)

---

### 3. Déployer l'application sur Render

#### A. Créer un nouveau Web Service

1. Sur Render.com, cliquez **"New +"** → **"Web Service"**
2. Connectez votre compte GitHub si demandé
3. Sélectionnez le repo `promptr`
4. Configurez :
   - **Name** : `promptr` (ou autre nom unique)
   - **Region** : Frankfurt
   - **Branch** : `main`
   - **Root Directory** : (laisser vide)
   - **Environment** : `Node`
   - **Build Command** : `npm install && npm run build`
   - **Start Command** : `npm start`
   - **Plan** : Free

#### B. Ajouter les variables d'environnement

Dans la section **"Environment"**, ajoutez ces variables :

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `10000` |
| `DATABASE_URL` | *(coller l'URL PostgreSQL de l'étape 2)* |
| `OPENAI_API_KEY` | `sk-proj-VOTRE_CLE_ICI` |
| `SOLANA_NETWORK` | `mainnet-beta` |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` *(ou votre RPC payant)* |
| `X402_AMOUNT_USDC` | `0.001` |
| `X402_RECEIVER_ADDRESS` | `3LrVwGYoqUgvwUadaCrkpqBNqkgVcWpac7CYM99KbQHk` |
| `X402_FACILITATOR_API_URL` | `https://facilitator.payai.network` |
| `LOG_LEVEL` | `info` |
| `LOG_FILE` | `logs/app.log` |
| `VITE_DONATION_ADDRESS` | `3LrVwGYoqUgvwUadaCrkpqBNqkgVcWpac7CYM99KbQHk` |

#### C. Déployer

1. Cliquez **"Create Web Service"**
2. Render va automatiquement :
   - Cloner votre repo
   - Installer les dépendances (`npm install`)
   - Builder le frontend (`npm run build`)
   - Démarrer le serveur (`npm start`)

---

### 4. Vérifier le déploiement

1. Attendez que le build soit terminé (status **"Live"** en vert)
2. Cliquez sur l'URL fournie (ex: `https://promptr.onrender.com`)
3. Testez l'application :
   - Connectez Phantom wallet
   - Essayez un paiement de 0.001 USDC
   - Vérifiez que le prompt est raffiné

---

## 🔧 Mises à jour automatiques

Render redéploie automatiquement à chaque push sur `main` :

```cmd
rem Faire des modifications
git add .
git commit -m "Description des changements"
git push origin main
```

Render détectera le push et redéploiera automatiquement.

---

## 📊 Logs et monitoring

### Voir les logs en temps réel
1. Sur le dashboard Render de votre service
2. Cliquez sur l'onglet **"Logs"**

### Accéder à la base de données
1. Dans le dashboard de votre PostgreSQL database
2. Copiez les credentials (host, user, password)
3. Connectez-vous avec un client PostgreSQL (ex: pgAdmin, DBeaver)

---

## ⚠️ Points importants

### Limites du plan gratuit Render :
- **Sleep après inactivité** : Le service s'endort après 15 min d'inactivité
- **Réveil lent** : Premier accès après sleep = ~30 secondes
- **750h/mois** : Limite du plan gratuit

### Solutions si besoin de plus de performance :
1. **Passer au plan payant** ($7/mois = service toujours actif)
2. **Utiliser un RPC Solana payant** (ex: Helius, QuickNode) pour éviter rate limits
3. **Optimiser les logs** : réduire `LOG_LEVEL` à `warn` en production

---

## 🔐 Sécurité

✅ **À faire** :
- Ne JAMAIS commit le `.env`
- Utiliser des variables d'environnement Render pour les secrets
- Régénérer les clés API régulièrement

❌ **À éviter** :
- Exposer les clés dans les logs
- Utiliser la même clé OpenAI partout
- Désactiver le rate limiting

---

## 🐛 Dépannage

### Le build échoue
- Vérifiez les logs de build sur Render
- Assurez-vous que `package.json` contient tous les scripts
- Vérifiez que `node_modules` est dans `.gitignore`

### OpenAI retourne 401
- Vérifiez que `OPENAI_API_KEY` est bien configurée sur Render
- Vérifiez que la clé a les bons scopes (model.request)
- Testez la clé localement avec `node test_openai_key.js`

### Solana RPC rate limited (429)
- Utilisez un RPC payant (Helius, QuickNode, Alchemy)
- Ajoutez `SOLANA_RPC_URL` dans les variables Render
- Exemple Helius : `https://mainnet.helius-rpc.com/?api-key=VOTRE_CLE`

### Le service s'endort trop souvent
- Passez au plan payant ($7/mois)
- Ou utilisez un service de "ping" gratuit (ex: UptimeRobot) pour garder actif

---

## 📚 Ressources utiles

- Documentation Render : https://render.com/docs
- Dashboard Render : https://dashboard.render.com
- PostgreSQL sur Render : https://render.com/docs/databases
- Solana RPC Providers : https://solana.com/rpc
- OpenAI Platform : https://platform.openai.com

---

## ✨ Prochaines étapes (optionnel)

1. **Ajouter un nom de domaine personnalisé** (ex: `promptr.votredomaine.com`)
2. **Configurer HTTPS** (automatique sur Render)
3. **Ajouter Google Analytics** pour suivre l'utilisation
4. **Implémenter un système de cache** pour réduire les appels OpenAI
5. **Ajouter des tests automatisés** (CI/CD avec GitHub Actions)

---

Votre application est maintenant déployée et accessible publiquement ! 🎉
