#!/bin/bash
# e2e frontal (F5) — FLUX CODE COMPLET sans navigateur :
#   /login → KC authorize → formulaire login → callback (échange PKCE)
#   → session chiffrée → page / (profil + rôles) → upload via proxy
#   → logout. Pré-requis : web-admin :3001, identity :4000,
#   documents :4010, Keycloak :8081.
# Note : les cookies Next sont portés EXPLICITEMENT (headers -H) —
# le jar de curl se comporte de façon non fiable sur localhost:3001
# (Set-Cookie du 307 avalé selon les sauts maison).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/infra/.env"; set +a

WEB="${WEB_URL:-http://localhost:3001}"
API="${DOCUMENTS_URL:-http://localhost:4010}"
KC="$KEYCLOAK_BASE_URL/realms/alveare"
JAR_KC="$(mktemp)"
trap 'rm -f "$JAR_KC"' EXIT
fail() { echo "E2E FRONT ÉCHEC : $1"; exit 1; }

# extrait "name=value" du header set-cookie d'un flux de headers
grabCookie() {
  grep -i "^set-cookie: $1=" | sed -e 's/^[Ss]et-[Cc]ookie: *//' -e 's/;.*//' | head -1
}

# setup : services up
curl -sf "$API/healthz" >/dev/null || fail "documents down"
curl -sf "http://localhost:4000/healthz" >/dev/null || fail "identity down"
echo "✓ services identity + documents up"

# 1) /login → 302 vers authorize avec PKCE + state + nonce
# (remédiation revue : vérifier/nonce stockés SERVEUR par state —
# plus aucune donnée de flux dans un cookie de transport)
hdrs=$(curl -s -D - -o /dev/null "$WEB/login")
loc=$(grep -i "^location:" <<<"$hdrs" | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')
echo "$loc" | grep -q "/realms/alveare/protocol/openid-connect/auth" || fail "authorize URL malformée : $loc"
echo "$loc" | grep -q "client_id=web-admin" || fail "client_id absent"
echo "$loc" | grep -q "code_challenge_method=S256" || fail "PKCE S256 absent"
echo "$loc" | grep -q "code_challenge=" || fail "code_challenge absent"
echo "$loc" | grep -q "state=" || fail "state absent"
echo "$loc" | grep -q "nonce=" || fail "nonce absent"
grep -i "^set-cookie:" <<<"$hdrs" | grep -q "alv_login=;" || fail "l'ancien cookie de stash devrait être effacé"
echo "✓ /login → authorize (PKCE S256 + state + nonce) + flux stocké serveur"

# 2) authentification : le formulaire Keycloak rempli en curl
page=$(curl -s -b "$JAR_KC" -c "$JAR_KC" -L "$loc")
action=$(echo "$page" | sed -n 's/.*action="\([^"]*\)".*/\1/p' | head -1 | sed 's/&amp;/\&/g')
[ -n "$action" ] || fail "formulaire login introuvable"
case "$action" in
  http*) : ;;
  /realms*) action="$KEYCLOAK_BASE_URL$action" ;;
  *) fail "action formulaire inattendue : $action" ;;
esac
redir=$(curl -s -b "$JAR_KC" -c "$JAR_KC" -o /dev/null -w '%{redirect_url}' \
  -d "username=user@dev.local" -d "password=$ALV_USER_PASS" -d "credentialId=" "$action")
[ -n "$redir" ] || fail "soumission login : pas de redirection"
echo "$redir" | grep -q "$WEB/callback" || fail "retour callback inattendu : $redir"
echo "$redir" | grep -q "code=" || fail "code absent du retour"
echo "$redir" | grep -q "state=" || fail "state absent du retour"
echo "✓ login KC → callback avec code+state"

# 3) le callback échange le code (PKCE), pose la session chiffrée
# (le flux est trouvé par `state` côté serveur — aucun cookie requis)
cbHeaders=$(curl -s -D - -o /dev/null "$redir")
session=$(grep -i "^set-cookie:" <<<"$cbHeaders" | grabCookie alv_session)
echo "$session" | grep -q "^alv_session=ey" || fail "session chiffrée non posée : ${session:0:40}"
final=$(curl -s -H "Cookie: $session" "$WEB/")
grep -q "user@dev.local" <<<"$final" || fail "page / n'affiche pas le profil"
echo "✓ callback (PKCE vérifié) → session JWE → page / : profil visible"

# 4) upload d'un PDF via le PROXY /api/documents (cookie session)
printf '%%PDF-1.4\n1 0 obj\nendobj\n%%%%EOF\n' > /tmp/alveare-front-e2e.pdf
doc=$(curl -s -H "Cookie: $session" -F "file=@/tmp/alveare-front-e2e.pdf;type=application/pdf" "$WEB/api/documents")
docName=$(echo "$doc" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("fileName",""))' 2>/dev/null || echo "")
[ -n "$docName" ] || fail "upload proxy raté : $doc"
echo "✓ upload via proxy (server-side, token jamais au navigateur)"

# 5) la page confirme le document déposé ; token ABSENT du HTML
liste=$(curl -s -H "Cookie: $session" "$WEB/")
grep -q "$docName" <<<"$liste" || fail "liste documents sans le fichier déposé"
jwtCount=$(echo "$liste" | grep -c "eyJ") || true
[ "$jwtCount" = "0" ] || fail "token JWT VISIBLE dans le HTML client"
echo "✓ document listé + aucun token exposé au client"

