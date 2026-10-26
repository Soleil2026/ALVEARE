# Plan ADMIN-UI — Écran « Paiements » (lecture seule, web admin)

Auto-requêté par l'opérateur le 2026-10-26 après visa E6 (« je ne trouve
pas les paiements ») : E6 est une coupe backend conforme au plan (API
:4040/admin/payments, aucun écran prévu). Cette coupe ajoute la
**visibilité admin** — affichage uniquement, aucune action sur l'argent.

## 1. Scope

- Page `web/admin/app/paiements/page.tsx` — Server Component, même
  pattern que `/` : session JWE déchiffrée (decodeSession), appel du
  service paiements `GET /admin/payments` (env `PAYMENTS_URL`, défaut
  `http://localhost:4040`) avec `Authorization: Bearer session.at`.
- Filtres par `searchParams` : `app`, `status`, `limit` (recapté
  côté serveur, cap 200 aligné sur le service).
- Aucun bouton d'action (refund via UI = coupe distincte, zone Red ;
  hors scope assumé).
- Accueil `/` : lien « Paiements » dans la barre de section, visible
  si connecté.
- Les non-admins verront le message générique d'erreur du service
  (`403` mappé) — la garde reste AdminGuard au service (jamais
  dupliquée/confiée au front).

## 2. Choix (clés)

- Montants affichés en unités mineures formatées (séparateurs de
  milliers) + légende « montants en centimes » — pas de conversion
  flottante jamais (règle E6 D-9).
- Statut = pastille colorée : paid/partially_refunded/refunded,
  pending/created, expired distincts ; provider + rail affichés.
- Lecture directe côté serveur à chaque rendu (`cache: 'no-store'`,
  `dynamic = 'force-dynamic'`) — pas de cache ni de pagination locale
  en V1 (l'API fournit limit/filter).
- Timeout de crossing via `AbortSignal.timeout` (miroir D-1 E6).

## 3. Tâches

- U1.1 lib `lib/payments-admin.ts` : helpers purs (format d'affichage,
  libellé de statut, mapping d'erreur) — testables.
- U1.2 page + lien d'accueil ; U1.3 tests vitest des helpers
  (`tests/payments-format.test.ts`, style des tests existants).

## 4. Critères de fin

- Build + tests web/admin verts ; `next build` sans erreur.
- Manipulation : page /paiements rend la vraie liste (données e2e
  visibles), filtres app/status fonctionnels, non-connecté → reconnexion.
- Revue standard (zone Green, lecture seule), commit conventionnel.
- Fusible : rien sur l'argent au-delà de l'affichage ; aucun secret
  exposé côté client ; le token ne quitte jamais le serveur.

## 5. Risques pour la revue

- Fuite du token : tout fetch passe par le serveur (jamais le
  navigateur) — vérifier qu'aucun access token ne se logge.
- Injection des searchParams dans l'URL upstream : whitelist stricte
  (regex `^[a-zA-Z0-9-]{1,32}$` et digits pour limit).
- Échéance session : la page doit proposer « Se reconnecter », pas
  d'erreur obscure.
