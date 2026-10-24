/**
 * web-admin — GET /login : démarre le flow OIDC (code + PKCE).
 * Le stash {verifier, state, nonce} est chiffré dans un cookie
 * temporaire httpOnly (5 min) — rien de devinable côté client.
 * Zone Red : revue indépendante obligatoire.
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildAuthorizeUrl, newCodeVerifier, newState } from '../../lib/oidc';
import { SESSION_COOKIE, encodeStash, stashCookieOptions } from '../../lib/session';

export const TEMP_COOKIE = 'alv_login';

export async function GET(req: NextRequest) {
  // déjà connecté ? pas de nouveau login
  if (req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  const verifier = newCodeVerifier();
  const state = newState();
  const nonce = newState();
  const res = NextResponse.redirect(buildAuthorizeUrl(verifier, state, nonce));
  res.cookies.set(TEMP_COOKIE, await encodeStash({ verifier, state, nonce }), stashCookieOptions());
  return res;
}
