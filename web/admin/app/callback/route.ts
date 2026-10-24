/**
 * web-admin — GET /callback : réception du code d'autorisation.
 * Vérifie state (anti-CSRF), échange le code (PKCE), vérifie
 * l'id_token (iss, aud, nonce, RS256 via JWKS) puis pose la session
 * chiffrée. Toute anomalie → retour accueil sans session.
 * Zone Red : revue indépendante obligatoire.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode } from '../../lib/oidc';
import { SESSION_COOKIE, decodeStash, encodeSession, sessionCookieOptions } from '../../lib/session';
import { TEMP_COOKIE } from '../login/route';
import { jwksUrl } from '../../lib/oidc';

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function jwks() {
  remoteJwks ??= createRemoteJWKSet(new URL(jwksUrl()));
  return remoteJwks;
}

function fail(req: NextRequest, reason: string) {
  console.error(`callback : ${reason}`);
  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set(TEMP_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!code || !state) return fail(req, 'code/state manquants');

  const stash = await decodeStash(req.cookies.get(TEMP_COOKIE)?.value);
  if (!stash) return fail(req, 'stash PKCE absent ou expiré');
  if (state !== stash.state) return fail(req, 'state ≠ stash (CSRF probable)');

  let access: string, refresh: string | undefined, idToken: string, expiresIn: number;
  try {
    const tokens = await exchangeCode(code, stash.verifier);
    access = tokens.access_token;
    refresh = tokens.refresh_token;
    idToken = tokens.id_token ?? '';
    expiresIn = tokens.expires_in ?? 300;
  } catch (e) {
    return fail(req, `échange de code : ${String(e)}`);
  }
  if (!idToken) return fail(req, 'id_token absent');

  try {
    const { payload } = await jwtVerify(idToken, jwks(), {
      issuer: `${process.env.KEYCLOAK_BASE_URL ?? 'http://localhost:8081'}/realms/alveare`,
      audience: 'web-admin',
      algorithms: ['RS256'],
    });
    // le nonce n'est pas une option jose standard : comparaison manuelle
    if (payload.nonce !== stash.nonce) {
      return fail(req, 'nonce ≠ stash (rejeu probable)');
    }
  } catch (e) {
    return fail(req, `id_token invalide : ${String(e)}`);
  }

  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set(
    SESSION_COOKIE,
    await encodeSession({ at: access, rt: refresh, idToken, exp }),
    sessionCookieOptions(expiresIn),
  );
  res.cookies.set(TEMP_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
