#!/bin/bash
# demo-session.sh — bake une session web-admin (user@dev.local) et
# imprime la VALEUR du cookie alv_session à coller dans le navigateur.
# Dev uniquement : suppose :3001 + :4000 + :4010 + KC :8081 up.
# Usage : bash scripts/demo-session.sh
# (s'appuie sur le même flux éprouvé que scripts/e2e-front.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; . "$ROOT/infra/.env"; set +a

WEB="${WEB_URL:-http://localhost:3001}"
API="${DOCUMENTS_URL:-http://localhost:4010}"
JAR_KC="$(mktemp)"
trap 'rm -f "$JAR_KC"' EXIT
grabCookie() {
  grep -i "^set-cookie: $1=" | sed -e 's/^[Ss]et-[Cc]ookie: *//' -e 's/;.*//' | head -1
}

curl -sf http://localhost:4000/healthz >/dev/null
curl -sf "$API/healthz" >/dev/null

hdrs=$(curl -s -D - -o /dev/null "$WEB/login")
unset stash
stash=""
loc=$(grep -i "^location:" <<<"$hdrs" | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')

page=$(curl -s -b "$JAR_KC" -c "$JAR_KC" -L "$loc")
action=$(echo "$page" | sed -n 's/.*action="\([^"]*\)".*/\1/p' | head -1 | sed 's/&amp;/\&/g')
case "$action" in
  http*) : ;;
  /realms*) action="$KEYCLOAK_BASE_URL$action" ;;
  *) echo "ERREUR : formulaire login introuvable" >&2; exit 1 ;;
esac
redir=$(curl -s -b "$JAR_KC" -c "$JAR_KC" -o /dev/null -w '%{redirect_url}' \
  -d "username=user@dev.local" -d "password=$ALV_USER_PASS" -d "credentialId=" "$action")

cbHeaders=$(curl -s -D - -o /dev/null -H "Cookie: ${stash:-}" "$redir")
session=$(grep -i "^set-cookie:" <<<"$cbHeaders" | grabCookie alv_session)
[ -n "$session" ] || { echo "ERREUR : session non posée (voir /tmp/alv-web-prod.log)" >&2; exit 1; }

# n'imprime QUE la valeur (sans le nom) pour un collage direct
echo "${session#alv_session=}"
