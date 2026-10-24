#!/bin/bash
# Initialisation PostgreSQL locale (idempotent) de ALVEARE Core.
# - BD alveare_core, schéma identity (Prisma) + schéma audit (SQL brut)
# - rôle applicatif alveare_core_app min-privilege (mot de passe issu
#   du .env racine — jamais committé)
# Usage : bash infra/postgres-init.sh   (variables : lues dans .env)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; set +a

export PGPASSWORD="$PG_ADMINPASS"
PSQL="psql -h localhost -U postgres -v ON_ERROR_STOP=1"

# rôle applicatif (min-privilege) — CREATEDB requis pour les shadows
# databases de `prisma migrate dev` en dev uniquement
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='alveare_core_app'" | grep -q 1; then
  DBPASS="$(sed -n 's/^DATABASE_URL=postgresql:\/\/alveare_core_app:\([^@]*\)@.*/\1/p' "$ROOT/.env")"
  $PSQL -c "CREATE ROLE alveare_core_app LOGIN PASSWORD '$DBPASS' CREATEDB"
  echo "role alveare_core_app : créé"
else
  echo "role alveare_core_app : déjà présent"
fi

if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='alveare_core'" | grep -q 1; then
  $PSQL -c "CREATE DATABASE alveare_core OWNER alveare_core_app"
  echo "BD alveare_core : créée"
else
  echo "BD alveare_core : déjà présente"
fi

# schéma identity (porté par Prisma) + audit (SQL brut)
$PSQL -d alveare_core -c "CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION alveare_core_app"
$PSQL -d alveare_core -c "CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION alveare_core_app"
$PSQL -d alveare_core -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE IF NOT EXISTS audit.events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,
  action       text NOT NULL,
  target       text,
  details      jsonb
);
SQL
echo "schémas identity + audit : OK"
