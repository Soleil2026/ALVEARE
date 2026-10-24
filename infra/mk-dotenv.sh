#!/bin/bash
# Génère les .env locaux (idempotent) — ne JAMAIS les committer.
#   ALVEARE/.env      : app (DB, Keycloak issuer)
#   ALVEARE/infra/.env : compose Keycloak (bootstrap admin, users de test)
# Usage : bash infra/mk-dotenv.sh   (PG_ADMINPASS surchargé si besoin)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

gen() { openssl rand -hex 16; }

# --- infra/.env (compose keycloak) ---
if [ ! -f "$ROOT/infra/.env" ]; then
  cat > "$ROOT/infra/.env" <<EOF
KC_BOOTSTRAP_ADMIN_USERNAME=admin
KC_BOOTSTRAP_ADMIN_PASSWORD=admin-dev
ALV_ADMIN_PASS=$(gen)
ALV_USER_PASS=$(gen)
EOF
  echo "infra/.env : écrit"
else
  echo "infra/.env : déjà présent, inchangé"
fi

# --- .env racine (app) ---
if [ ! -f "$ROOT/.env" ]; then
  cat > "$ROOT/.env" <<EOF
# Base du socle — rôle applicatif min-privilege
PG_ADMINPASS=${PG_ADMINPASS:-SS}
DATABASE_URL=postgresql://alveare_core_app:$(gen)@localhost:5432/alveare_core?schema=identity
# Keycloak local
KEYCLOAK_BASE_URL=http://localhost:8081
KEYCLOAK_ISSUER=http://localhost:8081/realms/alveare
EOF
  echo "`.env` racine : écrit"
else
  echo "`.env` racine : déjà présent, inchangé"
fi
