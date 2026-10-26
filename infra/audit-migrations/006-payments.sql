-- 006-payments.sql — E6 service Paiements (zone Red : argent).
-- Source de vérité : docs/plans/E6-PAIEMENTS-PLAN.md §3 (copie conforme).
--
-- Rôle : état des transactions/reçus/remboursements + endpoints webhook
-- par app + quarantaine des livraisons webhook définitivement échouées
-- (payments.webhook_dead, miroir audit.outbox_deadletter).
--
-- Convention : SQL 100% DDL déclaratif, aucune donnée métier ici ;
-- les secrets (app_endpoints.secret) sont posés au runtime via psql
-- DEV — jamais versionnés.
--
-- Idempotent : ré-exécution = no-op (IF NOT EXISTS partout).
-- Exécution : psql direct :5432, JAMAIS via PgBouncer :6432 (DDL),
-- cf. e2e-audit.sh pour l'extraction DATABASE_URL depuis .env.

CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE IF NOT EXISTS payments.app_endpoints (
  app       text PRIMARY KEY,           -- 'app-01'…, pattern APP
  url       text NOT NULL,
  secret    text NOT NULL,              -- jamais loggé
  enabled   boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS payments.transactions (
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
CREATE INDEX IF NOT EXISTS transactions_pending_idx
  ON payments.transactions (created_at)
  WHERE status = 'pending';             -- sweep expiry / reconciliation

CREATE TABLE IF NOT EXISTS payments.refunds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_id      uuid NOT NULL REFERENCES payments.transactions(id),
  refund_ref  text NOT NULL,          -- clé d'idempotence de l'app
  amount      bigint NOT NULL CHECK (amount > 0),   -- partiel ou total
  reason      text,
  provider_ref text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Clause du plan : refus/remboursement rejoué = une seule ligne.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_idem_idx
  ON payments.refunds (txn_id, refund_ref);

CREATE TABLE IF NOT EXISTS payments.webhook_dead (    -- miroir audit.outbox_deadletter
  payload      jsonb NOT NULL,
  error        text NOT NULL,
  attempts     int NOT NULL,
  dead_at      timestamptz NOT NULL DEFAULT now()
);

-- NOTE (ré-exécution) : les IF NOT EXISTS ne recréent ni les tables ni
-- les index ; aucune donnée n'est touchée par ce script.
