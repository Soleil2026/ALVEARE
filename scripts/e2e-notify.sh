#!/bin/bash
# e2e local de la brique Notifications (E5) — exécutable après
#   notify (:4020) + Keycloak (identity/documents non requis).
# Preuves : healthz → send fr/ar(RTL)/en + SMS dev → outbox écrite →
#   template `test` interdit au simple user (revue N5-3) →
#   dedupKey idempotent (scoppé via, revue N5-1) → template/lang/via
#   inconnus → 400 → anti-flood 5/min → audit traces.
# E3 audit : la piste est d'abord écrite dans audit.outbox puis DRAINÉE
# vers audit.events par le service audit :4030 (sweep 30 s) — le
# compte ci-dessous accepte donc « events OU outbox non livrée » (pas
# de double comptage : une ligne delivered=true est déjà dans events).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/infra/.env"; set +a

KC="$KEYCLOAK_BASE_URL/realms/alveare"
API="http://localhost:${NOTIFY_PORT:-4020}"
OUTBOX="${NOTIFY_DEV_OUTBOX:-/tmp/alv-notify-outbox.jsonl}"
fail() { echo "E2E ÉCHEC : $1"; exit 1; }

# 1) healthz avec toutes les briques attendues (revue N5 : emitter-cap)
health=$(curl -sf "$API/healthz") || fail "service notify down"
echo "$health" | grep -q 'templates-i18n-strict' || fail "brick templates-i18n-strict absente"
echo "$health" | grep -q 'pii-sealed-recipients' || fail "brick pii-sealed-recipients absente"
echo "$health" | grep -q 'emitter-cap' || fail "brick emitter-cap absente (revue N5)"
echo "✓ healthz notify + briques"

# 2) token user (compte SIMPLE — pas admin)
token=$(curl -s -X POST "$KC/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=web-admin -d scope=openid \
  -d username=user@dev.local -d password="$ALV_USER_PASS" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$token" ] || fail "pas de token user"
marker="e2e-$(date +%s)"
echo "✓ token user OK"

# 3) send email FR (document-shared) → 201 + statut 'sent'
send=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"document-shared\",\"lang\":\"fr\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"docName\":\"Rapport $marker\",\"link\":\"https://e2e.local/s/$marker\",\"ttl\":\"2 h\"},\"dedupKey\":\"$marker-fr\"}" \
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
echo "✓ outbox : email fr écrit (adresse visible en dev seulement)"

# 5) variante ar (document-shared ar) → dir="rtl" dans le HTML outboxé
send=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"document-shared\",\"lang\":\"ar\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"docName\":\"وثيقة $marker\",\"link\":\"https://e2e.local/s/$marker-ar\",\"ttl\":\"2 h\"},\"dedupKey\":\"$marker-ar\"}" \
  "$API/send")
echo "$send" | grep -q '"status":"sent"' || fail "send ar : $send"
waitOut "$marker-ar" || fail "outbox : email ar manquant"
grep -q 'dir=..rtl..' "$OUTBOX" || fail "ar : dir=rtl absent du HTML"
echo "✓ variante ar → HTML dir=\"rtl\""

# 6) variante en (verify-email)
send=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"verify-email\",\"lang\":\"en\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"code\":\"424242\",\"link\":\"https://e2e.local/v/$marker-en\",\"ttl\":\"10 min\"},\"dedupKey\":\"$marker-en\"}" \
  "$API/send")
echo "$send" | grep -q '"status":"sent"' || fail "send en : $send"
waitOut "424242" || fail "outbox : email en manquant"
echo "✓ variante en → outbox"

# 7) SMS dev (document-shared en) → JSONL channel sms
send=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"sms\",\"template\":\"document-shared\",\"lang\":\"en\",\"to\":\"+33612345678\",\"via\":\"e2e\",\"params\":{\"docName\":\"Invoice $marker-sms\",\"link\":\"https://e2e.local/s/$marker-sms\",\"ttl\":\"2 h\"},\"dedupKey\":\"$marker-sms\"}" \
  "$API/send")
echo "$send" | grep -q '"status":"sent"' || fail "send sms : $send"
grep -q '"channel":"sms"' "$OUTBOX" || fail "outbox : sms manquant"
echo "✓ adaptateur SMS dev → outbox"

