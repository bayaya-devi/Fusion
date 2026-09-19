# Fusion

Fusion est un chatbot web gratuit, financé par des emplacements publicitaires discrets. Cette première version comprend :

- comptes avec inscription, connexion, confirmation d'e-mail et renvoi du lien ;
- gestion du profil et suppression du compte ;
- création, lecture, renommage et suppression des conversations ;
- génération de réponses avec Cloudflare Workers AI ;
- Cloudflare D1 pour les données, et Resend pour les e-mails transactionnels.

## Démarrage local

```bash
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Sans clé Resend en développement, l'API retourne un lien de confirmation de test. En production, configurez les secrets et un expéditeur Resend vérifié :

```bash
npx wrangler d1 create fusion-db --binding DB --update-config
npx wrangler d1 migrations apply fusion-db --remote
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

Ne placez jamais la clé Resend dans `wrangler.jsonc` ni dans Git. Remplacez également `EMAIL_FROM` par une adresse provenant d'un domaine vérifié dans Resend avant le déploiement public.

## GitHub

Après connexion à GitHub CLI :

```bash
git add .
git commit -m "feat: initial Fusion chatbot"
gh repo create fusion-chatbot --public --source=. --push
```

## Coûts

Cloudflare Workers AI et l'envoi d'e-mails ne peuvent pas être garantis sans frais à trafic illimité. Le code est prêt pour ces services, mais il faut surveiller leurs quotas et coûts avant une ouverture massive au public.
