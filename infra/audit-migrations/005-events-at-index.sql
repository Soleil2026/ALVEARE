-- 005-events-at-index.sql — E3 audit : index pour la lecture admin
-- FR-03.3 (correctif D-3 de la revue T3.8, zone Red).
--
-- Rôle : GET /admin/audit :4030 trie systématiquement
--   ORDER BY at DESC, id DESC          (pagination par curseur at|id)
-- et filtre souvent sur la fenêtre from/to (bornes `at`). Sans index
-- dédié, chaque page pagine par tri sur toute la table partitionnée.
-- Le nommage suit la convention 002 (events_actor_idx, events_action_idx).
--
-- Idempotent : ré-exécution = no-op (IF NOT EXISTS).
-- Exécution : psql direct :5432 (jamais via PgBouncer pour le DDL).
-- L'index est parent sur la table partitionnée : chaque partition
-- nouvellement créée le réplique automatiquement.

CREATE INDEX IF NOT EXISTS events_at_idx
  ON audit.events (at DESC, id DESC);
