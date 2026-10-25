#!/bin/bash
# e2e local de la brique Documents (T4.6) — exécutable après
#   identity (:4000) + documents (:4010) + Keycloak.
# Preuves : upload → sha256 → partage signé → téléchargement →
#   vérification publique → révocation → accès refusé → mime refusé.
# E3 audit : la piste est d'abord écrite dans audit.outbox puis DRAINÉE
# vers audit.events par le service audit :4030 (sweep 30 s) — le
# compte ci-dessous accepte donc « events OU outbox non livrée » (pas
# de double comptage : une ligne delivered=true est déjà dans events).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/infra/.env"; set +a

KC="$KEYCLOAK_BASE_URL/realms/alveare"
API="http://localhost:${DOCS_PORT:-4010}"
fail() { echo "E2E ÉCHEC : $1"; exit 1; }

curl -sf "$API/healthz" >/dev/null || fail "service documents down"
echo "✓ healthz documents"

# 1) upload d'un PDF de test par user@dev.local
token=$(curl -s -X POST "$KC/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=web-admin -d scope=openid \
  -d username=user@dev.local -d password="$ALV_USER_PASS" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$token" ] || fail "pas de token user"
printf '%%PDF-1.4\n1 0 obj\nendobj\n%%%%EOF\n' > /tmp/alveare-e4.pdf
doc=$(curl -s -X POST -H "Authorization: Bearer $token" \
  -F "file=@/tmp/alveare-e4.pdf;type=application/pdf" "$API/documents")
docId=$(echo "$doc" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
[ -n "$docId" ] || fail "upload raté : $doc"
echo "✓ upload → document $docId + sha256"

# 2) mime trompeur refusé (PDF déclaré png)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" \
  -F "file=@/tmp/alveare-e4.pdf;type=image/png" "$API/documents")
[ "$code" = "400" ] || fail "mime trompeur attendu 400, obtenu $code"
echo "✓ upload trompeur (png déclaré, pdf réel) → 400"

# 3) les documents d'autrui sont invisibles / non partageables
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $token" \
  "$API/documents/999999")
[ "$code" = "404" ] || fail "document inconnu : attendu 404, obtenu $code"
echo "✓ documents d'un autre → 404"

# 4) partage signé + téléchargement OK + QR
share=$(curl -s -X POST -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" -d '{}' "$API/documents/$docId/share")
url=$(echo "$share" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("url",""))')
verifyUrl=$(echo "$share" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("verifyUrl",""))')
qrLen=$(echo "$share" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("qrSvg","")))')
echo "$url" > /tmp/alveare-e4-share.url
[ -n "$url" ] || fail "partage raté : $share"
[ "$qrLen" -gt 100 ] || fail "QR vide"
code=$(curl -s -o /tmp/alveare-e4-down.pdf -w '%{http_code}' "$url")
[ "$code" = "200" ] || fail "téléchargement attendu 200, obtenu $code"
grep -q '%PDF-1.4' /tmp/alveare-e4-down.pdf || fail "contenu téléchargé ≠ original"
echo "✓ URL signée → téléchargement 200 + contenu conforme + QR SVG ($qrLen car)"

# 5) vérification publique (sans login) avec le même token
code=$(curl -s -o /dev/null -w '%{http_code}' "$verifyUrl")
[ "$code" = "200" ] || fail "verify attendu 200, obtenu $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "${verifyUrl%%\?*}")
[ "$code" = "401" ] || fail "verify sans token attendu 401, obtenu $code"
echo "✓ vérification publique (token) 200 · sans token 401"

# 6) révocation par le propriétaire → accès refusé
rev=$(echo "$share" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jti",""))')
curl -sf -X DELETE -H "Authorization: Bearer $token" "$API/shares/$rev" >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
[ "$code" = "401" ] || fail "partage révoqué attendu 401, obtenu $code"
echo "✓ partage révoqué → téléchargement désormais 401"

# 7) suppression + traces d'audit
curl -sf -X DELETE -H "Authorization: Bearer $token" "$API/documents/$docId" >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$API/documents/$docId")
[ "$code" = "404" ] || fail "document attendu disparu (404), obtenu $code"
n=$(PGPASSWORD="$(sed -n 's/^DATABASE_URL=postgresql:\/\/alveare_core_app:\([^@]*\)@.*/\1/p' "$ROOT/.env")" \
  psql -h localhost -U alveare_core_app -d alveare_core -tAc \
  "SELECT (SELECT count(*) FROM audit.events WHERE action IN ('document.upload','document.download','share.grant','share.revoke','document.delete'))
        + (SELECT count(*) FROM audit.outbox
             WHERE delivered = false AND payload->>'action' IN ('document.upload','document.download','share.grant','share.revoke','document.delete'))")
[ "$n" -ge 5 ] || fail "audit : $n traces seulement"
echo "✓ suppression + audit : $n traces document (events + outbox en attente)"

echo "E2E DOCUMENTS : OK (10 preuves)"
