#!/bin/bash
# e2e local de la brique Notifications (E5) — exécutable après
#   notify (:4020) + Keycloak (identity/documents non requis).
# Preuves : healthz complet → send email fr → outbox écrite →
#   variante ar (RTL) → variante en → SMS dev → dedupKey idempotent →
#   template inconnu 400 → anti-flood 429 → audit traces.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/infra/.env"; set +a

KC="$KEYCLOAK_BASE_URL/realms/alveare"
API="http://localhost:${NOTIFY_PORT:-4020}"
OUTBOX="${NOTIFY_DEV_OUTBOX:-/tmp/alv-notify-outbox.jsonl}"
fail() { echo "E2E ÉCHEC : $1"; exit 1; }

# 1) healthz avec toutes les briques attendues
health=$(curl -sf "$API/healthz") || fail "service notify down"
echo "$health" | grep -q 'templates-i18n-strict' || fail "brick templates-i18n-strict absente"
echo "$health" | grep -q 'pii-sealed-recipients' || fail "brick pii-sealed-recipients absente"
echo "✓ healthz notify + briques"

# 2) token user
token=$(curl -s -X POST "$KC/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=web-admin -d scope=openid \
  -d username=user@dev.local -d password="$ALV_USER_PASS" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$token" ] || fail "pas de token user"
marker="e2e-$(date +%s)"
echo "✓ token user OK"

# 3) send email FR → 200 + statut 'sent'
send=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"test\",\"lang\":\"fr\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"message\":\"$marker\"},\"dedupKey\":\"$marker-fr\"}" \
  "$API/send")
idFr=$(echo "$send" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id",""))')
stFr=$(echo "$send" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status",""))')
[ -n "$idFr" ] && [ "$stFr" = "sent" ] || fail "send fr : $send"
echo "✓ POST /send email fr → {id:$idFr, status:sent}"

# 4) outbox : le message FR est écrit (adresse visible DEV uniquement)
waitOut() {
  for _ in 1 2 3 4 5; do grep -q "$1" "$OUTBOX" 2>/dev/null && return 0; sleep 0.4; done
  return 1
}
waitOut "$marker" || fail "outbox : email fr manquant"
echo "$marker-fr" > /tmp/alv-e5-marker
echo "✓ outbox : email fr écrit (adresse visible en dev seulement)"

# 5) variante ar → dir="rtl" dans le HTML outboxé
send=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"test\",\"lang\":\"ar\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"message\":\"رسالة $marker\"},\"dedupKey\":\"$marker-ar\"}" \
  "$API/send")
echo "$send" | grep -q '"status":"sent"' || fail "send ar : $send"
waitOut "$marker" || fail "outbox : email ar manquant"
grep -q 'dir=..rtl..' "$OUTBOX" || fail "ar : dir=rtl absent du HTML"
echo "✓ variante ar → HTML dir=\"rtl\""

# 6) variante en
send=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"test\",\"lang\":\"en\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"message\":\"hello $marker\"},\"dedupKey\":\"$marker-en\"}" \
  "$API/send")
echo "$send" | grep -q '"status":"sent"' || fail "send en : $send"
waitOut "hello $marker" || fail "outbox : email en manquant"
echo "✓ variante en → outbox"

# 7) SMS dev → JSONL channel sms
send=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"sms\",\"template\":\"test\",\"lang\":\"fr\",\"to\":\"+33612345678\",\"via\":\"e2e\",\"params\":{\"message\":\"sms $marker\"},\"dedupKey\":\"$marker-sms\"}" \
  "$API/send")
echo "$send" | grep -q '"status":"sent"' || fail "send sms : $send"
grep -q '"channel":"sms"' "$OUTBOX" || fail "outbox : sms manquant"
echo "✓ adaptateur SMS dev → outbox"

# 8) dedupKey rejoué → même id + deduped:true
replay=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"test\",\"lang\":\"fr\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"message\":\"$marker\"},\"dedupKey\":\"$marker-fr\"}" \
  "$API/send")
dId=$(echo "$replay" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id",""))')
dFlag=$(echo "$replay" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("deduped")).lower())')
{ [ "$dId" = "$idFr" ] && [ "$dFlag" = "true" ]; } || fail "dedup : $replay"
echo "✓ dedupKey rejoué → même id $dId + deduped:true"

# 9) template/lang inconnu → 400 générique
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d '{"channel":"email","template":"xxx","lang":"fr","to":"e2e-$marker@dev.local","via":"e2e"}' "$API/send")
[ "$code" = "400" ] || fail "template inconnu : attendu 400, obtenu $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"sms\",\"template\":\"test\",\"lang\":\"de\",\"to\":\"+33612345678\",\"via\":\"e2e\",\"params\":{\"message\":\"$marker-2\"}}" "$API/send")
[ "$code" = "400" ] || fail "lang inconnue : attendu 400, obtenu $code"
echo "✓ template/lang inconnus → 400"

# 10) anti-flood : 4 envois acceptés (fr+ar+en+sms consomment le hash
# user déjà... on utilise un destinataire NEUF pour un cap propre)
floodTo="flood-$marker@dev.local"
onesend() {
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"channel\":\"email\",\"template\":\"test\",\"lang\":\"en\",\"to\":\"$floodTo\",\"via\":\"e2e\",\"params\":{\"message\":\"flood $1\"}}" "$API/send"
}
for i in 1 2 3 4 5; do
  [ "$(onesend "$i")" = "201" ] || fail "flood send $i refusé — le cap doit laisser passer 5 (201)"
done
code=$(onesend 6)
[ "$code" = "429" ] || fail "6e envoi flood : attendu 429, obtenu $code"
echo "✓ anti-flood : 5 passent, 6e → 429"

# 11) audit : traces notify.*
n=$(PGPASSWORD="$(sed -n 's/^DATABASE_URL=postgresql:\/\/alveare_core_app:\([^@]*\)@.*/\1/p' "$ROOT/.env")" \
  psql -h localhost -U alveare_core_app -d alveare_core -tAc \
  "SELECT count(*) FROM audit.events WHERE action IN ('notify.send','notify.sent','notify.failed')")
[ "$n" -ge 8 ] || fail "audit : $n traces notify seulement"
echo "$n" > /tmp/alv-e5-audit-count
echo "✓ audit : $n traces notify"

echo "E2E NOTIFY : OK (11 preuves)"
