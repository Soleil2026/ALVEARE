-- 001-outbox.sql — E3 audit : table outbox transactionnelle.
-- Zone Red (piste d'audit) — revue indépendante obligatoire (AGENTS.md).
--
-- Rôle : garantit la piste d'audit même si le drain BullMQ échoue.
-- Les émetteurs (identity / documents / notify) écrivent ici DANS leur
-- transaction métier ; le service audit :4030 transfère vers audit.events.
--
-- Idempotent : ré-exécution = no-op (IF NOT EXISTS partout).
-- Exécution : psql direct :5432 avec l'URI de la BD alveare_core
-- (ne JAMAIS passer par PgBouncer pour le DDL — ADR-0002 / plan E3 §3).

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.outbox (
  id         bigserial PRIMARY KEY,
  created_at timestamptz  NOT NULL DEFAULT now(),
  payload    jsonb        NOT NULL,
  delivered  boolean      NOT NULL DEFAULT false,
  attempts   int          NOT NULL DEFAULT 0
);

-- Index partiel pour le drain : les lignes livrées sortent de l'index,
-- il reste minuscule et oriente SELECT ... WHERE delivered = false.
CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON audit.outbox (delivered)
  WHERE NOT delivered;

-- NOTE (ré-execution) : les deux CREATE IF NOT EXISTS ne recreent ni la
-- table ni l'index ; aucune donnee n'est touchee par ce script.
