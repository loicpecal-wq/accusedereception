# AR CHEMDOC — Proxy Backend

Serveur Node.js permettant la lecture automatique de PDF A/R fournisseurs
via l'API Anthropic, sans problème CORS.

## Architecture

```
Acheteur (navigateur)
  → dépose PDF sur index.html
  → appelle ce proxy (pas l'API Anthropic directement)
  → proxy appelle api.anthropic.com côté serveur
  → retourne les données extraites
  → met à jour Asana via MCP
```

## Déploiement sur Railway (5 minutes)

1. Créer un compte sur https://railway.app (gratuit)
2. New Project → Deploy from GitHub repo
   OU : glisser ce dossier sur https://railway.app/new
3. Railway détecte automatiquement Node.js et lance `npm start`
4. Dans l'onglet Settings → Domains : générer un domaine public
5. Copier l'URL (ex: https://ar-chemdoc-proxy.up.railway.app)
6. Dans l'interface HTML, cliquer sur "⚙ Proxy" en haut à droite
   et coller cette URL

## Déploiement local (test)

```bash
npm install
node server.js
# Serveur disponible sur http://localhost:3000
```

## Sécurité

- La clé API Anthropic est transmise par le navigateur dans le header
  `x-api-key` à chaque requête — elle n'est jamais stockée côté serveur
- Pour sécuriser davantage : stocker la clé dans une variable
  d'environnement Railway (ANTHROPIC_API_KEY) et supprimer le header
  côté frontend

## Routes API

- POST /api/extract-pdf    — lit un PDF et extrait les données A/R
- POST /api/search-asana   — cherche une tâche par N° commande CHEMDOC
- POST /api/update-asana   — met à jour le champ "Date de l'AR"
- GET  /health             — vérifie que le serveur est actif
