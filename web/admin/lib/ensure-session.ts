/**
 * web-admin — renouvellement silencieux de session (S1, plan
 * FRONT-HARDEN, décision D-1 : refresh PAR le rt stocké, serveur
 * uniquement — jamais un token au navigateur, pas d'iframe KC).
 * Appelé par le middleware (runtime Node) ; le middleware persiste la
 * session ré-encodée (browser + downstream).
 *
 * Zone Red — revue N6 (M-1) :
 * - SINGLE-FLIGHT : un refresh à la fois PAR cookie — n requêtes
 *   parallèles partagent le MÊME promesse de renouvellement (le
 *   middleware tourne par requête).
 * - ADOPTION : une requête concurrente qui arrive APRÈS un
 *   renouvellement réussi adopte le résultat frais (TTL court) —
 *   la course ne déconnecte pas l'utilisateur.
 * - CLASSIFICATION : Keycloak down (5xx/réseau) = 'transient' — le
 *   middleware ne détruit PAS le cookie (seul un 4xx invalid_grant est
 *   une mort ; sinon une panne KC de 2 min délogerait tout le monde).
 */

import { createHash } from 'node:crypto';
import { RefreshTransientError, refreshTokens as defaultRefresh } from './oidc';
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
  /** Keycloak indisponible (pas une mort) : ne pas détruire le cookie */
  | { status: 'transient'; claims: SessionClaims }
  /** refresh refusé (invalid_grant) : session morte. */
  | { status: 'expirée' };

/** internes de course — purgés par resetEnsureState (tests, hot-reload) */
const inFlight = new Map<string, Promise<Ensured>>();
const recent = new Map<string, { ts: number; result: Ensured }>();
/** TTL d'adoption d'un renouvellement fraîchement réussi (M-1). */
export const ADOPTION_TTL_MS = 5_000;

function keyOf(jwe: string): string {
  return createHash('sha256').update(jwe).digest('hex');
}

/** harnais de test / hot-reload : purge des courses mémorisées. */
export function resetEnsureState(): void {
  inFlight.clear();
  recent.clear();
}

export async function ensureSession(
  jwe: string | undefined,
  refresh: RefreshFn = defaultRefresh,
): Promise<Ensured> {
  const session = await decodeSession(jwe);
  if (!session) return { status: 'absente' };
  const remain = session.exp - Math.floor(Date.now() / 1000);
  if (remain > RENEW_MARGIN_SEC || !session.rt) {
    return { status: 'valide', claims: session };
  }

  // M-1 : un renouvellement tout frais (course gagnée par un pair) ?
  const key = keyOf(jwe as string);
  const hit = recent.get(key);
  if (hit && Date.now() - hit.ts < ADOPTION_TTL_MS) {
    return hit.result;
  }
  // M-1 : un refresh déjà en vol pour ce même cookie ?
  const pending = inFlight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<Ensured> => {
    try {
      const fresh = await refresh(session.rt as string);
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
      const result: Ensured = {
        status: 'renewée',
        claims,
        jwe: await encodeSession(claims),
      };
      recent.set(key, { ts: Date.now(), result });
      return result;
    } catch (e) {
      // m-1 : 5xx/réseau KO ≠ mort ; seule la 4xx (invalid_grant) tue
      if (e instanceof RefreshTransientError) {
        return { status: 'transient', claims: session };
      }
      return { status: 'expirée' };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}
