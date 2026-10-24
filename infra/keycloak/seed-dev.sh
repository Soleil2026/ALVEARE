#!/bin/bash
# Seed dev : complétion des users de test du realm "alveare".
# Mots de passe jamais dans le realm JSON — posés ici depuis l'env du
# conteneur (ALV_ADMIN_PASS / ALV_USER_PASS via docker-compose).
# Les mots de passe sont posés en temporary:false (sinon « Account is
# not fully set up » au premier login,KC 26 : UPDATE_PASSWORD requis).
# Exécution DANS le conteneur :
#   docker compose exec -T keycloak /bin/bash /opt/keycloak/data/import/seed-dev.sh
set -euo pipefail

kcadm() { /opt/keycloak/bin/kcadm.sh "$@"; }

kcadm config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" \
  --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null

: "${ALV_ADMIN_PASS:?ALV_ADMIN_PASS requis}"
: "${ALV_USER_PASS:?ALV_USER_PASS requis}"

get_uid() {
  kcadm get users -r alveare -q "username=$1" --fields id \
    | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p'
}

set_creds() {
  local uid="$1" pass="$2"
  kcadm update "users/$uid" -r alveare \
    -s "credentials=[{\"type\":\"password\",\"value\":\"$pass\",\"temporary\":false}]"
}

uid=$(get_uid admin@dev.local)
kcadm update "users/$uid" -r alveare -s firstName=Admin -s lastName=Dev
set_creds "$uid" "$ALV_ADMIN_PASS"

uid=$(get_uid user@dev.local)
kcadm update "users/$uid" -r alveare -s firstName=User -s lastName=Dev
set_creds "$uid" "$ALV_USER_PASS"

echo "seed-dev OK : profils complets + passwords (temporary=false) posés"
