#!/bin/bash
# e2e local du pipeline d'audit E3 (T3.7) — exécutable après
#   identity (:4000) + documents (:4010) + notify (:4020) +
#   audit (:4030, pnpm dev:audit) + Redis (:6379, compose infra/) +
#   Keycloak (:8081) + Postgres (:5432, migrations audit appliquées).
#
# Zone Red (piste d'audit) — preuves numérotées, format e2e-notify.
#
# Tolérance au drain : à ce stade (consigne T3.4) les émetteurs
# n'enfilent PAS encore de job signal — seule la fréquence du sweep
# BullMQ (30 s, idempotent) est garantie. Les chronomètres ci-dessous
# sont donc calés sur le sweep (≤40 s pour la première trace, +31 s
# pour prouver l'idempotence sur UN DEUXIÈME sweep naturel), pas sur
# un délai de signal. Le drain doit rester invisible pour les autres
# e2e (voir en-têtes de e2e-identity/documents/notify : leur compte
# audit accepte « events OU outbox non livrée »).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/infra/.env"; set +a

KC="$KEYCLOAK_BASE_URL/realms/alveare"
AUDIT="http://localhost:${AUDIT_PORT:-4030}"
IDENT="http://localhost:${PORT:-4000}"
DOCS="http://localhost:${DOCS_PORT:-4010}"
NOTIF="http://localhost:${NOTIFY_PORT:-4020}"
DBPASS="$(sed -n 's/^DATABASE_URL=postgresql:\/\/alveare_core_app:\([^@]*\)@.*/\1/p' "$ROOT/.env")"
fail() { echo "E2E ÉCHEC : $1"; exit 1; }
psqlq() { PGPASSWORD="$DBPASS" psql -h localhost -U alveare_core_app -d alveare_core -tAc "$1"; }

# 1) healthz des 4 services + briques audit (drain + idempotence)
curl -sf "$IDENT/healthz" >/dev/null || fail "identity down"
curl -sf "$DOCS/healthz" >/dev/null || fail "documents down"
curl -sf "$NOTIF/healthz" >/dev/null || fail "notify down"
health=$(curl -sf "$AUDIT/healthz") || fail "audit :4030 down"
echo "$health" | grep -q 'drain-sweep-30s' || fail "brick drain-sweep-30s absente"
echo "$health" | grep -q 'drain-idempotent' || fail "brick drain-idempotent absente"
echo "✓ healthz ×4 (identity/documents/notify/audit) + briques drain"

# 2) Redis joignable (queue audit-drain)
ping=""
if command -v redis-cli >/dev/null 2>&1; then
  ping=$(redis-cli -h localhost -p 6379 ping 2>/dev/null || true)
elif docker compose -f "$ROOT/infra/docker-compose.yml" ps redis >/dev/null 2>&1; then
  ping=$(docker compose -f "$ROOT/infra/docker-compose.yml" exec -T redis redis-cli ping 2>/dev/null || true)
fi
echo "$ping" | grep -q '^PONG' || fail "Redis :6379 injoignable (sweep impossible)"
echo "✓ Redis :6379 PONG (queue audit-drain)"

# 3) tokens Keycloak : user + admin (flux e2e-identity)
token_user=$(curl -s -X POST "$KC/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=web-admin -d scope=openid \
  -d username=user@dev.local -d password="$ALV_USER_PASS" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$token_user" ] || fail "pas de token user"
token_admin=$(curl -s -X POST "$KC/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=web-admin -d scope=openid \
  -d username=admin@dev.local -d password="$ALV_ADMIN_PASS" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$token_admin" ] || fail "pas de token admin"
echo "✓ tokens Keycloak (user + admin)"

# 4) upload d'un PDF par user@dev.local via documents (flux e2e-documents)
marker=$(date +%s)
fileName="e3-audit-$marker.pdf"
printf '%%PDF-1.4\n1 0 obj\nendobj\n%%%%EOF\n' > "/tmp/x-$fileName"
doc=$(curl -s -X POST -H "Authorization: Bearer $token_user" \
  -F "file=@/tmp/x-$fileName;type=application/pdf" "$DOCS/documents")
