/**
 * @alveare/auth — validation des tokens OIDC Keycloak.
 * Paquet mutualisé : unique source de vérité du vérificateur JWT,
 * consommé par services/identity ET services/documents.
 * Zone Red : revue indépendante obligatoire (AGENTS.md / revue-criticite).
 */

import {
  UnauthorizedException,
} from '@nestjs/common';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import type { Request } from 'express';

export const ISSUER = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8081/realms/alveare';
export const JWKS_URL = `${ISSUER}/protocol/openid-connect/certs`;

/** JWKS remote UNIQUE (singleton) : laisse jose gérer son cache
 * et son rafraîchissement de clés (revue E2 #10). */
let sharedRemoteJwks: JWTVerifyGetKey | undefined;
function defaultJwks(): JWTVerifyGetKey {
  sharedRemoteJwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  return sharedRemoteJwks;
}

/** clients autorisés à émettre des tokens acceptés par ce service */
export const ALLOWED_AZP: ReadonlySet<string> = new Set(['web-admin', 'identity-api']);

export type TokenUser = {
  sub: string;
  email?: string;
  realmRoles: string[];
};

export type VerifyOptions = {
  /** injectable pour tests unitaires (jose.createLocalJWKSet) */
  jwks?: JWTVerifyGetKey;
};

/**
 * Validation d'un access token Keycloak : signature, issuer, exp, azp.
 * Alg épinglée RS256 (anti confusia-de-clé) ; un access token KC
 * porte TOUJOURS un claim `scope` (un ID token ne l'a pas) — ce
 * discriminateur rejouable comme access token est rejeté ici
 * (condition de revue #1). aud strict arrive avec le mapper dédié.
 */
export async function verifyToken(
  token: string,
  opts: VerifyOptions = {},
): Promise<TokenUser> {
  const jwks = opts.jwks ?? defaultJwks();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      algorithms: ['RS256'],
    }));
  } catch {
    throw new UnauthorizedException('token invalide');
  }
  if (typeof payload.scope !== 'string' || payload.scope.length === 0) {
    throw new UnauthorizedException('access token requis');
  }
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
  if (!azp || !ALLOWED_AZP.has(azp)) {
    throw new UnauthorizedException('client non autorisé');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new UnauthorizedException('sujet manquant');
  }
  const realm = payload.realm_access as { roles?: unknown } | undefined;
  const realmRoles = Array.isArray(realm?.roles)
    ? realm.roles.filter((r): r is string => typeof r === 'string')
    : [];
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    realmRoles,
  };
}

/**
 * Décision admin effective : rôle realm 'admin' OU grant 'admin'
 * posé en BD sur l'app demandée — B §2.4 (compte global ≠ accès
 * automatique; le realm ne suffit pas pour une app).
 */
export function isAdminEffective(user: TokenUser, appGrantRole?: string | null): boolean {
  if (user.realmRoles.includes('admin')) return true;
  return appGrantRole === 'admin';
}

/** Extracteur du user à partir du header Authorization. */
export async function requireToken(
  req: Request,
  verify: VerifyOptions = {},
): Promise<TokenUser> {
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new UnauthorizedException('token manquant');
  return verifyToken(token, verify);
}
