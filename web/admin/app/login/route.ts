/**
 * web-admin — GET /login : démarre le flow OIDC (code + PKCE).
 * Le verifier/nonce sont mémorisés CÔTÉ SERVEUR, indexés par `state`
 * (lib/flowStore : single-use, TTL 5 min) — plus aucune donnée de
 * sécurité dans un cookie de transport. Zone Red : revue indépendante
 * obligatoire.
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildAuthorizeUrl, newCodeVerifier, newState } from '../../lib/oidc';
import { putFlow } from '../../lib/flowStore';
import { SESSION_COOKIE, TEMP_COOKIE } from '../../lib/session';

export async function GET(req: NextRequest) {
  // déjà connecté ? pas de nouveau login
  if (req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  const verifier = newCodeVerifier();
  const state = newState();
  const nonce = newState();
  putFlow(state, verifier, nonce);
  const res = NextResponse.redirect(buildAuthorizeUrl(verifier, state, nonce));
  // nettoyage d'un éventuel cookie de stash d'un déploiement antérieur
  res.cookies.set(TEMP_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
