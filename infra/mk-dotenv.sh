#!/bin/bash
# Génère les .env locaux (idempotent) — ne JAMAIS les committer.
#   ALVEARE/.env      : app (DB, Keycloak issuer)
#   ALVEARE/infra/.env : compose Keycloak (bootstrap admin, users de test)
# Usage : bash infra/mk-dotenv.sh   (PG_ADMINPASS surchargé si besoin)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

gen() { openssl rand -hex 16; }

# E3 audit (revue T3.8 S-3) : secret du client e2e « audit-e2e », généré
# UNE fois puis écrit au MÊME format dans infra/.env (compose →
# seed-dev) et dans le .env racine (e2e, lecture directe). Rien ne vit
# dans un fichier versionné.
AUDIT_E2E_SECRET="$(gen)"

# --- infra/.env (compose keycloak) ---
if [ ! -f "$ROOT/infra/.env" ]; then
  cat > "$ROOT/infra/.env" <<EOF
KC_BOOTSTRAP_ADMIN_USERNAME=admin
KC_BOOTSTRAP_ADMIN_PASSWORD=admin-dev
ALV_ADMIN_PASS=$(gen)
ALV_USER_PASS=$(gen)
# E3 audit : secret du client e2e audit-e2e (posé sur le client par
# seed-dev.sh) + plafond de tentatives du drain (quarantaine, DÉV).
AUDIT_E2E_SECRET=$AUDIT_E2E_SECRET
AUDIT_ATTEMPTS_CAP=${AUDIT_ATTEMPTS_CAP:-5}
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
# E3 audit (worker BullMQ) — Redis du compose infra/ :6379, DB 0
REDIS_URL=redis://localhost:6379/0
# E3 audit (revue T3.8 S-3 / D-6) : client e2e confiné — secret
# identique à infra/.env (e2e-audit.sh le lit là-bas) et plafond de
# quarantaine du drain. Les deux variables DÉV suivantes n'existent
# JAMAIS en prod : aucun realm de prod ne connaît le client audit-e2e,
# et ALV_ALLOW_E2E n'est jamais posé hors e2e.
AUDIT_E2E_SECRET=$AUDIT_E2E_SECRET
AUDIT_ATTEMPTS_CAP=${AUDIT_ATTEMPTS_CAP:-5}
AUTH_E2E_CLIENTS=audit-e2e
ALV_ALLOW_E2E=1
EOF
  echo ".env racine : écrit"
else
  echo ".env racine : déjà présent, inchangé"
fi

# E3 audit : REDIS_URL manquante = append idempotent (cas où .env est
# déjà présent ; les services le lisent via node --env-file).
if ! grep -q '^REDIS_URL=' "$ROOT/.env"; then
  printf 'REDIS_URL=redis://localhost:6379/0\n' >> "$ROOT/.env"
  echo ".env : REDIS_URL ajoutée (E3 audit)"
fi

# E3 audit (revue T3.8 S-3/D-6) : append idempotent des variables
# d'audit absentes sur des installations déjà générées. Le secret est
# écrit au même format dans infra/.env et le .env racine (une seule
# chance de le générer : si une seule des deux clés existe déjà, la
# valeur préexistante GAGNE partout — jamais deux secrets différents).
if grep -q '^AUDIT_E2E_SECRET=' "$ROOT/infra/.env" || grep -q '^AUDIT_E2E_SECRET=' "$ROOT/.env"; then
  AUDIT_E2E_SECRET="$(sed -n 's/^AUDIT_E2E_SECRET=//p' "$ROOT/infra/.env" "$ROOT/.env" 2>/dev/null | sed -n '1p')"
fi
add_kv() { # add_kv <fichier> <clé> <valeur> — append si la clé est absente
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then return 0; fi
  printf '%s=%s\n' "$key" "$value" >> "$file"
  echo "$file : $key ajoutée (E3 audit)"
}
add_kv "$ROOT/infra/.env" 'AUDIT_E2E_SECRET' "$AUDIT_E2E_SECRET"
add_kv "$ROOT/infra/.env" 'AUDIT_ATTEMPTS_CAP' "${AUDIT_ATTEMPTS_CAP:-5}"
add_kv "$ROOT/.env" 'AUDIT_E2E_SECRET' "$AUDIT_E2E_SECRET"
add_kv "$ROOT/.env" 'AUDIT_ATTEMPTS_CAP' "${AUDIT_ATTEMPTS_CAP:-5}"
# Extension azp DÉV uniquement + garde-mort e2e (jamais en prod :
# aucun autre fichier versionné ne référence ces deux valeurs).
add_kv "$ROOT/.env" 'AUTH_E2E_CLIENTS' 'audit-e2e'
add_kv "$ROOT/.env" 'ALV_ALLOW_E2E' '1'

# E6 paiements — provider + plafonds du webhook sortant (append
# idempotent). Provider par défaut = « dev » (simulation locale, zéro
# réseau) ; CHARGILY_SECRET_KEY N'EST PAS générée ici : c'est le secret
# sandbox du compte Chargily de l'OPÉRATEUR — jamais un placeholder
# dans le .env réel. Si la variable est déjà posée dans l'environnement
# au moment du mk-dotenv, elle est reportée (idempotent) ; sinon
# l'opérateur l'ajoute à la main (infra/.env.example = gabarit).
add_kv "$ROOT/.env" 'PAYMENTS_PROVIDER' 'dev'
add_kv "$ROOT/.env" 'PAYMENTS_HTTP_TIMEOUT_MS' "${PAYMENTS_HTTP_TIMEOUT_MS:-10000}"
add_kv "$ROOT/.env" 'PAYMENTS_WEBHOOK_ATTEMPTS_CAP' "${PAYMENTS_WEBHOOK_ATTEMPTS_CAP:-5}"
add_kv "$ROOT/.env" 'PAYMENTS_WEBHOOK_MAX_SKEW' '300'
add_kv "$ROOT/.env" 'PAYMENTS_TTL_SECONDS' '1200'
if [ -n "${CHARGILY_SECRET_KEY:-}" ]; then
  add_kv "$ROOT/.env" 'CHARGILY_SECRET_KEY' "$CHARGILY_SECRET_KEY"
  add_kv "$ROOT/infra/.env" 'CHARGILY_SECRET_KEY' "$CHARGILY_SECRET_KEY"
  echo "mk-dotenv : CHARGILY_SECRET_KEY reportée (jamais affichée)"
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
