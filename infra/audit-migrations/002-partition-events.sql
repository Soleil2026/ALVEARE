-- 002-partition-events.sql — E3 audit : conversion de audit.events en
-- table partitionnee RANGE mensuelle sur « at ». Zone Red — revue
-- independante obligatoire (AGENTS.md).
--
-- Garanties :
--   * idempotent : si audit.events est deja partitionnee (relkind 'p'),
--     re-execution = no-op (aucune ecriture) ;
--   * retour arriere conserve : la table d'origine est renommee
--     audit.events_bak_done (JAMAIS dropee : le drop est une decision
--     de nettoyage distincte, apres visa revue) ;
--   * zero perte : les lignes existantes sont copiees via les
--     partitions correspondantes AVANT que la sauvegarde ne soit
--     renommee (sauvegarde -> events_bak_done en fin de script) ;
--   * couverture de bornes : les partitions couvrent depuis le mois le
--     plus ancien present dans les donnees jusqu'au mois courant +
--     11 glissants, pour ne rejeter aucune ligne en copie.
--
-- Exécution : psql direct :5432, apres 001-outbox.sql.
-- Ne JAMAIS passer par PgBouncer pour le DDL (plan E3 §3).

DO $block$
DECLARE
  min_month date;
  end_bound date;
  m         date;
  idx       record;
BEGIN
  -- Table absente : rien a migrer (no-op).
  IF to_regclass('audit.events') IS NULL THEN
    RAISE NOTICE 'audit.events absente : rien a faire';
    RETURN;
  END IF;

  -- Deja partitionnee : no-op strict (garantit la re-execution).
  IF (SELECT relkind FROM pg_class
      WHERE oid = 'audit.events'::regclass) = 'p' THEN
    RAISE NOTICE 'audit.events deja partitionnee : no-op';
    RETURN;
  END IF;

  -- Retour arriere cherche (ex : reprise apres echec partiel) : on
  -- refuse de poursuivre sur un etat a moitie-construit.
  IF to_regclass('audit.events_bak') IS NOT NULL THEN
    RAISE EXCEPTION
      'audit.events_bak existe deja : migration precedente interrompue, traiter a la main';
  END IF;

  -- 1. Sauvegarde nommee. La sequence bigserial suit la table ; on la
  --    renomme aussi, sinon la creation du nouveau bigserial levait une
  --    collision sur events_id_seq.
  ALTER TABLE audit.events RENAME TO events_bak;
  EXECUTE format(
    'ALTER SEQUENCE %s RENAME TO events_id_seq_bak',
    pg_get_serial_sequence('audit.events_bak', 'id')
  );

  -- Le renommage de table ne RENAME PAS ses indexes : sans ce bloc, le
  -- PK events_pkey de la sauvegarde empêcherait de créer la nouvelle
  -- table avec son propre constraint events_pkey. Tous les noms
  -- d'indexes passent en suffixe _bak, les noms propres sont libérés.
  FOR idx IN
    SELECT i.relname AS nom_index
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'audit'
      AND t.relname = 'events_bak'
      AND i.relname NOT LIKE 'events\_%\_bak' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER INDEX audit.%I RENAME TO %I',
      idx.nom_index,
      idx.nom_index || '_bak'
    );
  END LOOP;

  -- 2. Nouvelle table partitionnee : colonnes heritees + outbox_id
  --    (lien outbox, unicite (outbox_id, at) = idempotence du drain).
  CREATE TABLE audit.events (
    id        bigserial   NOT NULL,
    at        timestamptz NOT NULL DEFAULT now(),
    actor     text        NOT NULL,
    action    text        NOT NULL,
    target    text,
    details   jsonb,
    outbox_id bigint,
    CONSTRAINT events_pkey PRIMARY KEY (id, at)  -- cle de partition incluse
  ) PARTITION BY RANGE (at);

  -- Indexes de requete FR-03.3 (indexes parents, propages attache aux
  -- partitions creees ensuite).
  CREATE INDEX events_actor_idx  ON audit.events (actor);
  CREATE INDEX events_action_idx ON audit.events (action);
  CREATE UNIQUE INDEX events_outbox_uniq ON audit.events (outbox_id, at);

  -- 3. Partitions mensuelles : de min(donnees, mois courant) inclus
  --    jusqu'au mois courant + 11 glissants ; couverture retro pour ne
  --    perdre aucune ligne, avance de 12 mois pour les operations a
  --    venir (rotate : infra/rotate-audit-partitions.sh).
  SELECT min(date_trunc('month', at))::date INTO min_month FROM audit.events_bak;
  IF min_month IS NULL THEN
    min_month := date_trunc('month', now())::date;
  END IF;
  end_bound := greatest(
    min_month,
    (date_trunc('month', now()) + interval '12 month')::date
  );

  m := min_month;
  WHILE m < end_bound LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS audit.events_%s PARTITION OF audit.events FOR VALUES FROM (%L) TO (%L)',
      to_char(m, 'YYYYMM'),
      m,
      m + interval '1 month'
    );
    m := m + interval '1 month';
  END LOOP;

  -- 4. Copie des donnees : le routage est un INSERT sur la table
  --    partitionnee (PostgreSQL place chaque ligne dans la partition
  --    du mois de son « at »).
  INSERT INTO audit.events (id, at, actor, action, target, details)
    SELECT id, at, actor, action, target, details
    FROM audit.events_bak;

  -- 5. La sauvegarde reste consultable (pas de drop) : revert = renommer
  --    events_bak_done en events puis detruire la version partitionnee.
  ALTER TABLE audit.events_bak RENAME TO events_bak_done;

  RAISE NOTICE 'audit.events partitionnee : % partitions, lignes copiees, sauvegarde -> audit.events_bak_done',
    (SELECT count(*) FROM pg_inherits WHERE inhparent = 'audit.events'::regclass);
END
$block$;
