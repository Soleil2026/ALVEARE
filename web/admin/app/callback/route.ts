/**
 * web-admin — GET /callback : réception du code d'autorisation.
 * Le flux est retrouvé par `state` dans le store serveur (single-use :
 * l'entrée est consommée avant usage). Vérification de l'id_token
 * (iss, aud, RS256 via JWKS, nonce comparé manuellement — jose n'a
 * pas d'option nonce) puis pose de la session chiffrée.
 * Toute anomalie → retour accueil sans session (console serveur seul).
 * Zone Red : revue indépendante obligatoire.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode, jwksUrl, OIDC } from '../../lib/oidc';
import {
  SESSION_COOKIE,
  TEMP_COOKIE,
  encodeSession,
  sessionCookieOptions,
} from '../../lib/session';
import { takeFlow } from '../../lib/flowStore';

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

  // single-use : consommé AVANT l'échange — pas de rejeu possible
  const flow = takeFlow(state);
  if (!flow) return fail(req, 'flux PKCE inconnu, expiré ou déjà consommé');

  let access: string, refresh: string | undefined, idToken: string, expiresIn: number;
  try {
    const tokens = await exchangeCode(code, flow.verifier);
    access = tokens.access_token;
    refresh = tokens.refresh_token;
    idToken = tokens.id_token ?? '';
    expiresIn = tokens.expires_in ?? 300;
  } catch (e) {
    return fail(req, `échange de code : ${String(e)}`);
  }
  if (!idToken) return fail(req, 'id_token absent');

  try {
    // issuer unifié avec OIDC.issuer (revue : divergence JWKS/issuer)
    const { payload } = await jwtVerify(idToken, jwks(), {
      issuer: OIDC.issuer,
      audience: OIDC.clientId,
      algorithms: ['RS256'],
    });
    // le nonce n'est pas une option jose standard : comparaison manuelle
    if (payload.nonce !== flow.nonce) {
      return fail(req, 'nonce ≠ flux (rejeu probable)');
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
