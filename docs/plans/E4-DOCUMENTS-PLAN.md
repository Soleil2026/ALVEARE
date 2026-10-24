# Plan E4 — Documents minimal (ALVEARE Core)

Statut : **proposé** — validation de l'opérateur requise avant
exécution. **Zone Red** (données personnelles : fichiers des
utilisateurs → revue indépendante obligatoire + accord humain final,
même protocole que l'E2).

## Objectif

FR-04.x du [[PRD-alveare-core-v1]] : upload + versions simplifiées,
validation des fichiers, partage par **URL temporaire signée**, QR de
vérification, audit complet. Basé sur ce qui tourne déjà : Keycloak
(realm alveare), la protection OIDC éprouvée en E2 (`token.ts`),
l'audit sync, la BD `alveare_core`.

## Périmètre V1 (minimal qui prouve la brique entière)

Élément | V1 | Report V2
--- | --- | ---
Upload fichier | ✅ mime + taille + sha256 | multi-fichiers
Versions du fichier | ❌ (1 version par doc V1) | V2 + OCR/signature
Liste/retrouver | ✅ mes documents | recherche full-text
Partage consenté | ✅ URL signée TTL + consentement tracé | permissions fines par destinataire
QR de vérification | ✅ endpoint QR (SVG) du lien de vérification | page web vérif
Stockage | ✅ **Système de fichiers local** (dossier git-ignoré, `DATA_DIR`) | S3-compatible (ADR à l'infra prod)

## Décisions

1. **Service séparé** `services/documents` (NestJS, port **4010**) —
   un backend par brique comme l'identité ; il validera les tokens
   via le MÊME code de confiance : le module `src/token.ts` est
   **extrait en `packages/contracts` → nouveau module `@alveare/auth`**
   consommé par les deux services (fini la copie ; une seule source).
2. **Stockage local V1** : `ALVEARE/data/documents/` (git-ignoré,
   chmod 600) — propriétaire = le service (rôle min-privilege).
3. **BD** : schéma `documents` de `alveare_core` — tables `documents`
   (sha256, mime, taille, proprietaire = sub/keycloak, audit lié) et
   `share_tokens` (jti, doc, cible, exp, révoqué).
4. **URL signée** : HMAC du service (secret `.env`, rotation par
   `DATA_SIGN_KEY`) → `GET /documents/:id/content?t=<token>` →
   200 stream si signature + TTL + jti non-révoqué valides.
5. **Consentement** : chaque partage écrit une entrée `audit.events`
   + une ligne `share_tokens` (révocable). Le registry des
   consentements reste tenu par le service identity — documents pose
   sa propre trace ; l'app consommante finale négociera via l'API.
   Simplification assumée et documentée.
6. **Validators upload** : allowlist mime (pdf/png/jpeg/csv/xlsx),
   limite 10 Mo (env `MAX_UPLOAD_MB`), détection magic bytes
   (`file-type`), nom nettoyé (pas de path traversal).
7. **QR** : bibliothèque `qrcode` → SVG ; l'URL encodée = lien de
   vérification public `GET /verify/:id?t=<token>` renvoie le statut
   du document (hash + émetteur + date) — vérifiable sans login.

## Tâches

- **T4.0** Validation du plan par l'opérateur (cette page) — gate zone Red.
- **T4.1** Extraction `@alveare/auth` (token.ts → packages/auth + tests
  qui suivent) pour mutualisation identity/documents.
- **T4.2** BD : migrations Prisma schéma `documents` (+ rôle grants).
- **T4.3** Scaffold `services/documents` (NestJS :4010, healthz public).
- **T4.4** Upload + validators + sha256 + stockage local.
- **T4.5** Partage : URL signée TTL + révocation ; QR de vérification.
- **T4.6** Tests unitaires (validators, HMAC TTL, révoques) + e2e
  script `scripts/e2e-documents.sh` (upload → partage → téléchargé →
  vérifié → révoqué → téléchargé refusé).
- **T4.7** Revue indépendante (même grille Red) → remédiation.
- **T4.8** Livraison wiki ([[e4-documents-livraison]]) + validation
  finale opérateur.

## Ordonnancement

T4.0 → T4.1 → T4.2/T4.3 → T4.4 → T4.5 → T4.6 → T4.7 → T4.8.

## Critères de fin

- [ ] `pnpm dev:documents` : service 4010 + `/healthz`
- [ ] upload d'un PDF de test → sha256 en BD + fichier stocké
- [ ] partage → URL signée → téléchargement OK ; après révocation → 401
- [ ] QR SVG généré et vérfifiable (le lien verifier JSON)
- [ ] tout partage/révocation/upload/delete = entrée audit
- [ ] tests verts (unitaires) + e2e vert + revue indépendante signée
- [ ] accord final de l'opérateur (gate humain)
