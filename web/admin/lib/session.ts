/**
 * web-admin — session serveur chiffrée (JWE A256GCM).
 * Zone Red : la clé jamais côté JS ; token jamais lisible navigateur.
 */

import {
  EncryptJWT,
  jwtDecrypt,
} from 'jose';
import type { NextResponse } from 'next/server';

export type SessionClaims = {
  /** access token Keycloak (server-side uniquement) */
  at: string;
  /** refresh token pour prolongation (route proxy) */
  rt?: string;
  idToken?: string;
  exp: number;
};

export const SESSION_COOKIE = 'alv_session';
/** Ancien cookie de transport du stash PKCE — garder le nom pour le nettoyage. */
export const TEMP_COOKIE = 'alv_login';
/** Plafond de vie d'une session (revue F-3 : maxAge cookie aligné). */
export const SESSION_HOURS = 12;

function sessionKey(): Uint8Array {
  const hex = process.env.SESSION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('SESSION_KEY invalide (attendu : hex 64)');
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Chiffre les claims en JWE (dir + A256GCM). */
export async function encodeSession(claims: SessionClaims): Promise<string> {
  return new EncryptJWT({ ...claims })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(Math.min(claims.exp, Date.now() / 1000 + SESSION_HOURS * 3600))
    .encrypt(sessionKey());
}

/** Déchiffre ; null si falsifié/obsolète (jamais d'exception au client). */
export async function decodeSession(jwe: string | undefined): Promise<SessionClaims | null> {
  if (!jwe) return null;
  try {
    const { payload } = await jwtDecrypt(jwe, sessionKey());
    if (
      typeof payload.at !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    return {
      at: payload.at,
      rt: typeof payload.rt === 'string' ? payload.rt : undefined,
      idToken: typeof payload.idToken === 'string' ? payload.idToken : undefined,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

const baseCookie = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  // revue F-2 : plus de flag codé en dur — le reverse-proxy de prod
  // pose COOKIE_SECURE=true ; dev local http://localhost → false
  // (Safari refuse un cookie Secure sur du http simple).
  secure: process.env.COOKIE_SECURE === 'true',
};

export function sessionCookieOptions(maxAgeSeconds: number) {
  return { ...baseCookie, maxAge: maxAgeSeconds };
}
