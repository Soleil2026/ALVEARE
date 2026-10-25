#!/bin/bash
# rotate-audit-partitions.sh — E3 audit : rétention 12 mois glissants
# (plan E3 §3, FR-03.2). Zone Red — revue indépendante obligatoire.
#
# Rôle : détacher puis supprimer les partitions de audit.events dont le
# mois est strictement antérieur à now() - 12 mois. Une partition non
# vide n'est JAMAIS supprimée (elle est détachée puis conservée, un
# traitement humain décide ensuite de son sort) — la piste d'audit ne
# peut pas être détruite par accident.
#
# Garanties de sécurité :
#   * aucune table dont le nom ne matche pas regexp '^events_[0-9]{6}$'
#     n'est touchée (les tables ad-hoc / de test survivent) ;
#   * count(*) == 0 exigé avant tout DROP ;
#   * exécution sans partition candidates = no-op, exit 0.
#
# Usage :
#   bash infra/audit-migrations/rotate-audit-partitions.sh <psql-uri>
#   (ou env PGURL=... bash infra/audit-migrations/rotate-audit-partitions.sh)
#   URI = DB alveare_core en direct :5432, jamais via PgBouncer.
#   Le mot de passe NE DOIT PAS être commité : lire l'URI du .env via
#   process substitution, ex. :
#   bash ... "$(sed -n 's/^DATABASE_URL=//p' .env | sed 's/?.*//')"
set -euo pipefail

PGURL="${1:-${PGURL:-}}"
if [ -z "$PGURL" ]; then
  echo "usage : $0 <psql-uri>   (ou env PGURL)" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql introuvable : PostgreSQL 18 client requis" >&2
  exit 2
fi

psql -v ON_ERROR_STOP=1 "$PGURL" <<'SQL'
DO $ret$
DECLARE
  r            record;
  cutoff_month int;
  part_month   int;
  is_empty     boolean;
BEGIN
  -- Mois de coupure : tout ce qui est STRICTEMENT avant est candidat
  -- (au 2026-10-25 : 202608 et plus ancien ; 202609..202702 conservés).
  cutoff_month :=
    (to_char(now() - interval '12 months', 'YYYYMM'))::int;

  FOR r IN
    SELECT c.oid AS child_oid, c.relname, c.relkind
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class cp ON cp.oid = i.inhparent
    WHERE cp.oid = 'audit.events'::regclass
      AND cp.relkind = 'p'            -- table effectivement partitionnée
      AND c.relkind = 'r'
      AND c.relname ~ '^events_[0-9]{6}$'  -- garde-­fou nommage
  LOOP
    part_month := substring(r.relname from 8)::int;

    IF part_month >= cutoff_month THEN
      RAISE NOTICE '  conservée : %', r.relname;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE audit.events DETACH PARTITION audit.%I',
      r.relname
    );
    RAISE NOTICE '  détachée  : % (mois % < coupure %)',
      r.relname, part_month, cutoff_month;

    -- Drop UNIQUEMENT si vide : la donnée détachée est conservée, pas
    -- supprimée (bis repetita : la piste d'audit n'est jamais
    -- détruite automatiquement sans preuve).
    EXECUTE format(
      'SELECT NOT EXISTS (SELECT 1 FROM audit.%I WHERE true LIMIT 1)',
      r.relname
    ) INTO is_empty;

    IF is_empty THEN
      EXECUTE format('DROP TABLE audit.%I', r.relname);
      RAISE NOTICE '  vidée      -> DROP TABLE : %', r.relname;
    ELSE
      RAISE NOTICE '  NON VIDE  -> conservée (traitement manuel) : %', r.relname;
    END IF;
  END LOOP;

  RAISE NOTICE 'rotate : fin (cutoff %)', cutoff_month;
END
$ret$;
SQL
