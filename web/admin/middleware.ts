/**
 * web-admin — middleware de session (plan FRONT-HARDEN, S1).
 * Runtime Node (réquisition Next 15.5 STABLE — `runtime: 'nodejs'`
 * ci-dessous, plus aucun flag experimental : m-2) : jose + fetch
 * serveur disponibles. À chaque requête :
 * - absente / valide / transient (Keycloak KO) → pass sans touche
 * - renewée  → cookie ré-encodé : pour le navigateur ET les handlers
 *              en aval (documents proxy, page /)
 * - expirée  → cookie détruit ; la page / affiche la reconnexion
 * /logout est EXCLUS (m-3) : le handler y détruit la session — ne pas
 * courir le risque de deux Set-Cookie contradictoires sur l'échange.
 * Zone Red : revue indépendante obligatoire (N6 : M-1 single-flight
 * est dans lib/ensure-session.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_HOURS, sessionCookieOptions } from './lib/session';
import { ensureSession } from './lib/ensure-session';

export async function middleware(req: NextRequest) {
  const jwe = req.cookies.get(SESSION_COOKIE)?.value;
  const ensured = await ensureSession(jwe);

  if (
    ensured.status === 'valide' ||
    ensured.status === 'absente' ||
    ensured.status === 'transient' // m-1 : KC down — ne pas déloger
  ) {
    return NextResponse.next();
  }

  if (ensured.status === 'renewée') {
    // downstream : les handlers reçoivent SANS cookie périmé
    const headers = new Headers(req.headers);
    req.cookies.set(SESSION_COOKIE, ensured.jwe);
    headers.set('cookie', req.cookies.toString());
    const res = NextResponse.next({ request: { headers } });
    res.cookies.set(
      SESSION_COOKIE,
      ensured.jwe,
      sessionCookieOptions(SESSION_HOURS * 3600),
    );
    return res;
  }

  // expirée : détruire le cookie (la page n'aura pas besoin de le faire)
  const res = NextResponse.next();
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}

export const config = {
  // tout sauf les assets statiques et /logout (m-3) ; les auth routes
  // ne portent pas de session à protéger.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logout).*)'],
  runtime: 'nodejs',
};
