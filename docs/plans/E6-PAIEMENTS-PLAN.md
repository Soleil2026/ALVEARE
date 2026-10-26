# Plan E6 — Integrations : service Paiements (adapters CIB/Edahabia)

> **Statut : T4.0 VALIDÉ (2026-10-25)** — 9 gates tranchées par
> l'opérateur (voir §1 et `docs/research/E6-PAIEMENTS-RESEARCH.md §4`).
> **Zone Red** (argent, transactions, réglementaire) — revue
> indépendante obligatoire (auteur ≠ réviseur), plan §3 de AGENTS.md.
> Exécution : worktree dédié après « ok todos » de l'opérateur sur ce
> plan (convention plan commité sur main d'abord).

## 1. Objectif et base PRD

Brique **ALVEARE Integrations** du PRD Core V1 : « adapters paiements »
— CIB/Edahabia = points d'entrée du service Paiements. Fonctions
minimales (B l.558) : transactions, reçus, remboursements,
rapprochement, journalisation. Non-goals V1 : cartographie, livraison,
facture numérotée complète (V2), CRM (hors Core).

Décision de rail (T4.0 Q1) : **architecture multi-adapters**, V1 code
sur deux adapters :

- `dev` — simulation pure (JSONL, zéro réseau), moteur des tests/e2e ;
- `chargily` — **Chargily Pay v2** (sandbox gratuite immédiate, checkout
  hosted, webhooks signés HMAC-SHA256) ;
- `satim` — homologation directe SATIM : **V2** (spécífication +
  checklist certification en annexe runbook, aucun code V1).

## 2. Choix de conception (clés)

1. **Un seul webmarchand au Core** (Q7) : chaque transaction porte
   `app` (metadata PSP / `udf1` SATIM en V2) → routage du webhook vers
   l'app propriétaire via la table `payments.app_endpoints`.
2. **Source de vérité serveur** : la page retour et le webhoook PSP ne
   sont que des signaux ; l'état vient du sweep de réconciliation
   (`fetchStatus` de l'adapter) — pattern rendu obligatoire par le R2
   SATIM (aucun webhook côté SATIM) et conservé pour le PSP.
3. **État-machine stricte** (Q6) : `created → pending → paid | failed |
   expired`, `paid → partially_refunded → refunded` ; transitions
   illégales refusées en code (409) ; états terminaux immuables.
   Auto-expiry : `pending` > 20 min → `expired` (miroir de l'auto-cancel
   SATIM).
4. **Journalisation = héritage E3** : chaque transition emit
   `payment.*` dans `audit.outbox` via `auditOutbox()` **dans la
   transaction métier** de la mutation ; statuts `PAYMENT_*` versionnés
   dans `@alveare/contracts` (B l.472-478 : nom stable, id unique,
   idempotent).
5. **Webhooks sortants** (Q4) : queue BullMQ `payments-webhooks-out`
   (retries/backoff exponentiel, DLQ `payments-webhooks-dead`),
   signature `X-ALVEARE-Signature: t=<ts>, v1=<hmac-sha256(body+ts)>`
   avec secret **par app** ; l'app répond 200 (accusé) ; GET
   `/payments/:id` = réconciliation de rattrapage.
6. **Idempotence partout** : create (unique `(app, app_ref)`), webhook
   entrant (unique `(provider, provider_event_id)`), refund (unique
   `(txn_id, refund_ref)`).

## 3. Schéma de données (migration `006-payments.sql`)

```sql
CREATE SCHEMA payments;

CREATE TABLE payments.app_endpoints (
  app       text PRIMARY KEY,           -- 'app-01'…, pattern APP
  url       text NOT NULL,
  secret    text NOT NULL,              -- jamais loggé
  enabled   boolean NOT NULL DEFAULT true
);

CREATE TABLE payments.transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app           text NOT NULL,
  app_ref       text NOT NULL,          -- référence métier de l'app
  status        text NOT NULL DEFAULT 'created',   -- §2.3
  amount        bigint NOT NULL CHECK (amount >= 100),  -- centimes
  currency      text NOT NULL DEFAULT 'DZD',
  rail          text NOT NULL DEFAULT 'dzd',  -- 'dzd' | 'fx' (Q8)
  just_ref      text,                   -- justificatif change (Q8)
  provider      text NOT NULL,          -- 'dev' | 'chargily' | 'satim'
  provider_ref  text,
  event_uid     text UNIQUE,            -- id webhook entrant
  receipt_ref   text,                   -- reçu minimal (Q5)
  fee_amount    bigint,                 -- tracé (R5)
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz,
  closed_at     timestamptz,            -- paid/refund/refusé
  UNIQUE (app, app_ref)                 -- idempotence create (§2.6)
);
CREATE INDEX transactions_pending_idx
  ON payments.transactions (created_at)
  WHERE status = 'pending';             -- sweep expiry / reconciliation

CREATE TABLE payments.refunds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_id      uuid NOT NULL REFERENCES payments.transactions(id),
  refund_ref  text NOT NULL,          -- clé d'idempotence de l'app
  amount      bigint NOT NULL CHECK (amount > 0),   -- partiel ou total
  reason      text,
  provider_ref text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refunds_idem_idx ON payments.refunds (txn_id, refund_ref);

CREATE TABLE payments.webhook_dead (    -- miroir audit.outbox_deadletter
  payload      jsonb NOT NULL,
  error        text NOT NULL,
  attempts     int NOT NULL,
  dead_at      timestamptz NOT NULL DEFAULT now()
);
```

## 4. Service `services/payments` (:4040)

- `PAYMENTS_PROVIDER=dev|chargily` en env (fabrique d'adapter, **boot
  refusé** si valeur inconnue — pattern `services/notify/src/sms.ts`).
- Endpoints (auth `@alveare/auth`, azp scoping app via `APP_PATTERN`) :
  - `POST /payments` — création (payload `PaymentCreateSchema`),
    idempotent, retourne redirect URL de l'adapter ;
  - `GET /payments/:id` — app propriétaire **ou** admin ;
  - `POST /payments/:id/refund` — montant ≤ montant payé
    (`amount - refunded`), idempotent (Q9) ;
  - `POST /payments/webhook` — point d'entrée PSP (signature HMAC
    re-vérifiée, idempotent par `event_uid`), aucun secret loggé ;
  - `GET /admin/payments` — lecture admin filtrée (miroir FR-03.3);
  - `GET /healthz`.
- Sweeps (gabarit worker E3 : Redis ping strict, close propre) :
  - **expiry/reconciliation 30–60 s** : `fetchStatus` sur `pending` ;
    watchdog « pending > N min sans signal ni statut » → `console.error`
    structuré (à suivre : alerting) ;
  - **webhook publisher** : job par livraison, retries, plafond de
    tentatives → `payments.webhook_dead` + alerte (pattern E3 S-2).
- Adapter `dev` : `fetchStatus` simulé par un POST de test interne e2e
  (`__dev_confirm`), outbox JSONL pour l'audit, zéro réseau.

## 5. Adapters

Interface commune (dans `packages/contracts`-adjacent ou
`packages/payments`) :

```
PaymentProvider {
  createCheckout(txn) → { redirectUrl, providerRef }
  fetchStatus(providerRef) → { status, paidAt?, fee? }
  refund(providerRef, amount) → { providerRef }
}
```

- **dev** : simulation déterministe (confirm/refus/expiry par payload).
- **chargily** : REST v2, checkout hosted (Q2), vérification HMAC des
  webhooks, CIB + Edahabia (Q3) ; **sandbox par défaut**, live requiert
  le KYB fait par l'opérateur (R6, hors code).
- **satim (V2)** : spécification d'essais (`test2.satim.dz`) + checklist
  certification CAPTCHA/n°3020/scénarios cartes en annexe runbook.

## 6. Tâches

- **T4.1** Contrats + migration 006 (schéma §3, statuts PAYMENT_* dans
  `@alveare/contracts`, tests) ;
- **T4.2** Adapter layer : interface + `dev` + `chargily` + fabrique ;
- **T4.3** Service :4040 : POST/GET/refund + state machine + sweeps
  expiry + auditOutbox sur chaque transition + guards ;
- **T4.4** Webhooks sortants signés : queue, retries, DLQ
  `webhook_dead`, secret par app, GET réconciliation;
- **T4.5** Fiche `docs/research` §2-§5 → **runbook** `docs/ops-payments.md`
  (adapters, secrets, dossier SATIM V2, checklist certification) ;
- **T4.6** e2e `scripts/e2e-payments.sh` (adapter dev : create → confirm
  → webhook app factice vérifié signé → refund partiel → idempotence
  double POST → expiry sweep → traces audit → 401/403 admin) ;
- **T4.7** Revue indépendante zone Red (réviseur distinct, auteur ≠
  réviseur) ;
- **T4.8** Livraison wiki + visa opérateur.

## 7. Ordonnancement

T4.1 → (T4.2 ∥ T4.3) → T4.4 → T4.5 → T4.6 → T4.7 → T4.8.

Prérequis **opérateur** (hors code, chemin critique R6) : dossier
CIBweb pour SATIM V2 ; compte Chargily business + KYB pour le **live**
(le code se développe et se teste sur sandbox/dev sans attendre).

## 8. Risques pour la revue

R1 réglementaire FX (champs Q8 dès V1) ; R2 pas de webhook SATIM
(réconciliation serveur-first) ; R3 coût serveur test SATIM (dev
adapter first) ; R4 checklist certification ; R5 dépendance PSP (frais
tracés, multi-adapters) ; R6 dossier administratif opérateur ; R7
international = BDL-intl V2 (schéma prêt dès V1). Détail + sources :
`docs/research/E6-PAIEMENTS-RESEARCH.md §5`.

## 9. Critères de fin (checklist de livraison)

- [ ] Migration 006 appliquée (dev), statuts versionnés, tests verts ;
- [ ] `PAYMENTS_PROVIDER=dev` e2e OK — **N preuves numérotées** ;
- [ ] `chargily` adapter vérifié sur **sandbox** (create/confirm/refund)
      sans secret live ;
- [ ] Webhook app factice : signature vérifiée, double-livraison
      idempotente, DLQ peuplée côté re-test ;
- [ ] Traces `payment.*` dans `audit.events` après drain (sync E3) ;
- [ ] Revue indépendante sans bloquant + corrections commitées ;
- [ ] `docs/ops-payments.md` + wiki livraison + visa.

## 10. Déviations acceptées

(miroir E3 §10 — décisions prises hors de ce plan pendant l'exécution
et la revue T4.7 ; gates votées par l'opérateur le 2026-10-26.)

### Gates produit (Q-A / Q-B)

- Q-A / D-7 : `POST /payments/:id/refund` est réservé aux admins Core
  (admin realm ou grant core-admin). Un grant simple d'app ne suffit
  plus (garde AdminGuard, commit d3c8773, preuve e2e P5 avec le 403).
- Q-B : statuts terminaux immuables, confirmé. Un `expired` qui reçoit
  un webhook PSP tardif `paid` ne débouche sur rien en V1 (interdit) :
  l'app crée un nouveau paiement (app_ref neuf) et l'ancien reste pour
  l'audit. Une réouverture de machine à états serait à reconsidérer
  en V2, ENUM et preuve anti-doublon repensées.

### Correctifs de la revue T4.7 (aucun bloquant, lot D-1..D-13)

- D-1 : délai réseau PAYMENTS_HTTP_TIMEOUT_MS (10 s par défaut) sur
  les appels chargily ET le webhook sortant.
- D-2 : un `created` sans provider_ref est repris au prochain POST
  create (resume) ; en cas de nouvel échec il passe `failed`.
- D-3 : violation d'unicité event_uid (pg 23505) renvoyée en 409
  structuré.
- D-5 / D-8 : échec de signature sortante routé dans
  onDeliveryFailure (DLQ au cap) ; lockDuration 120 s sur le worker.
- D-6 : PAYMENTS_PROVIDER absent = boot refusé en production ; repli
  `dev` loggé WARN hors production.
- D-9 : garde 15 chiffres max sur le montant (contrats + adapters,
  pas de Number() hors garde) ; le test ancien qui acceptait
  17 chiffres a été inversé au contrat.
- D-10 : l'adapter dev porte fee_amount = 500 sur `paid`, avec
  assertion en preuve e2e.
- D-11 / D-13 : artefact CJK supprimé (zéro restant au scan) ;
  commentaire dev-checkout exact (affiche le statut, garde e2eGate).

### Résiduels assumés en V1 (documentés runbook §2.1)

- L'appel PSP du refund reste DANS la transaction BD. Fenêtre de
  crash entre débit PSP et commit : rattrapage opérateur par ré-appel
  avec le même refund_ref (idempotent).
- Signature webhook entrante du PSP vérifiée sur le corps seul, sans
  fenêtre anti-replay : la protection réelle est l'idempotence
  event_uid plus les statuts terminaux immuables.
- Aucune purge SQL : la régularisation passe par un nouveau paiement
  tracé (cf. Q-B).
