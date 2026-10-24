/**
 * @alveare/documents — URLs de partage temporaire signées (B §4.6).
 * Zone Red : revue indépendante obligatoire.
 *
 * Le token est HMAC (HS256) signé par le service avec SHARE_SIGN_KEY
 * (issue du .env, jamais en code) : { jti, did, sub, iss, exp }.
 * Révocation : lignes ShareToken BD (jti) — vérif à chaque accès.
 */

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

export const SHARE_ISSUER = 'alveare:documents';

export type ShareInfo = {
  token: string;
  jti: string;
  expiresAt: Date;
};

function secretKey(): Uint8Array {
  const key = process.env.SHARE_SIGN_KEY ?? '';
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error('SHARE_SIGN_KEY invalide (attendu : hex 64)');
  }
  return Uint8Array.from(Buffer.from(key, 'hex'));
}

/** Durée de vie d'un partage : 1 minute à 24 h, 15 min par défaut. */
export function clampTtl(ttlSeconds?: unknown): number {
  const n = typeof ttlSeconds === 'number' ? ttlSeconds : Number(ttlSeconds ?? 900);
  if (!Number.isInteger(n)) {
    throw new BadRequestException('ttl invalide (entier attendu)');
  }
  return Math.min(Math.max(n, 60), 86400);
}

export async function createShareToken(docId: string, ownerSub: string, ttlSeconds: number): Promise<ShareInfo> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const jti = randomUUID();
  const token = await new SignJWT({ did: docId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SHARE_ISSUER)
    .setSubject(ownerSub)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey());
  return { token, jti, expiresAt };
}

/** Vérifie signature + iss + exp d'un token de partage. */
export async function verifyShareToken(token: string): Promise<{ jti: string; did: string; sub: string }> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: SHARE_ISSUER,
      algorithms: ['HS256'],
    });
    if (
      typeof payload.jti !== 'string' ||
      typeof payload.did !== 'string' ||
      typeof payload.sub !== 'string'
    ) {
      throw new Error('claims manquants');
    }
    return { jti: payload.jti, did: payload.did, sub: payload.sub };
  } catch {
    throw new UnauthorizedException('lien de partage invalide ou expiré');
  }
}
