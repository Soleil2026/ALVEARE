/**
 * web-admin — proxy server-side vers le service documents (:4010).
 * Le navigateur ne connaît JAMAIS le access token : il frappe ce
 * proxy avec son cookie de session chiffré. Sur 401 POST, tentative
 * de refresh transparente (refresh_token de la session) ; échec →
 * cookie détruit, le client se reconnecte.
 * Remédiations revue : F-1 cap de taille AVANT bufferisation (la RAM
 * du front n'absorbe jamais un corps non borné) ; F-6 erreurs
 * upstream mappées en messages génériques, jamais re-passées telles
 * quelles au client.
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
/** cohérent avec la limite multer du service documents */
const MAX_BODY = 25 * 1024 * 1024;

/** libellé générique par statut — jamais le body upstream verbatim */
function mappedError(status: number): string {
  switch (status) {
    case 400:
      return 'fichier refusé (type ou taille non conformes)';
    case 403:
      return 'accès refusé';
    case 404:
      return 'document introuvable';
    case 413:
      return 'fichier trop volumineux';
    default:
      return 'documents : opération refusée';
  }
}

async function guardedJson(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'session absente' }, { status: 401 });

  const res = await fetch(`${UPSTREAM}/documents`, {
    headers: { Authorization: `Bearer ${session.at}` },
  }).catch(() => null);
  if (!res) return NextResponse.json({ error: 'documents injoignable' }, { status: 502 });
  if (!res.ok) {
    return NextResponse.json({ error: mappedError(res.status) }, { status: res.status });
  }
  const data = await guardedJson(res);
  if (!data) return NextResponse.json({ error: 'documents : réponse invalide' }, { status: 502 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const session = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'session absente' }, { status: 401 });

  // revue F-1 : cap de taille contrôlé AVANT tout buffering
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) {
    return NextResponse.json(
      { error: 'fichier trop volumineux (max 25 Mo)' },
      { status: 413 },
    );
  }

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
        const data = await guardedJson(retry);
        if (!data) {
          return NextResponse.json({ error: 'documents : réponse invalide' }, { status: 502 });
        }
        const rep = NextResponse.json(data, { status: 201 });
        rep.cookies.set(
          SESSION_COOKIE,
          await encodeSession({
            at: fresh.access_token,
            rt: fresh.refresh_token ?? session.rt,
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

  const data = await guardedJson(upstream);
  if (!data) {
    return NextResponse.json({ error: mappedError(upstream.status) }, { status: upstream.status });
  }
  return NextResponse.json(data, { status: upstream.status });
}
