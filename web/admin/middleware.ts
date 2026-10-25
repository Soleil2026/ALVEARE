/**
 * web-admin — middleware de session (plan FRONT-HARDEN, S1).
 * Runtime Node (experimental.nodeMiddleware) : jose + fetch serveur
 * disponibles. À chaque requête, la session est décryptée une fois :
 * - absente       → pass (pages publiques gèrent l'anonyme)
 * - valide/saine  → pass (pas de coût)
 * - renewée       → cookie de session ré-encodé : pour le navigateur
 *                   ET pour les handlers en aval (documents proxy, page /)
 * - expirée       → cookie détruit ; la page / affiche la reconnexion
 * Zone Red : revue indépendante obligatoire.
 */

import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_HOURS, sessionCookieOptions } from './lib/session';
import { ensureSession } from './lib/ensure-session';

export async function middleware(req: NextRequest) {
  const jwe = req.cookies.get(SESSION_COOKIE)?.value;
  const ensured = await ensureSession(jwe);

  if (ensured.status === 'valide' || ensured.status === 'absente') {
    return NextResponse.next();
  }

  if (ensured.status === 'renewée') {
    // downstream : les handlers reçus SANS cookie périmé
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
  // tout sauf les assets statiques ; login/callback/logout sont routés
  // dedans mais ne portent pas de session à protéger.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs',
};
