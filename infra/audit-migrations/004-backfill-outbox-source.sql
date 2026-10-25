-- 004-backfill-outbox-source.sql — E3 audit : replissage du lien de
-- déduplication outbox_source (correctif D-1 de la revue T3.8, zone
-- Red).
--
-- Rôle : depuis le correctif « tamponné à l'INSERT », toute nouvelle
-- ligne de audit.outbox porte payload.outbox_source = payload.id, lien
-- de déduplication 1:1 avec audit.events (unicité (outbox_id, at)).
-- Ce script aligne les lignes PLUS ANCIENNES (posées avant le
-- correctif) pour que le runbook/e2e n'observe qu'un seul format.
--
-- Idempotent : le filtre payload->'outbox_source' IS NULL ne retouche
-- jamais une ligne déjà estampillée.
-- Exécution : psql direct :5432 (jamais via PgBouncer pour le DDL).

BEGIN;

UPDATE audit.outbox
SET payload = jsonb_set(payload, '{outbox_source}', to_jsonb(id))
WHERE payload->'outbox_source' IS NULL;

-- Contrôle : s'il reste des lignes sans outbox_source (théoriquement
-- impossible après l'UPDATE ci-dessus), le script échoue — avis à
-- l'opérateur ; l'alignement ne peut pas passer à moitié inaperçu.
DO $ctrl$
DECLARE
  restes bigint;
BEGIN
  SELECT count(*) INTO restes
    FROM audit.outbox WHERE payload->'outbox_source' IS NULL;
  IF restes <> 0 THEN
    RAISE EXCEPTION
      'backfill outbox_source : % ligne(s) encore sans outbox_source', restes;
  END IF;
END
$ctrl$;

COMMIT;
