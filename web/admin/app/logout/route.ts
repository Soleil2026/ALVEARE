/**
 * web-admin — GET /logout : session locale détruite + logout
 * Keycloak (l'utilisateur confirme sur la page KC).
 * (revue : la session n'est plus décodée ici — inutile pour un
 * client public V1 ; passage en POST en backlog.)
 */

import { NextResponse } from 'next/server';
import { endSessionUrl } from '../../lib/oidc';
import { SESSION_COOKIE } from '../../lib/session';

export async function GET() {
  const res = NextResponse.redirect(endSessionUrl());
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
