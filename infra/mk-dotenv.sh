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
# E4 documents
SHARE_SIGN_KEY=$(gen)$(gen)
DOC_DATA_DIR=$ROOT/data/documents
MAX_UPLOAD_MB=10
DOC_PUBLIC_BASE_URL=http://localhost:4010
# F front (web-admin)
SESSION_KEY=$(gen)$(gen)
IDENTITY_URL=http://localhost:4000
DOCUMENTS_URL=http://localhost:4010
REDIRECT_URI=http://localhost:3001/callback
EOF
  echo ".env racine : écrit"
else
  echo ".env racine : déjà présent, inchangé"
fi

# --- .env.runtime (E1, PgBouncer) ---
# Utilisé par les services applicatifs au runtime (node --env-file).
# prisma migrate / psql restent sur .env = :5432 direct (les migrations
# ne traversent pas un pool transactionnel). Si .env change (rotation
# de mot de passe), régénérer : rm .env.runtime && bash infra/mk-dotenv.sh
if [ ! -f "$ROOT/.env.runtime" ]; then
  # copie de .env SANS la ligne DATABASE_URL, puis reconstruction
  # propre de cette ligne via le host :6432 (aucun passage par sed avec
  # & — ni aucun affichage du mot de passe).
  grep -v '^DATABASE_URL=' "$ROOT/.env" > "$ROOT/.env.runtime"
  pass=$(sed -n 's/^DATABASE_URL=postgresql:\/\/alveare_core_app:\([^@]*\)@.*/\1/p' "$ROOT/.env")
  {
    printf 'DATABASE_URL=postgresql://alveare_core_app:%s@localhost:6432/alveare_core?schema=identity&pgbouncer=true&connection_limit=10&pool_timeout=5\n' "$pass"
  } >> "$ROOT/.env.runtime"
  chmod 600 "$ROOT/.env.runtime"
  unset pass
  echo ".env.runtime : écrit (PgBouncer :6432)"
else
  echo ".env.runtime : déjà présent, inchangé"
fi
