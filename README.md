# 🎯 Snipe Bot

Bot Discord avec la commande `!snipe` — liste et supprime les messages d'un utilisateur.

---

## 📋 Fonctionnement

| Commande | Description |
|---|---|
| `!snipe @user` | Liste tous les messages récents de l'utilisateur |
| `!snipe <userID>` | Même chose avec l'ID brut |

- Les résultats s'affichent en pages de 10 messages (salon, aperçu, lien direct)
- Boutons **◀ / ▶** pour naviguer entre les pages
- Bouton **🗑️ Tout supprimer** pour effacer tous les messages trouvés
- Les boutons expirent après **10 minutes**
- Commande réservée aux admins configurés dans `ADMIN_IDS`

> **Limite :** seuls les 100 derniers messages par salon sont scannés (limite de l'API Discord).

---

## 🚀 Déploiement sur Railway

### 1. Créer le bot Discord

1. Va sur [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → donne un nom
3. Onglet **Bot** → copie le **Token**
4. Active ces **Privileged Gateway Intents** :
   - ✅ **Message Content Intent**
   - ✅ **Server Members Intent**
5. **OAuth2 → URL Generator** → Scopes : `bot` → Permissions : `Send Messages`, `Read Message History`, `Manage Messages`, `Embed Links`
6. Invite le bot sur ton serveur avec l'URL générée

### 2. Récupérer ton ID Discord

Paramètres Discord → Avancé → **Mode développeur** activé  
→ Clic droit sur ton pseudo → **Copier l'identifiant**

### 3. Push sur GitHub

```bash
git init
git add .
git commit -m "init snipe bot"
git remote add origin https://github.com/TON_USER/TON_REPO.git
git push -u origin main
```

### 4. Déployer sur Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Sélectionne ton repo
3. Onglet **Variables**, ajoute :

| Variable | Valeur |
|---|---|
| `DISCORD_TOKEN` | Le token de ton bot |
| `ADMIN_IDS` | Ton ID Discord (plusieurs IDs séparés par des virgules) |

Railway détecte le `package.json` et lance `npm start` automatiquement ✅
