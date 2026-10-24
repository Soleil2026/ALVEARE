# Plan E2 — Identité (ALVEARE Core)

Statut : **proposé** — validation de l'opérateur requise avant
exécution (zone **Red** : auth/identité → revue indépendante
obligatoire, auteur ≠ réviseur, validation humaine finale —
[[revue-criticite]]).

## Objectif

La brique Identité du PRD (FR-02.1 → FR-02.6) opérationnelle en local :
Keycloak configuré **de façon reproductible** (fichiers, pas clics),
le service `@alveare/identity` protégé par OIDC/JWT, le registre des
consentements en base, le MFA admin — avec preuve par tests.
Voir [[PRD-alveare-core-v1]] (E2) et le référentiel B §4.2/§4.3.

## Principes qui gouvernent ce plan

1. **Keycloak as-code** : le realm ALVEARE est défini dans un JSON
   versionné (`infra/keycloak/realm-alveare.json`) importé au
   démarrage — un clone du dépôt + compose = environnement identique.
2. **Aucun secret dans le code** : `.env.example` explicite, `.env`
   local git-ignoré (généré une fois au setup), Infisical arrivera
   pour la prod (ADR-0002).
3. **Validation JWT** : bibliothèque `jose` (validation JWKS standard
   OIDC) — pas l'ancien `keycloak-connect` de NestJS (adaptateur
   déprécié ; pratiques courantes 2026).
4. **Un compte global ≠ accès automatique** (B §2.4) : les rôles
   admin/gestionnaire/utilisateur existent au realm SEPARATEMENT de
   l'attribution par application (`role_grants` en BD).

## Tâches

### T2.0 — `AGENTS.md` du dépôt code

Conventions du dépôt `ALVEARE` : messages de commit `feat:` / `fix:` /
`chore:`, renvoi vers [[revue-criticite]] pour les zones Red, `.env`
interdit de commit, garde-fous pre-commit anti-secrets.

### T2.1 — Realm « alveare » as-code

- `infra/keycloak/realm-alveare.json` : realm `alveare`, rôles realm
  `admin | gestionnaire | utilisateur`, clients :
  - `web-admin` (client OIDC confidentiel, URLs locales :3001),
  - `identity-api` (vérification bearer — le service validation des
    JWT du realm),
  - 2 utilisateurs de test (`admin@dev.local`, `user@dev.local`) avec
    des mots de passe générés localement venir de `.env` (jamais dans
    le JSON versionné)
- import via `--import-realm` au démarrage du compose Keycloak.

### T2.2 — Base du socle (BD `alveare_core`)

- BD Postgres locale `alveare_core` (schémas : `identity`, `audit`)
  + rôle applicatif `alveare_core_app` (min-privilege).
- Prisma dans `services/identity` : tables `role_grants`
  (rôle × application × utilisateur — B §2.4) et `consents`
  (utilisateur, app consommatrice, périmètre, date, révocation).
- Migrations versionnées ; preuve : `prisma migrate dev` verte.

### T2.3 — Protection OIDC du service identity

- `/me` : JWT validé (signature JWKS Keycloak, `iss`, `aud`, `exp`),
  réponse = qui + rôles effectifs.
- `/admin/role-grants` : **admin de l'app** uniquement (guard par
  rôle-par-app), entrée validée par `@alveare/contracts`.
- `/healthz` reste public (convention standard, aucun secret).
- Guard NestJS `RoleGuard` commenté ligne par ligne (revue exigée).

### T2.4 — Tests de sécurité (filet de la zone Red)

- Guard : sans token → 401 ; token sans rôle app → 403 ; admin de
  l'app → 200.
- Consentement : accord / retrait = écriture BD + entrée audit.
- Script e2e curl sur les 3 endpoints (public / utilisateur / admin)
  → branché au CI dès que le remote GitHub existe.

### T2.5 — MFA admin (FR-02.4)

- Policy OTP exigée pour les utilisateurs à rôle `admin` (config
  realm as-code) ; test : admin sans OTP → refusé, utilisateur normal
  sans OTP → fonctionne.

### T2.6 — Audit minimal (FR-03.1/03.2, en filigrane de l'E2)

- Table `audit_events` (schéma `audit`). L'écriture asynchrone BullMQ
  complète reste l'E3 — ici seulement l'écriture synchronisée de la
  trace, assumée.

### T2.7 — Revue indépendante (gate de la zone Red)

- Réviseur ≠ auteur (grille de [[revue-criticite]]) + validation
  finale de l'opérateur avant le commit de clôture, mise à jour wiki
  (page + index + log) et « état » du chantier.

## Ordonnancement

T2.0 → T2.1 → T2.2 (en parallèle partiel possible) → T2.3 + T2.4 →
T2.5 → T2.6 → T2.7.

## Critères de fin (tous vérifiés par preuve)

- [ ] `docker compose up` depuis zéro = environnement identité fonctionnel
- [ ] `/me` : JWT valide → 200 · sans token → 401 · token sans rôle
      app → 403
- [ ] MFA admin exigé (OTP) ; utilisateur classique sans OTP fonctionne
- [ ] consentement : accord / retrait tracés en BD + audit
- [ ] `pnpm test` vert · revue indépendante signée · accord opérateur
      avant commit final
