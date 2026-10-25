/**
 * web-admin — POST /logout (S2, plan FRONT-HARDEN, D-2) : la
 * déconnexion n'est plus un GET cliquable. Refus 405 sur GET ;
 * vérification Origin/Referer (même host de déploiement) — un POST
 * forgeré cross-site est refusé. La session locale est détruite puis
 * redirection vers le logout Keycloak (confirmation côté KC).
 * Un CSRF token complet arrive avec les mutations métier (consigné).
 * Zone Red : revue indépendante obligatoire.
 */

import { NextRequest, NextResponse } from 'next/server';
import { OIDC, endSessionUrl } from '../../lib/oidc';
import { SESSION_COOKIE } from '../../lib/session';

function sameDeploymentHost(candidate: string | undefined, host: string): boolean {
  if (!candidate) return false;
  try {
    return new URL(candidate).host === host;
  } catch {
    return false;
  }
}

export async function GET() {
  return NextResponse.json({ error: 'méthode interdite' }, { status: 405 });
}

export async function POST(req: NextRequest) {
  const host = req.nextUrl.host;
  const origin = req.headers.get('origin') ?? undefined;
  const referer = req.headers.get('referer') ?? undefined;
  if (!sameDeploymentHost(origin, host) && !sameDeploymentHost(referer, host)) {
    return NextResponse.json({ error: 'origine refusée' }, { status: 403 });
  }
  const res = NextResponse.redirect(endSessionUrl());
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  console.log('logout : session locale détruite →', OIDC.issuer);
  return res;
}
