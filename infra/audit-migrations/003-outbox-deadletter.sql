-- 003-outbox-deadletter.sql — E3 audit : quarantaine des lignes
-- réfractaires du outbox (correctif S-2 de la revue T3.8, zone Red).
--
-- Rôle : le drain (services/audit/src/drain.ts) re-tente une ligne en
-- échec au sweep suivant avec attempts++. Sans plafond, une ligne
-- empoisonnée (payload non conforme AuditEntry, par exemple) resterait
-- livrée pour toujours dans audit.outbox. Cette table reçoit ces
-- lignes : copiées TELLES QUEL (payload, attempts) avec une raison
-- lisible, puis supprimées du outbox — le drain redevient sain et la
-- trace reste disponible pour réparation humaine (runbook :
-- docs/ops-audit.md).
--
-- Idempotent : ré-exécution = no-op (IF NOT EXISTS).
-- Exécution : psql direct :5432 (jamais via PgBouncer pour le DDL).

CREATE TABLE IF NOT EXISTS audit.outbox_deadletter (
  -- id de la LIGNE OUTBOX source (pas une séquence : traçabilité
  -- 1:1 avec audit.outbox / audit.events au (outbox_id, at)).
  id             bigint,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  attempts       int         NOT NULL,
  payload        jsonb       NOT NULL,
  error          text        NOT NULL
);

-- NOTE (ré-exécution) : le CREATE IF NOT EXISTS ne recrée ni la table,
-- ni aucune donnée existante ; la quarantaine (« copie » d'une ligne)
-- n'arrive qu'au runtime du drain, jamais dans ce script.