# 8) template `test` refusé au simple user → 403 (revue N5-3) ; via
#    inconnu → 400 (revue N5-4) ; CRLF params → 400 (revue N5-5)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"test\",\"lang\":\"fr\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"message\":\"x\"},\"dedupKey\":\"$marker-test\"}" "$API/send")
[ "$code" = "403" ] || fail "template test simple user : attendu 403, obtenu $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"document-shared\",\"lang\":\"fr\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"app-pirate\",\"params\":{\"docName\":\"x\",\"link\":\"https://x\",\"ttl\":\"1\"}}" "$API/send")
[ "$code" = "400" ] || fail "via non autorisé : attendu 400, obtenu $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"document-shared\",\"lang\":\"fr\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"docName\":\"x\ny\",\"link\":\"https://x\",\"ttl\":\"1\"}}" "$API/send")
[ "$code" = "400" ] || fail "params CRLF : attendu 400, obtenu $code"
echo "✓ garde-fous revue N5 : test→403, via→400, CRLF→400"

# 9) dedupKey rejoué (MÊME via) → même id + deduped:true, sans consommer
#    de fente anti-flood (revue N5-2)
replay=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"document-shared\",\"lang\":\"fr\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"e2e\",\"params\":{\"docName\":\"Replay $marker\",\"link\":\"https://e2e.local/s/$marker-re\",\"ttl\":\"2 h\"},\"dedupKey\":\"$marker-fr\"}" \
  "$API/send")
dId=$(echo "$replay" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id",""))')
dFlag=$(echo "$replay" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("deduped")).lower())')
{ [ "$dId" = "$idFr" ] && [ "$dFlag" = "true" ]; } || fail "dedup : $replay"
echo "✓ dedupKey rejoué → même id $dId + deduped:true"

# 9bis) la MÊME clé sous une AUTRE app émettrice ne collisionne PAS
#       (revue N5-1 : unicité scopée via+dedupKey)
other=$(curl -s -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"email\",\"template\":\"document-shared\",\"lang\":\"en\",\"to\":\"e2e-$marker@dev.local\",\"via\":\"identity\",\"params\":{\"docName\":\"Other $marker\",\"link\":\"https://e2e.local/s/$marker-ot\",\"ttl\":\"2 h\"},\"dedupKey\":\"$marker-fr\"}" \
  "$API/send")
oId=$(echo "$other" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id",""))')
oFlag=$(echo "$other" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d.get("deduped")).lower())')
{ [ -n "$oId" ] && [ "$oId" != "$idFr" ] && [ "$oFlag" = "false" ]; } || fail "dedup scoppé via : $other"
echo "✓ même dedupKey sous autre via → id distinct $oId (pas de collision)"

# 10) template/lang inconnus → 400 générique
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d '{"channel":"email","template":"xxx","lang":"fr","to":"e2e-x@dev.local","via":"e2e"}' "$API/send")
[ "$code" = "400" ] || fail "template inconnu : attendu 400, obtenu $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"channel\":\"sms\",\"template\":\"verify-email\",\"lang\":\"de\",\"to\":\"+33612345678\",\"via\":\"e2e\",\"params\":{\"code\":\"1\",\"link\":\"https://x\",\"ttl\":\"1\"}}" "$API/send")
[ "$code" = "400" ] || fail "lang inconnue : attendu 400, obtenu $code"
echo "✓ template/lang inconnus → 400"

# 11) anti-flood : destinataire NEUF → 5 passent (201), 6e → 429
floodTo="flood-$marker@dev.local"
onesend() {
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"channel\":\"email\",\"template\":\"verify-email\",\"lang\":\"en\",\"to\":\"$floodTo\",\"via\":\"e2e\",\"params\":{\"code\":\"F$1\",\"link\":\"https://e2e.local/f/$1\",\"ttl\":\"1 min\"}}" "$API/send"
}
for i in 1 2 3 4 5; do
  [ "$(onesend "$i")" = "201" ] || fail "flood send $i refusé — le cap doit laisser passer 5 (201)"
done
code=$(onesend 6)
[ "$code" = "429" ] || fail "6e envoi flood : attendu 429, obtenu $code"
echo "✓ anti-flood : 5 passent, 6e → 429"

# 12) audit : traces notify.*
n=$(PGPASSWORD="$(sed -n 's/^DATABASE_URL=postgresql:\/\/alveare_core_app:\([^@]*\)@.*/\1/p' "$ROOT/.env")" \
  psql -h localhost -U alveare_core_app -d alveare_core -tAc \
  "SELECT (SELECT count(*) FROM audit.events WHERE action IN ('notify.send','notify.sent','notify.failed'))
        + (SELECT count(*) FROM audit.outbox
             WHERE delivered = false AND payload->>'action' IN ('notify.send','notify.sent','notify.failed'))")
[ "$n" -ge 8 ] || fail "audit : $n traces notify seulement"
echo "$n" > /tmp/alv-e5-audit-count
echo "✓ audit : $n traces notify (events + outbox en attente)"

echo "E2E NOTIFY : OK (13 preuves)"
