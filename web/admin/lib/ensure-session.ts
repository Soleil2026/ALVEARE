/**
 * web-admin — renouvellement silencieux de session (S1, plan
 * FRONT-HARDEN, décision D-1 : refresh PAR le rt stocké, serveur
 * uniquement — jamais un token au navigateur, pas d'iframe KC).
 * Appelé par le middleware (runtime Node) ; le middleware persiste la
 * session ré-encodée (browser + downstream). Le refresh n'est tenté
 * que si l'access token approche de sa fin (RENEW_MARGIN_SEC) : dans
 * les autres cas, un simple pas de printemps sans coût.
 * Zone Red : revue indépendante obligatoire.
 */

import { refreshTokens } from './oidc';
import { decodeSession, encodeSession, type SessionClaims } from './session';

/** Si la session meurt dans moins de ce délai, on renewe. */
export const RENEW_MARGIN_SEC = 90;

export type TokenEndpointResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};
export type RefreshFn = (rt: string) => Promise<TokenEndpointResponse>;

export type Ensured =
  | { status: 'absente' }
  | { status: 'valide'; claims: SessionClaims }
  | { status: 'renewée'; claims: SessionClaims; jwe: string }
  /** refresh refusé/rendu impossible : session morte (le middleware
   * détruit le cookie ; la page affiche la reconnexion). */
  | { status: 'expirée' };

export async function ensureSession(
  jwe: string | undefined,
  refresh: RefreshFn = refreshTokens,
): Promise<Ensured> {
  const session = await decodeSession(jwe);
  if (!session) return { status: 'absente' };
  const remain = session.exp - Math.floor(Date.now() / 1000);
  if (remain > RENEW_MARGIN_SEC || !session.rt) {
    return { status: 'valide', claims: session };
  }
  try {
    const fresh = await refresh(session.rt);
    if (typeof fresh.access_token !== 'string' || fresh.access_token.length === 0) {
      return { status: 'expirée' };
    }
    const claims: SessionClaims = {
      at: fresh.access_token,
      rt: typeof fresh.refresh_token === 'string' && fresh.refresh_token.length > 0
        ? fresh.refresh_token
        : session.rt,
      exp: Math.floor(Date.now() / 1000) + (fresh.expires_in ?? 300),
    };
    // le cap 12 h de encodeSession borne la vie de la session ré-encodée
    return { status: 'renewée', claims, jwe: await encodeSession(claims) };
  } catch {
    return { status: 'expirée' };
  }
}
