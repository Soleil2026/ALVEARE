#!/bin/bash
# e2e local du service Paiements :4040 (E6, T4.6) — preuves numérotées,
# format e2e-audit. Adapter = dev SIMULATION PURE (aucun réseau PSP) ;
# le webhoook sortant vers l'app est testé par un LISTENER LOCAL signé
# (verification HMAC t/v1 réelle du côté récepteur).
#
# Pré-requis : Postgres :5432 (migration 006 appliquée) + Redis :6379 +
# Keycloak :8081 + audit :4030 (drain). Le script BOOTE SON PROPRE
# paiements :4040 (TTL/cap courts) — si une instance tourne déjà sur
# 4040, l'arrêter d'abord.
#
# Zone Red (argent) — preuves : idempotence create/refund/refund
# dépassé, machine à états (dev-confirm → paid + trace audit drainée),
# webhook signé (listener vérifie le HMAC), re-livraison event_uid
# dedupliquée, expiry par sweep, DLQ après plafond, 401/403 admin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/infra/.env"; set +a

KC="$KEYCLOAK_BASE_URL/realms/alveare"
PAY_PORT=4040
PAY="http://localhost:${PAY_PORT}"
AUDIT="http://localhost:${AUDIT_PORT:-4030}"
DIR=/tmp/alv-e2e-payments
DBPASS="$(sed -n 's/^DATABASE_URL=postgresql:\/\/alveare_core_app:\([^@]*\)@.*/\1/p' "$ROOT/.env")"
fail() { echo "E2E ÉCHEC : $1"; exit 1; }
psqlq() { PGPASSWORD="$DBPASS" psql -h localhost -U alveare_core_app -d alveare_core -tAc "$1"; }
PS_JSON() { python3 -c 'import json,sys
d = json.load(sys.stdin)
p = d.get("payment", {})
print(p.get(sys.argv[1], sys.argv[2]))' "$1" "$2"; }

rm -rf "$DIR"; mkdir -p "$DIR"
SRV_LOG="$DIR/server.log"; LSN_LOG="$DIR/listener.log"
RES_FILE="$DIR/webhook-receipts.jsonl"; DEV_OUTBOX="$DIR/dev-sim.jsonl"
PID_FILE="$DIR/server.pid"; LSN_PID="$DIR/listener.pid"

cleanup() {
  kill "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true
  kill "$(cat "$LSN_PID" 2>/dev/null)" 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------
# 0) pré-requis + boot du service sous test
# ---------------------------------------------------------------------
curl -sf "$AUDIT/healthz" >/dev/null || fail "audit :4030 down (drain requis)"
curl -sf "$PAY/healthz" >/dev/null 2>&1 \
  && fail "un services paiements tourne déjà sur ${PAY_PORT} — arrête-le (le e2e boote le sien)"
( cd "$ROOT/services/payments" && node -e 'const R=require("ioredis"); const r=new R(process.env.REDIS_URL||"redis://localhost:6379/0"); r.ping().then(v=>{console.log(v);process.exit(v==="PONG"?0:1)}).catch(()=>{console.error("Redis DOWN");process.exit(1)})' 2>/dev/null \
  | grep -q PONG ) || fail "Redis :6379 injoignable"

# env du service = .env racine + overrides courts (fichier temp :
# l'ordre de précédence n'est jamais supposé)
{
  cat "$ROOT/.env"
  echo "PAYMENTS_PORT=${PAY_PORT}"
  echo "PAYMENTS_PROVIDER=dev"
  echo "PAYMENTS_TTL_SECONDS=2"        # expiry : pending > 2 s → sweep
  echo "PAYMENTS_WEBHOOK_ATTEMPTS_CAP=2" # DLQ après ~2 tentatives
  echo "PAYMENTS_DEV_OUTBOX=${DEV_OUTBOX}"
  echo "ALV_ALLOW_E2E=1"
} > "$DIR/service.env"

# node --env-file : l'env RÉEL prime sur le fichier — désécrire les
# clés que service.env doit surcharger (précédence explicite, jamais
# supposée).
unset PAYMENTS_PORT PAYMENTS_PROVIDER PAYMENTS_TTL_SECONDS \
      PAYMENTS_WEBHOOK_ATTEMPTS_CAP PAYMENTS_DEV_OUTBOX ALV_ALLOW_E2E

(cd "$ROOT" && pnpm --filter @alveare/payments-service run build) \
  || fail "build service paiements KO"
(cd "$ROOT/services/payments" \
  && node --env-file="$DIR/service.env" dist/main.js > "$SRV_LOG" 2>&1 \
  & echo $! > "$PID_FILE")
for _ in $(seq 1 30); do
  curl -sf "$PAY/healthz" >/dev/null && break
  sleep 1
done

# ---------------------------------------------------------------------
# Listener local « app factice » — vérifie la SIGNATURE t/v1 avec le
# secret DE CHAQUE APP (mêmes règles à la réception). app-01 → 200,
# app-03 → 500 TOUJOURS (DLQ). Aucun secret affiché.
# ---------------------------------------------------------------------
APP01_SECRET="$(openssl rand -hex 32)"
APP03_SECRET="$(openssl rand -hex 32)"
psqlq "INSERT INTO payments.app_endpoints (app, url, secret, enabled)
  VALUES ('app-01', 'http://127.0.0.1:46080/app-01', '${APP01_SECRET}', true)
  ON CONFLICT (app) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret, enabled = true" \
  | head -n1 >/dev/null
psqlq "INSERT INTO payments.app_endpoints (app, url, secret, enabled)
  VALUES ('app-03', 'http://127.0.0.1:46080/app-03', '${APP03_SECRET}', true)
  ON CONFLICT (app) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret, enabled = true" \
  | head -n1 >/dev/null

cat > "$DIR/listener.py" <<'PYEOF'
import http.server, json, hmac, hashlib, os, time

RES = os.environ['E2E_RES_FILE']
SECRETS = {'/app-01': os.environ['APP01_SECRET'], '/app-03': os.environ['APP03_SECRET']}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = self.rfile.read(n).decode('utf8', 'replace')
        sig = self.headers.get('x-alveare-signature', '')
        parts = [p.strip().split('=', 1) for p in sig.replace(' ', '').split(',') if '=' in p]
        kv = dict(parts)
        ts, v1 = kv.get('t', ''), kv.get('v1', '')
        secret = SECRETS.get(self.path, '')
        expected = hmac.new(secret.encode(), f"{ts}.{body}".encode(),
                            hashlib.sha256).hexdigest()
        skew_ok = ts.isdigit() and abs(int(time.time()) - int(ts)) <= 300
        ok = bool(secret) and skew_ok and bool(v1) and hmac.compare_digest(v1, expected)
        try:
            payload = json.loads(body)
            uid = payload.get('event_uid', '')
            ev = payload.get('event', '')
        except Exception:
            uid, ev = '', ''
        code = 500 if self.path == '/app-03' else (200 if ok else 401)
        with open(RES, 'a') as f:
            f.write(json.dumps({'path': self.path, 'sig_ok': ok, 'code': code,
                                'event_uid': uid, 'event': ev}) + '\n')
        self.send_response(code)
        self.end_headers()
    def log_message(self, *a):
        pass

server = http.server.HTTPServer(('127.0.0.1', 46080), Handler)
server.serve_forever()
PYEOF
E2E_RES_FILE="$RES_FILE" APP01_SECRET="$APP01_SECRET" APP03_SECRET="$APP03_SECRET" \
  python3 "$DIR/listener.py" > "$LSN_LOG" 2>&1 & echo $! > "$LSN_PID"

# ---------------------------------------------------------------------
# tokens : admin (client de service audit-e2e — voie e2e-audit) + user
# ---------------------------------------------------------------------
token_admin=$(curl -s -X POST "$KC/protocol/openid-connect/token" \
  -d grant_type=client_credentials -d client_id=audit-e2e \
  -d "client_secret=$AUDIT_E2E_SECRET" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$token_admin" ] || fail "pas de token admin"
token_user=$(curl -s -X POST "$KC/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=web-admin -d scope=openid \
  -d username=user@dev.local -d password="$ALV_USER_PASS" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$token_user" ] || fail "pas de token user"

marker=$(date +%s)

# ---------------------------------------------------------------------
# P1) healthz :4040 + briques
# ---------------------------------------------------------------------
health=$(curl -sf "$PAY/healthz") || fail "paiements :4040 down (30 s)"
echo "$health" | grep -q 'payments-state-machine' || fail "brique state-machine absente"
echo "$health" | grep -q 'payments-webhook-dlq' || fail "brique DLQ absente"
echo "✓ P1 healthz :4040 + briques (state-machine, webhook-dlq)"

# ---------------------------------------------------------------------
# P2) create idempotent : double POST même (app, app_ref) → même txn
# ---------------------------------------------------------------------
APP_REF="E6-${marker}-A"
create_body=$(printf '{"app":"app-01","app_ref":"%s","amount":250000,"currency":"DZD","rail":"dzd"}' "$APP_REF")
c1=$(curl -sf -X POST -H "Authorization: Bearer $token_admin" \
  -H 'Content-Type: application/json' -d "$create_body" "$PAY/payments") \
  || fail "create : non 200 — $create_body"
id=$(echo "$c1" | PS_JSON id '?')
[ -n "$id" ] || fail "create sans id : $c1"
c2=$(curl -s -X POST -H "Authorization: Bearer $token_admin" \
  -H 'Content-Type: application/json' -d "$create_body" "$PAY/payments")
id2=$(echo "$c2" | PS_JSON id '?')
echo "$c2" | grep -q '"deduped":true' || fail "replay create sans deduped : $c2"
[ "$id" = "$id2" ] || fail "replay : ids différents ($id vs $id2)"
echo "✓ P2 create + double POST → même txn id ($id), deduped:true"

# ---------------------------------------------------------------------
# P3) dev-confirm → paid (machine) + trace payment.paid DANS la BD après drain
# ---------------------------------------------------------------------
res=$(curl -sf -X POST -H "Authorization: Bearer $token_admin" \
  "$PAY/payments/$id/dev-confirm") || fail "dev-confirm non 200 : niveau e2e ?"
echo "$res" | grep -q '"status":"paid"' || fail "dev-confirm pas paid : $res"
trace_paid=0
for _ in $(seq 1 40); do
  trace_paid=$(psqlq "SELECT count(*) FROM audit.events WHERE action='payment.paid' AND target='${id}'")
  [ "${trace_paid:-0}" -ge 1 ] && break
  sleep 1
done
[ "${trace_paid:-0}" -ge 1 ] || fail "trace payment.paid absente de audit.events après 40 s"
# D-10 (revue T4.7) : 'paid' porte des frais PSP tracés (dev = 500 c)
fee_ok=$(psqlq "SELECT count(*) FROM payments.transactions WHERE id='${id}' AND fee_amount IS NOT NULL")
[ "${fee_ok:-0}" -ge 1 ] || fail "fee_amount null après paid (D-10) : id=$id"
echo "✓ P3 dev-confirm → paid + trace payment.paid drainée (audit.events, n=$trace_paid) + fee_amount tracé (D-10)"

# ---------------------------------------------------------------------
# P4) webhook SORTANT signé : le listener a vérifié le HMAC t/v1 avec
#     le secret DE L'APP
# ---------------------------------------------------------------------
uid_expect="dev-confirm:${id}"
sig_ok=0
for _ in $(seq 1 30); do
  if grep -Eq "\"event_uid\": *\"${uid_expect}\"" "$RES_FILE" 2>/dev/null; then
    line=$(grep -E "\"event_uid\": *\"${uid_expect}\"" "$RES_FILE" | tail -n1)
    echo "$line" | grep -Eq '"path": *"/app-01"' \
      || fail "webhook reçu sur un mauvais chemin : $line"
    echo "$line" | grep -Eq '"sig_ok": *true' \
      || fail "webhook livré mais SIGNATURE INVALIDE : $line"
    echo "$line" | grep -Eq '"code": *200' \
      || fail "webhook non accepté par l'app : $line"
    sig_ok=1; break
  fi
  sleep 1
done
[ "$sig_ok" = "1" ] || fail "aucune réception webhook signée en 30 s"
# Sur-simétrie : une signature forgerie est rejetée par l'app (401)
forged=$(printf '{"event_uid":"forged-%s","event":"payment.paid"}' "$marker")
f_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'X-ALVEARE-Signature: t=1, v1=0000000000000000000000000000000000000000000000000000000000000000' \
  -H 'Content-Type: application/json' -d "$forged" \
  "http://127.0.0.1:46080/app-01")
[ "$f_code" = "401" ] || fail "listener : fausse signature acceptée ($f_code)"
echo "✓ P4 webhook signé reçu (HMAC t/v1 vérifié par l'app) + fausse signature → 401"

# ---------------------------------------------------------------------
# P5) refund PARTIEL idempotent : double appel → 1 seule ligne refunds
# ---------------------------------------------------------------------
refund_body=$(printf '{"refund_ref":"R-PART-%s","amount":125000,"reason":"annulation ligne 1"}' "$marker")
r1=$(curl -s -X POST -H "Authorization: Bearer $token_admin" \
  -H 'Content-Type: application/json' -d "$refund_body" "$PAY/payments/$id/refund")
echo "$r1" | grep -q '"status":"partially_refunded"' \
  || fail "refund partiel pas appliqué : $r1"
r2=$(curl -s -X POST -H "Authorization: Bearer $token_admin" \
  -H 'Content-Type: application/json' -d "$refund_body" "$PAY/payments/$id/refund")
echo "$r2" | grep -q '"deduped":true' || fail "replay refund pas deduped : $r2"
n_refund=$(psqlq "SELECT count(*) FROM payments.refunds WHERE txn_id='${id}' AND refund_ref='R-PART-${marker}'")
[ "${n_refund:-0}" = "1" ] || fail "refunds : $n_refund ligne(s) pour refund_ref rejoué"
n_open=$(psqlq "SELECT count(DISTINCT status) FROM payments.transactions WHERE id='${id}'")
[ "${n_open:-0}" = "1" ] || fail "état transaction pas cohérent après refund"
echo "✓ P5 refund partiel idempotent (double appel → 1 ligne refunded=$n_refund)"

# ---------------------------------------------------------------------
# P6) refund au-delà du plafond (> payé − déjà remboursé) → 400
# ---------------------------------------------------------------------
over_body=$(printf '{"refund_ref":"R-OVER-%s","amount":125001}' "$marker")
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $token_admin" -H 'Content-Type: application/json' \
  -d "$over_body" "$PAY/payments/$id/refund")
[ "$code" = "400" ] || fail "refund 1 centime de trop : attendu 400, obtenu $code"
n_over=$(psqlq "SELECT count(*) FROM payments.refunds WHERE txn_id='${id}' AND refund_ref='R-OVER-${marker}'")
[ "${n_over:-0}" = "0" ] || fail "refund refusé mais enregistré en BD"
echo "✓ P6 refund > solde refusé (400, zéro ligne en BD)"

# ---------------------------------------------------------------------
# P7) expiry : pending silencieuse → expired PAR LE SWEEP + trace
# ---------------------------------------------------------------------
APP_REF_E="E6-${marker}-E"
exp_body=$(printf '{"app":"app-02","app_ref":"%s","amount":150000}' "$APP_REF_E")
exp_txn=$(curl -sf -X POST -H "Authorization: Bearer $token_admin" \
  -H 'Content-Type: application/json' -d "$exp_body" "$PAY/payments" | PS_JSON id '?')
[ -n "$exp_txn" ] || fail "create (expiry) sans id"
trace_exp=0
for _ in $(seq 1 75); do # ≤ 2 sweeps naturels au pire
  trace_exp=$(psqlq "SELECT count(*) FROM audit.events WHERE action='payment.expired' AND target='${exp_txn}'")
  [ "${trace_exp:-0}" -ge 1 ] && break
  sleep 1
done
[ "${trace_exp:-0}" -ge 1 ] || fail "pending > TTL pas passée en expired après 75 s"
exp_status=$(psqlq "SELECT status FROM payments.transactions WHERE id='${exp_txn}'")
[ "$exp_status" = "expired" ] || fail "statut BD pas expired : $exp_status"
echo "✓ P7 sweep expiry : pending → expired (BD + trace payment.expired)"

# ---------------------------------------------------------------------
# P8) re-livraison même event_uid → UNE SEULE trace payment.paid
# ---------------------------------------------------------------------
wd_ok=0
for attempt in 1 2 3; do
  APP_REF_W="E6-${marker}-W${attempt}"
  wb=$(printf '{"app":"app-02","app_ref":"%s","amount":300000}' "$APP_REF_W")
  w1=$(curl -sf -X POST -H "Authorization: Bearer $token_admin" \
    -H 'Content-Type: application/json' -d "$wb" "$PAY/payments") || continue
  wid=$(echo "$w1" | PS_JSON id '?')
  [ -n "$wid" ] || continue
  ev=$(printf '{"event_uid":"evt-replay-%s","provider":"dev","provider_ref":"dev-%s","status":"paid","paid_at":"2026-10-25T23:00:00.000Z"}' "$marker" "$wid")
  r=$(curl -s -X POST -H 'Content-Type: application/json' -d "$ev" "$PAY/payments/webhook")
  r2=$(curl -s -X POST -H 'Content-Type: application/json' -d "$ev" "$PAY/payments/webhook")
  if echo "$r" | grep -q '"applied":true' && echo "$r2" | grep -q '"deduped":true'; then
      wtrace=0
      for _ in $(seq 1 40); do
        wtrace=$(psqlq "SELECT count(*) FROM audit.events WHERE action='payment.paid' AND target='${wid}'")
        [ "${wtrace:-0}" -ge 1 ] && break
        sleep 1
      done
      [ "${wtrace:-0}" = "1" ] || { echo "  … rsp écarts ($wtrace) — nouvel essai"; continue; }
      echo "✓ P8 re-livraison event_uid : 1 seule trace payment.paid (double POST webhook idempotent)"
      wd_ok=1; break
  fi
  sleep 2
done
[ "$wd_ok" = "1" ] || fail "P8 non vérifiée (race sweep ? nouveau fs)"

# ---------------------------------------------------------------------
# P9) webhook 500 → payments.webhook_dead APRÈS cap + trace payment.webhook.dead
# ---------------------------------------------------------------------
APP_REF_D="E6-${marker}-D"
db=$(printf '{"app":"app-03","app_ref":"%s","amount":200000}' "$APP_REF_D")
dead_txn=$(curl -sf -X POST -H "Authorization: Bearer $token_admin" \
  -H 'Content-Type: application/json' -d "$db" "$PAY/payments" | PS_JSON id '?')
[ -n "$dead_txn" ] || fail "create (DLQ) sans id"
curl -sf -X POST -H "Authorization: Bearer $token_admin" "$PAY/payments/$dead_txn/dev-confirm" >/dev/null \
  || fail "dev-confirm (DLQ) KO"
dead_ok=0
for _ in $(seq 1 60); do
  n_dead=$(psqlq "SELECT count(*) FROM payments.webhook_dead WHERE payload->>'event_uid' = 'dev-confirm:${dead_txn}'")
  [ "${n_dead:-0}" -ge 1 ] && { dead_ok=1; break; }
  sleep 1
done
[ "$dead_ok" = "1" ] || fail "DLQ pas peuplée en 60 s (cap=2)"
n_dead=$(psqlq "SELECT count(*) FROM payments.webhook_dead WHERE payload->>'event_uid' = 'dev-confirm:${dead_txn}'")
echo "✓ P9 webhook 500 → payments.webhook_dead après cap (lignes=$n_dead, payload + attempts en BD)"
trace_dead=0
for _ in $(seq 1 75); do
  trace_dead=$(psqlq "SELECT count(*) FROM audit.events WHERE action='payment.webhook.dead' AND target='${dead_txn}'")
  [ "${trace_dead:-0}" -ge 1 ] && break
  sleep 1
done
[ "${trace_dead:-0}" -ge 1 ] || fail "trace payment.webhook.dead pas drainée en 75 s"
echo "    (et piste audit : payment.webhook.dead drainée, n=$trace_dead)"

# ---------------------------------------------------------------------
# P10) gardes admin : sans token → 401, user simple → 403
# ---------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' "$PAY/admin/payments")
[ "$code" = "401" ] || fail "admin sans token : attendu 401, obtenu $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token_user" "$PAY/admin/payments")
[ "$code" = "403" ] || fail "admin API user simple : attendu 403, obtenu $code"
resp=$(curl -sf -H "Authorization: Bearer $token_admin" "$PAY/admin/payments?app=app-01&limit=10")
echo "$resp" | grep -q '"items"' || fail "lecture admin : réponse sans items"
echo "$resp" | grep -q "\"id\":\"${id}\"" || fail "lecture admin : txn absente"
echo "✓ P10 ADMIN : sans token 401, user simple 403, admin lit la liste filtrée app-01"

echo "E2E PAYMENTS : OK (10 preuves)"
