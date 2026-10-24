/**
 * web-admin — GET /logout : session locale détruite + logout
 * Keycloak (l'utilisateur confirme sur la page KC).
 */

import { NextRequest, NextResponse } from 'next/server';
import { endSessionUrl } from '../../lib/oidc';
import { SESSION_COOKIE, decodeSession } from '../../lib/session';

export async function GET(req: NextRequest) {
  const session = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.redirect(endSessionUrl());
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  void session; // id_token_hint non requis pour un client public V1
  return res;
}
