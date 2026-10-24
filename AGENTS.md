# AGENTS.md — dépôt `ALVEARE` (produit)

Ce dépôt porte le **code de production** (Core + 12 apps). La
connaissance vit dans le dépôt voisin `ALVEARETOP` (wiki) — voir
son `AGENTS.md` et [`wiki/pages/concepts/revue-criticite.md`](../../Documents/ALVEARETOP/wiki/pages/concepts/revue-criticite.md).

## Zones

- **Zone Red** (revue indépendante obligatoire, auteur ≠ réviseur,
  validation humaine finale) : tout ce qui touche auth/identité,
  paiements, données personnelles, consentement/partage inter-apps,
  permissions, migrations destructives, infra sensible.
- **Zone Green** : UI, contenu, protos jetables → revue standard.

## Conventions de commits

`feat:`, `fix:`, `chore:`, `docs:`, `test:` — même s'applique
au wiki : petit commit, adjectif à l'objectif.

## Secrets — non négociable

- `.env` et tout `*.env` local (sauf `.env.example`) sont
  **git-ignorés** ; ce sont les seuls endroits avec valeurs réelles.
- `infra/.env` (compose Keycloak) et `.env` racine (app) sont
  générés par `infra/mk-dotenv.sh` — jamais écrits à la main dans un
  fichier commité.
- En prod : Infisical (ADR-0002). Mots de passe de test locaux :
  générés par le script, jamais committés.
- Un hook pre-commit interdit doit protéger `.env` (voir `infra/`).

## Pas de protos oubliés

Les squelettes exécutables vite (E1 style inline, page d'accueil) ont
droite à une documentation : chaque livrable = page wiki + index log
(convention `ALVEARETOP`).

## Paquets

- pnpm workspace ; TypeScript strict partout (`tsconfig.base.json`).
- Contrats partagés : `@alveare/contracts` (Zod) — validation des
  entrées côté service ET côté front.
- Ports machine opérateur : les ports occupés sont **respectés**
  (la table des ports vit dans le wiki, page [[e1-scaffold-monorepo]]).
