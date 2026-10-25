#!/bin/bash
# Seed dev : complétion des users de test du realm "alveare".
# Mots de passe jamais dans le realm JSON — posés ici depuis l'env du
# conteneur (ALV_ADMIN_PASS / ALV_USER_PASS via docker-compose).
# Le secret du client e2e « audit-e2e » (E3, revue T3.8 S-3) est
# également posé ICI depuis l'env (AUDIT_E2E_SECRET) : le realm JSON
# versionné n'en contient jamais.
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

# 3) e3 : le compte de service du client e2e (audit-e2e, non interactif,
#    MFA sans objet) reçoit le rôle realm "admin" — tokens client_credentials
#    uniquement, jamais un humain.
sa_uid=$(kcadm get users -r alveare -q "username=service-account-audit-e2e" --fields id \
  | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p')
[ -n "$sa_uid" ] || { echo "e3-seed KO : service-account-audit-e2e introuvable" >&2; exit 1; }
kcadm add-roles -r alveare --uid "$sa_uid" --rolename admin
echo "e3-seed : role admin -> service-account-audit-e2e ($sa_uid)"

# 4) e3 (revue T3.8 S-3) : le secret du client e2e est posé DEPUIS
#    l'env (infra/.env -> compose), jamais depuis le JSON du realm
#    versionné — et jamais un secret de realm de prod (garde-mort dans
#    packages/auth : ALV_ALLOW_E2E).
: "${AUDIT_E2E_SECRET:?AUDIT_E2E_SECRET requis (infra/.env -> compose-keycloak)}"
cid=$(kcadm get clients -r alveare -q clientId=audit-e2e --fields id \
  | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p')
[ -n "$cid" ] || { echo "e3-seed KO : client audit-e2e introuvable" >&2; exit 1; }
kcadm update "clients/$cid" -r alveare -s "secret=$AUDIT_E2E_SECRET"
echo "e3-seed : secret client audit-e2e posé depuis l'env"

echo "seed-dev OK : profils complets + passwords (temporary=false) posés"
