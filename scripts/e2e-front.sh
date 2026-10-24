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

# 6) logout → 302 KC logout + session détruite
loc2=$(curl -s -D - -o /dev/null -H "Cookie: $session" "$WEB/logout" \
  | grep -i "^location:" | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')
echo "$loc2" | grep -q "/realms/alveare/protocol/openid-connect/logout" \
  || fail "logout attendu vers KC, obtenu : $loc2"
apres=$(curl -s "$WEB/")
grep -q "Se connecter" <<<"$apres" || fail "après logout, page attendue anonyme"
echo "✓ logout → page anonyme de nouveau"

echo "E2E FRONT : OK (6 preuves)"
