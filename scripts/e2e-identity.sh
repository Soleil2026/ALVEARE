#!/bin/bash
# e2e local de la brique Identité (T2.4) — exécutable après
#   bash infra/mk-dotenv.sh && bash infra/postgres-init.sh
#   docker compose up -d  (infra/) + seed-dev.sh + pnpm dev:identity
# Sortie : Preuve-lignes + code de sortie (echec si une preuve manque).
# E3 audit : la piste est d'abord écrite dans audit.outbox puis DRAINÉE
# vers audit.events par le service audit :4030 (sweep 30 s) — le
# compte ci-dessous accepte donc « events OU outbox non livrée » (pas
# de double comptage : une ligne delivered=true est déjà dans events).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/infra/.env"; set +a

KC="$KEYCLOAK_BASE_URL/realms/alveare"
API="http://localhost:${PORT:-4000}"

fail() { echo "E2E ÉCHEC : $1"; exit 1; }

curl -sf "$API/healthz" >/dev/null || fail "service down (/healthz)"
echo "✓ healthz"

code=$(curl -s -o /dev/null -w '%{http_code}' "$API/me")
[ "$code" = "401" ] || fail "sans token attendu 401, obtenu $code"
echo "✓ /me sans token → 401"

token=$(curl -s -X POST "$KC/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=web-admin -d scope=openid \
  -d username=user@dev.local -d password="$ALV_USER_PASS" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("access_token",""))')
[ -n "$token" ] || fail "pas de token pour user@dev.local"
echo "✓ token user@dev.local"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$API/me")
[ "$code" = "200" ] || fail "/me avec token attendu 200, obtenu $code"
echo "✓ /me avec token → 200"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" -d '{"userId":"x","app":"app-01","role":"admin"}' \
  "$API/admin/role-grants")
[ "$code" = "403" ] || fail "route admin attendue 403 pour user simple, obtenu $code"
echo "✓ /admin/role-grants sans rôle → 403"

cid=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d '{"consumingApp":"app-01","scope":"e2e:test"}' "$API/consents" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("consentId",""))')
[ -n "$cid" ] || fail "consentement non créé"
curl -sf -X DELETE -H "Authorization: Bearer $token" "$API/consents/$cid" >/dev/null
echo "✓ consentement + révocation"

dbpass="$(sed -n 's/^DATABASE_URL=postgresql:\/\/alveare_core_app:\([^@]*\)@.*/\1/p' "$ROOT/.env")"
n=$(PGPASSWORD="$dbpass" psql -h localhost -U alveare_core_app -d alveare_core -tAc \
  "SELECT (SELECT count(*) FROM audit.events WHERE action IN ('consent.grant','consent.revoke'))
        + (SELECT count(*) FROM audit.outbox
             WHERE delivered = false AND payload->>'action' IN ('consent.grant','consent.revoke'))")
[ "$n" -ge 2 ] || fail "audit : traces consentement manquantes ($n)"
echo "✓ audit : $n trace(s) de consentement (events + outbox en attente)"

echo "E2E IDENTITÉ : OK (6 preuves)"
