#!/bin/bash
# rotate-audit-partitions.sh — E3 audit : MAINTENANCE des partitions
# mensuelles de audit.events (plan E3 §3, FR-03.2 ; correctifs S-1 et
# D-2 de la revue T3.8). Zone Red — revue indépendante obligatoire.
#
# Rôle, trois phases dans cet ordre :
#   1. CRÉATION continue (S-1) : AVANT tout décapage, créer les
#      partitions manquantes de la fenêtre FUTURE avec tampon
#      [mois courant − 1 .. mois courant + 2] — le mois précédent inclus
#      sert de tampon aux entrées datées en tout début de mois (fuseau,
#      retard drain) ET répare une partition passée manquante. Sans ce
#      pas, il suffisait d'attendre 12 mois pour qu'une écriture « sans
#      partition » soit rejetée (partitions figées à la migration 002).
#      Avec rétention 12 mois, la couverture de bornes totale va de
#      courant − 12 à courant + 2.
#   2. PURGE de l'outbox (D-2, OPTIONNELLE) : uniquement si l'opérateur
#      passe --purge-outbox N (N mois) : DELETE des lignes livrées
#      (delivered = true) plus vieilles que N mois. DÉSACTIVÉE par
#      défaut — FRONTIÈRE : la purge de l'outbox ne supprime JAMAIS
#      rien de audit.events (l'audit final vit dans audit.events ;
#      l'outbox n'est qu'un relais).
#   3. RÉTENTION 12 mois glissants : détacher puis supprimer les
#      partitions dont le mois est strictement antérieur à
#      now() − 12 mois (cutoff recalculé à chaque exécution, ex. au
#      2026-10-25 : cutoff 202510 → partitions 202509 et plus anciennes
#      candidates). Une partition NON VIDE n'est JAMAIS supprimée (elle
#      est détachée puis conservée, un traitement humain décide ensuite
#      de son sort) — la piste d'audit ne peut pas être détruite par
#      accident.
#
# Garanties de sécurité :
#   * aucune table dont le nom ne matche pas regexp '^events_[0-9]{6}$'
#     n'est touchée (les tables ad-hoc / de test survivent) ;
#   * count(*) == 0 exigé avant tout DROP ;
#   * exécution sans partition candidates = no-op, exit 0 ;
#   * script idempotent et re-runnable (cron-able).
#
# Modes :
#   --check           : ne crée ni ne supprime rien ; exit 0 si TOUTES
#                       les partitions [courant − 1 .. courant + 2]
#                       existent, exit 1 sinon (utilisé par l'e2e).
#   --purge-outbox N  : purge optionnelle de l'outbox (N = mois, entier
#                       > 0) — voir phase 2 ci-dessus ; jamais par
#                       défaut.
#
# Usage :
#   bash infra/audit-migrations/rotate-audit-partitions.sh [--check] \
#        [--purge-outbox N] <psql-uri>
#   (ou env PGURL=... bash infra/audit-migrations/rotate-audit-partitions.sh)
#   URI = DB alveare_core en direct :5432, jamais via PgBouncer.
#   Le mot de passe NE DOIT PAS être commité : lire l'URI du .env via
#   process substitution, ex. :
#   bash ... "$(sed -n 's/^DATABASE_URL=//p' .env | sed 's/?.*//')"
#
# Déclenchement suggéré (docs/ops-audit.md) : cron quotidien la nuit ;
# le script est un no-op sans rien à faire (exit 0 + NOTICE).

set -euo pipefail

CHECK=0
PURGE_MONTHS=0
PGURL=""

# --- Analyse des arguments (les drapeaux d'abord, l'URI ensuite) -----
while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      CHECK=1; shift ;;
    --purge-outbox)
      # N = entier strictement positif. Validation stricte : seule une
      # forme [0-9]+ (non vide, non zéro) passe — donc AUCUNE
      # interpolation risquée dans le SQL de purge.
      [ $# -ge 2 ] || { echo "usage : --purge-outbox N (mois)" >&2; exit 2; }
      case "$2" in
        ''|*[!0-9]*|0) echo "--purge-outbox : N doit être un entier > 0" >&2; exit 2 ;;
      esac
      PURGE_MONTHS="$2"; shift 2 ;;
    *)
      if [ -z "$PGURL" ]; then PGURL="$1"; else
        echo "usage : un seul argument <psql-uri>" >&2; exit 2
      fi
      shift ;;
  esac
