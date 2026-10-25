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
  /** refresh token pour prolongation (middleware — silent refresh D-1) */
  rt?: string;
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

/** Chiffre les claims en JWE (dir + A256GCM).
 * Garde-fou taille (S4) : au-delà de 3500 octets sérialisés (bien
 * avant les ~4096 fataux rejetés par les navigateurs — leçon F6),
 * ALERTE forte : une croissance de payload doit être consciente,
 * jamais silencieuse. */
export const MAX_SESSION_BYTES = 3500;

export async function encodeSession(claims: SessionClaims): Promise<string> {
  const jwe = await new EncryptJWT({ ...claims })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(Math.min(claims.exp, Date.now() / 1000 + SESSION_HOURS * 3600))
    .encrypt(sessionKey());
  if (jwe.length > MAX_SESSION_BYTES) {
    console.error(
      `session trop grande : ${jwe.length} octets (> ${MAX_SESSION_BYTES}) —` +
      ' risque de rejet navigateur (~4096, leçon F6). Payload à resserrer.',
    );
  }
  return jwe;
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