docId=$(echo "$doc" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
sha=$(echo "$doc" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha256",""))')
[ -n "$docId" ] && [ -n "$sha" ] || fail "upload raté : $doc"
echo "✓ upload → document $docId (sha256 ${sha:0:12}…) — trace document.upload attendue"

# 5) ≤ 40 s (sweep 30s au plus) : la trace document.upload apparaît dans la table mère
n_before=$(psqlq "SELECT count(*) FROM audit.events WHERE action='document.upload' AND target LIKE '${docId}:%'") || n_before=0
n_now=$n_before
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
  n_now=$(psqlq "SELECT count(*) FROM audit.events WHERE action='document.upload' AND target LIKE '${docId}:%'") || n_now=0
  [ "$n_now" -gt "$n_before" ] && break
  sleep 1
done
[ "$n_now" -gt "$n_before" ] || fail "drain : trace document.upload absente après 40 s"
echo "✓ drain ≤ sweep : trace document.upload présente dans audit.events (n=$n_now)"

# 6) outbox associé : livrée (delivered=true) ET liée dans audit.events
ok=$(psqlq "SELECT count(*) FROM audit.outbox o
  WHERE o.payload->>'action' = 'document.upload'
    AND o.payload->>'outbox_source' IS NOT NULL
    AND o.delivered = true
    AND o.id IN (SELECT outbox_id FROM audit.events WHERE action='document.upload' AND target LIKE '${docId}:%')")
[ "${ok:-0}" -ge 1 ] || fail "outbox : pas d'entrée document.upload delivered=true + outbox_id lié"
echo "✓ outbox livrée (delivered=true) + audit.events contient ses outbox_id"

# 7) idempotence sur UN DEUXIÈME sweep naturel (+31 s) : zéro doublon
sleep 31
n_after=$(psqlq "SELECT count(*) FROM audit.events WHERE action='document.upload' AND target LIKE '${docId}:%'")
[ "$n_after" = "$n_now" ] || fail "deuxième sweep : $n_now → $n_after (une trace dupliquée ?)"
dedup=$(psqlq "SELECT count(*) = count(DISTINCT outbox_id) FROM audit.events WHERE action='document.upload' AND target LIKE '${docId}:%'")
[ "$dedup" = "t" ] || fail "doublons : count(*) ≠ count(DISTINCT outbox_id)"
echo "✓ 2e sweep : count stable ($n_after) + unicité outbox_id (idempotence ON CONFLICT)"

# 8) lecture admin FR-03.3 : filtre action, item = TARGET de l'upload
#    (trace document.upload inchangée : target = "<docId>:<fileName>" ;
#    le sha256 du fichier n'est pas dans la trace d'audit actuelle —
#    c'est la réponse d'upload qui le portait, format hérité conservé).
res=$(curl -sf -H "Authorization: Bearer $token_admin" \
  "$AUDIT/admin/audit?action=document.upload&limit=100") \
  || fail "GET /admin/audit : non 200 (admin?)"
echo "$res" | grep -q '"nextCursor"' || fail "réponse sans nextCursor"
hits=$(echo "$res" | python3 -c '
import json, sys
d = json.load(sys.stdin)
want = sys.argv[1] + ":"
print(sum(1 for it in d.get("items", []) if str(it.get("target", "")).startswith(want)))
' "$docId") || hits=0
[ "${hits:-0}" -ge 1 ] || fail "lecture : item ${docId}:$fileName absent de la réponse"
echo "$res" | grep -q "$fileName" || fail "item sans target $fileName : $res"
echo "✓ GET /admin/audit (admin, action=document.upload) : item ${docId}:$fileName + nextCursor"

# 9) accès non-admin refusé : user simple → 403, sans token → 401
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token_user" "$AUDIT/admin/audit")
[ "$code" = "403" ] || fail "admin API user simple : attendu 403, obtenu $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$AUDIT/admin/audit")
[ "$code" = "401" ] || fail "admin API sans token : attendu 401, obtenu $code"
echo "✓ GET /admin/audit gardé : user simple → 403, sans token → 401"

# 10) rotate partitions : dry-run sans partition candidate → exit 0
bash "$ROOT/infra/rotate-audit-partitions.sh" \
  "postgresql://alveare_core_app:$DBPASS@localhost:5432/alveare_core" >/dev/null 2>&1 \
  || fail "rotate-audit-partitions : exit non nul"
echo "✓ rotate partitions : no-op exit 0 (12 mois courants conservés)"

echo "E2E AUDIT : OK (10 preuves)"