# 6) S1 : silent refresh par le MIDDLEWARE — colis : JWE forgé avec
#    le VRAI at/rt de Keycloak, mais une at mourante (exp dans 10 s).
#    Attendu : middleware → refresh réellement tenté auprès de KC →
#    cookie de session RÉ-ENCODÉ (≠ celui envoyé) et la page /
#    fonctionne avec le NOUVEAU at (profil visible).
tok=$(curl -sf "$KC/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=web-admin -d scope=openid \
  -d username=user@dev.local -d password="$ALV_USER_PASS")
at=$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' <<<"$tok")
rt=$(sed -n 's/.*"refresh_token":"\([^"]*\)".*/\1/p' <<<"$tok")
[ -n "$at" ] && [ -n "$rt" ] || fail "ROPC : tokens non obtenus"
handler=$(cd "$ROOT/web/admin" && AT="$at" RT="$rt" node --input-type=module -e '
import { EncryptJWT } from "jose";
const key = Uint8Array.from(Buffer.from(process.env.SESSION_KEY, "hex"));
const jwe = await new EncryptJWT({
  at: process.env.AT, rt: process.env.RT,
  exp: Math.floor(Date.now() / 1000) + 10,
})
  .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
  .setIssuedAt()
  .setExpirationTime(Math.floor(Date.now() / 1000) + 10)
  .encrypt(key);
console.log(jwe);
' 2>/dev/null) || fail "forge JWE (node+jose) échouée"
renewed=$(curl -s -D - -o /tmp/page-s1.html -H "Cookie: alv_session=$handler" "$WEB/")
grep -i "^set-cookie: alv_session=ey" <<<"$renewed" >/dev/null \
  || fail "S1 : le middleware n'a PAS ré-encodé le cookie expirant"
grep -q "user@dev.local" /tmp/page-s1.html \
  || fail "S1 : page / KO après renew (nouvel at non fonctionnel)"
echo "✓ S1 : JWE à at mourant → middleware ré-encode cookie + nouvel at fonctionnel"

# 7) S1 suite : refresh REFUSÉ par KC (rt invalide) → cookie DÉTRUIT
    # (le middleware classe invalid_grant en mort de session)
dying=$(cd "$ROOT/web/admin" && node --input-type=module -e '
import { EncryptJWT } from "jose";
const key = Uint8Array.from(Buffer.from(process.env.SESSION_KEY, "hex"));
const jwe = await new EncryptJWT({
  at: "AT_MORT", rt: "RT_INVALIDE_PAR_DESIGN",
  exp: Math.floor(Date.now() / 1000) + 10,
})
  .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
  .setIssuedAt()
  .setExpirationTime(Math.floor(Date.now() / 1000) + 10)
  .encrypt(key);
console.log(jwe);
' 2>/dev/null) || fail "forge JWE (2) échouée"
killed=$(curl -s -D - -o /dev/null -H "Cookie: alv_session=$dying" "$WEB/")
grep -i '^set-cookie: alv_session=;' <<<"$killed" >/dev/null \
  || fail "S1 : invalid_grant devrait DÉTRUIRE le cookie, obtenu : $(grep -i '^set-cookie' <<<"$killed" | head -1)"
echo "✓ S1 : rt invalide → 'expirée' → cookie de session détruit par le middleware"

# 8) GET /logout → 405 (S2 : plus de logout cliquable) + session intacte
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $session" "$WEB/logout")
[ "$code" = "405" ] || fail "GET /logout : attendu 405, obtenu $code"
apres=$(curl -s -H "Cookie: $session" "$WEB/")
grep -q "user@dev.local" <<<"$apres" || fail "405 logout : la session devrait rester intacte"
echo "✓ GET /logout → 405, session intacte"

# 7) POST /logout SANS Origin → 403 (anti-CSRF) + session intacte
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $session" "$WEB/logout")
[ "$code" = "403" ] || fail "POST /logout sans origin : attendu 403, obtenu $code"
echo "✓ POST /logout sans Origin → 403"

# 8) POST /logout AVEC Origin propre → 302 KC logout + cookie détruit
lh=$(curl -s -D - -o /dev/null -X POST -H "Cookie: $session" -H "Origin: ${WEB}" "$WEB/logout" \
  | grep -i "^location:" | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')
echo "$lh" | grep -q "/realms/alveare/protocol/openid-connect/logout" \
  || fail "logout attendu vers KC, obtenu : $lh"
grep -i "^set-cookie:" <<<"$(curl -s -D - -o /dev/null -X POST -H "Cookie: $session" -H "Origin: ${WEB}" "$WEB/logout")" \
  | grep -q 'alv_session=;' || fail "le cookie de session devrait être détruit"
echo "✓ POST /logout (Origin ok) → KC end-session + session détruite"

# 9) F-9 : callback depuis un host étranger → refus, SESSION non posée
fh=$(curl -s -D - -o /dev/null "http://127.0.0.1:3001/callback?code=x&state=y")
loc3=$(grep -i "^location:" <<<"$fh" | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')
echo "$loc3" | grep -q ':3001/$' || fail "callback host étranger : attendu / sans session, obtenu $loc3"
grep -i "^set-cookie:" <<<"$fh" | grep -q "alv_session=ey" \
  && fail "callback host étranger ne doit PAS poser de session" || true
echo "✓ /callback host étranger (127.0.0.1) → refus, aucune session"

echo "E2E FRONT : OK (11 preuves)"
