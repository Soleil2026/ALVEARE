# Plan F — Raccord front (web-admin ↔ OIDC Keycloak)

Statut : **validé par l'opérateur** (« raccord front », 2026-10-24 —
suit ma proposition après l'E4). **Zone Red** (login visible) →
revue indépendante (F5) + visa final de l'opérateur (F6).

## Objectif

Première boucle complète : un humain se connecte au backoffice
(:3001) via Keycloak realm `alveare`, voit son profil **+ les rôles
EFFECTIFS par app** (via identity `/me`), liste et dépose ses
documents (via documents :4010) — en un seul parcours avec cookies.

## Décisions

1. **Authorization Code + PKCE**, client public `web-admin` (créé
   en E2, redirect `http://localhost:3001/callback` déjà réglé).
2. **Session cookie chiffrée** (JWE A256GCM, clé `SESSION_KEY`
   hex-64 du `.env`, régénérable) — le token n'est jamais lisible
   côté navigateur.
3. Le front frappe les services **en server-side** (page serveur +
   proxy `/api/documents`) — jamais de token dans du JS client.
4. `/verify/:id` QR reste public par design (E4).
5. V1 assumé : refresh-token tenté sur la route proxy si 401 ;
   si échec → « session expirée, reconnectez-vous ». Polissage
   (silent refresh, middleware) → backlog.

## Tâches

- **F1** Env : `SESSION_KEY` + URLs internes (`IDENTITY_URL`,
  `DOCUMENTS_URL`, `REDIRECT_URI`) — root `.env`, web-admin
  `.env.local` régénérable via `mk-dotenv.sh`.
- **F2** `lib/oidc.ts` (PKCE RFC 7636, state/nonce, authorize URL,
  échange de code) + `lib/session.ts` (JWE, cookies httpOnly).
- **F3** Routes `/login`, `/callback`, `/logout`.
- **F4** Page `/` : profil + rôles effectifs + documents (table) +
  upload (client form → proxy `/api/documents`).
- **F5** Tests unitaires (JWE round-trip et refus de cookie
  falsifié, PKCE vecteur RFC) + **e2e script** `scripts/e2e-front.sh`
  (flux code complet en curl : login → callback → cookie → page/user
  → upload → logout) puis **revue indépendante** → remédiation.
- **F6** Wiki livraison + visa final opérateur.
