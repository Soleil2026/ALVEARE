# PLAN E5 — Notifications (service `notify`, V1 minimal)

Date : 2026-10-24 · Auteur : orchestrateur (GLM) · Statut : **proposé — validation opérateur attendue**
Référence PRD : `wiki/pages/core/PRD-alveare-core-v1.md` → section « E5 — Notifications » (FR-05.1, FR-05.2) ; conventions de chantier : E2/E4 (NestJS, Zod, audit minimal, `packages/auth`).

## 0. Périmètre du PRD (non négociable)

- **FR-05.1** Email transactionnel (adaptateur SMTP) + SMS via
  **adaptateur à interface configurable** (opérateur local ; pas de
  fournisseur tiers en V1).
- **FR-05.2** Templates i18n **FR / AR (RTL) / EN** par type.
- Non-goals : pas de bus d'événements réel, pas de WhatsApp/push.

## 1. Architecture (suivre E2/E4 à l'identique)

- `services/notify` — NestJS Fastify, port **4020**, `/healthz`
  (setup identique aux 2 services existants).
- **Postgres** : table `notifications`
  (`id uuid, channel email|sms, template text, lang text, recipientHash
  hex16, recipientCipher JWE, status queued|sent|failed, error text,
  sentAt, createdAt`) — l'adresse (email/téléphone) est stockée
  **chiffrée** (même session-key pattern que web-admin : clé
  `NOTIFY_DATA_KEY` hex), et en clair **jamais en log**.
- Auth : `packages/auth` RS256 (JWT Keycloak), scope `notify:send`
  délégué par rôle user/admin ; IdP jamais contourné.

## 2. API

- `POST /send` : `{ channel, template, lang, to, params?, dedupKey? }`
  → `202 { id }` (asynchrone léger : envoi à la suite de l'écriture).
  - Validation stricte : email RFC-lite ou téléphone **E.164** ;
    `lang ∈ {fr, ar, en}` ; template whitelist.
  - **dedupKey** idempotent (contrainte unique) → anti-double envoi.
  - **Anti-flood** : cap 5 messages / destinataire / minute (Redis
    déjà up) → `429`.
- `GET /notifications/:id` (statut du message — hash du destinataire
  seulement, jamais l'adresse).
- Audit minimal : entrée par envoi (type, statut, hash).

## 3. Adaptateurs

- **email** : `nodemailer` — `SMTP_URL` env si fournie, sinon
  fallback dev `jsonTransport` (le message complet atterrit dans
  `NOTIFY_DEV_OUTBOX` = fichier `/tmp/alv-notify-outbox.jsonl`).
- **sms** : interface `SmsProvider { send(to, text): Promise<{ok}> }`
  avec implémentation `dev` (append à l'outbox, tampon [SMS]) ;
  le réel branchera une interface opérateur local plus tard (§7 PRD).
- **Templates** : `templates/<template>/<lang>.json` réveillés au
  démarrage ; HTML email pour `ar` porte `dir="rtl" lang="ar"`.
  Types V1 : `verify-email`, `password-reset`, `document-shared`,
  `test`.
- Vérification au démarrage : chaque template DOIT exister en
  fr+ar+en (sinon démarrage refusé — aucun template manquant
  silencieux).

## 4. Tests & e2e

- Unitaires : validation (400), i18n complet (aucun fallback),
  RTL ar (assertion `dir="rtl"`), dedupKey idempotent, anti-flood 429,
  écriture de l'outbox email, interface SMS dev.
- `scripts/e2e-notify.sh` (10 preuves, style e2e-documents) :
  healthz → send email langue fr → outbox écrite → variantes ar
  (RTL) et en → dedupKey refusé un 2e envoi → SMS dev → 429
  anti-flood → audit traces → GET statut.
- `pnpm build` + `pnpm test` verts sur le workspace.

## 5. Contraintes zone Red (données personnelles)

- Adresse destinataire : chiffrée au repos + hash pour indexation ;
  **aucun corps d'email ni adresse jamais en log** (grep-lint).
- Consentement : en V1, les envois sont **invoqués par les apps** —
  chaque `POST /send` porte un `via` (app appelante) tracé à l'audit ;
  la gestion du consentement utilisateur (opt-in par canal) est pour
  un ADR dédié au besoin — hors V1 (les seuls émetteurs V1 = Identity
  compte + Documents partage).
- Secrets : `NOTIFY_DATA_KEY`, `SMTP_URL` uniquement via env (jamais
  dans le code ; `.env` local git-ignoré).

## 6. Ordre des travaux (chacun sage et composable)

1. **S1 scaffold + table** (migration, healthz, auth RS256) — ~1 session.
2. **S2 API /send + validation + PII chiffré + audit**.
3. **S3 adaptateurs email/SMS + templates i18n×3 + démarrage strict**.
4. **S4 tests unitaires + e2e-notify.sh**.
5. **S5** revue indépendante (zone Red) → remédiation → commit →
   page wiki `e5-notifications-livraison` + index + log.

## 7. Écrit wiki prévue

Plan : `ALVEARE/docs/plans/E5-NOTIFY-PLAN.md` (ce fichier) ; à chaque
phase E5-NOTIFY plan ; à la livraison `wiki/pages/core/e5-notifications-livraison.md`.

## 8. Décisions à valider par l'opérateur

- [ ] Port 4020 pour notify (convention :4000/:4010 suivie).
- [ ] Cap anti-flood : 5/destinataire/minute acceptable ?
- [ ] Templates V1 : les 4 types ci-dessus suffisent ?
- [ ] Destinataires chiffrés au repos (JWE) : OK ?
- [ ] SMS : adaptateur local dev suffisant pour V1 (pas de fournisseur
  réel) ?
