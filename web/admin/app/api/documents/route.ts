/**
 * web-admin — proxy server-side vers le service documents (:4010).
 * Le navigateur ne connaît JAMAIS le access token : il frappe ce
 * proxy avec son cookie de session chiffré. Sur 401, tentative de
 * refresh transparente (refresh_token de la session) ; échec →
 * cookie détruit, le client se reconnecte.
 * Zone Red : revue indépendante obligatoire.
 */

import { NextRequest, NextResponse } from 'next/server';
import { refreshTokens } from '../../../lib/oidc';
import {
  SESSION_COOKIE,
  decodeSession,
  encodeSession,
  sessionCookieOptions,
} from '../../../lib/session';

const UPSTREAM = process.env.DOCUMENTS_URL ?? 'http://localhost:4010';

export async function GET(req: NextRequest) {
  const session = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'session absente' }, { status: 401 });
  const res = await fetch(`${UPSTREAM}/documents`, {
    headers: { Authorization: `Bearer ${session.at}` },
  });
  if (!res.ok) {
    return NextResponse.json({ error: `documents : ${res.status}` }, { status: res.status });
  }
  return NextResponse.json(await res.json());
}

export async function POST(req: NextRequest) {
  const session = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'session absente' }, { status: 401 });

  const form = await req.formData();
  const upstream = await fetch(`${UPSTREAM}/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.at}` },
    body: form,
  }).catch(() => null);
  if (!upstream) return NextResponse.json({ error: 'documents injoignable' }, { status: 502 });

  // 401 → une tentative de refresh, puis re-jeu de la requête
  if (upstream.status === 401 && session.rt) {
    try {
      const fresh = await refreshTokens(session.rt);
      const exp = Math.floor(Date.now() / 1000) + (fresh.expires_in ?? 300);
      const retry = await fetch(`${UPSTREAM}/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh.access_token}` },
        body: form,
      });
      if (retry.ok) {
        const rep = NextResponse.json(await retry.json(), { status: 201 });
        rep.cookies.set(
          SESSION_COOKIE,
          await encodeSession({
            at: fresh.access_token,
            rt: fresh.refresh_token ?? session.rt,
            idToken: session.idToken ?? '',
            exp,
          }),
          sessionCookieOptions(fresh.expires_in ?? 300),
        );
        return rep;
      }
    } catch {
      // refresh refusé → session détruite plus bas
    }
    const dead = NextResponse.json(
      { error: 'session expirée, reconnectez-vous' },
      { status: 401 },
    );
    dead.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
    return dead;
  }

  const rep = NextResponse.json(await upstream.json(), { status: upstream.status });
  return rep;
}