done

if [ -z "$PGURL" ]; then
  echo "usage : $0 [--check] [--purge-outbox N] <psql-uri>   (ou env PGURL)" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql introuvable : PostgreSQL 18 client requis" >&2
  exit 2
fi

# --- Mode --check : lecture seule, exit 0/1 (utilisé par l'e2e) ------
if [ "$CHECK" = 1 ]; then
  MISSING=$(psql -v ON_ERROR_STOP=1 "$PGURL" -tAc "
    SELECT count(*) FROM generate_series(
      (date_trunc('month', now()) - interval '1 month')::date,
      (date_trunc('month', now()) + interval '2 months')::date,
      '1 month'::interval
    ) AS g
    WHERE to_regclass('audit.events_' || to_char(g, 'YYYYMM')) IS NULL")
  MISSING=${MISSING:-0}
  if [ "$MISSING" -eq 0 ]; then
    echo "check partitions : fenêtre [courant-1 .. courant+2] complète (exit 0)"
    exit 0
  fi
  printf 'check partitions : %s partition(s) manquante(s)\n' "$MISSING" >&2
  exit 1
fi

# --- Phase 1 : création de la fenêtre future [courant-1 .. courant+2]
# (idem fenêtre de --check : le script est auto-réparateur). Bornes
# identiques à la migration 002 (littéraux 'YYYY-MM-01' / 'YYYY-MM-01
# + 1 mois') — calées sur le schéma existant.
psql -v ON_ERROR_STOP=1 "$PGURL" <<'SQL'
DO $win$
DECLARE
  m       date;
  pas     date;
  nom     text;
  creees  int := 0;
BEGIN
  IF to_regclass('audit.events') IS NULL THEN
    RAISE EXCEPTION 'audit.events absente : exécuter la migration 002 d''abord';
  END IF;

  pas := date_trunc('month', now())::date;
  FOR i IN -1 .. 2 LOOP
    m   := pas + (i * interval '1 month');
    nom := 'events_' || to_char(m, 'YYYYMM');
    IF to_regclass('audit.' || nom) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS audit.%I PARTITION OF audit.events FOR VALUES FROM (%L) TO (%L)',
        nom, m, m + interval '1 month'
      );
      creees := creees + 1;
      RAISE NOTICE '  créée : audit.% (de % à %)', nom, m, m + interval '1 month';
    END IF;
  END LOOP;
  RAISE NOTICE 'fenêtre [courant-1 .. courant+2] : % partition(s) nouvelle(s)', creees;
END
$win$;
SQL

# --- Phase 2 (OPTIONNELLE) : purge de l'outbox livrée ----------------
# FRONTIÈRE (D-2) : ne touche JAMAIS audit.events — l'audit final vit
# dans audit.events ; l'outbox n'est qu'un relais, purger l'un n'est pas
# purger l'autre.
if [ "$PURGE_MONTHS" -ge 1 ]; then
  NB=$(psql -v ON_ERROR_STOP=1 "$PGURL" -tAc "
    SELECT count(*) FROM audit.outbox
    WHERE delivered = true
      AND created_at < now() - make_interval(months => ${PURGE_MONTHS})")
  echo "purge outbox : ${NB} ligne(s) livrée(s) plus vieilles que ${PURGE_MONTHS} mois"
  psql -v ON_ERROR_STOP=1 "$PGURL" -c "
    DELETE FROM audit.outbox
    WHERE delivered = true
      AND created_at < now() - make_interval(months => ${PURGE_MONTHS})"
  echo "purge outbox : faite (audit.events non touché)"
fi

# --- Phase 3 : rétention — detach + drop (> 12 mois glissants) -------
psql -v ON_ERROR_STOP=1 "$PGURL" <<'SQL'
DO $ret$
DECLARE
  r            record;
  cutoff_month int;
  part_month   int;
  is_empty     boolean;
BEGIN
  -- Mois de coupure recalculé à CHAQUE exécution : tout ce qui est
  -- STRICTEMENT avant now() - 12 mois est candidat (ex. au
  -- 2026-10-25 : cutoff 202510, donc les partitions 202509 et plus
  -- anciennes sont candidates ; 202510..courant+2 conservées).
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
      AND c.relname ~ '^events_[0-9]{6}$'  -- garde-fou nommage
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
