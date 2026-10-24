/**
 * web-admin — flow OIDC Authorization Code + PKCE (RFC 7636).
 * Zone Red : revue indépendante obligatoire.
 * Le backend Keycloak : realm `alveare`, client public `web-admin`.
 */

import { createHash, randomBytes } from 'node:crypto';

export const OIDC = {
  baseUrl: process.env.KEYCLOAK_BASE_URL ?? 'http://localhost:8081',
  issuer: process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8081/realms/alveare',
  clientId: 'web-admin',
  redirectUri: process.env.REDIRECT_URI ?? 'http://localhost:3001/callback',
};

export function authorizeUrl(): string {
  return `${OIDC.baseUrl}/realms/alveare/protocol/openid-connect/auth`;
}

export function tokenUrl(): string {
  return `${OIDC.baseUrl}/realms/alveare/protocol/openid-connect/token`;
}

export function endSessionUrl(): string {
  return `${OIDC.baseUrl}/realms/alveare/protocol/openid-connect/logout`;
}

export function jwksUrl(): string {
  return `${OIDC.issuer}/protocol/openid-connect/certs`;
}

/** vérifier : 43-128 caractères base64url sans padding (RFC 7636 §4.1) */
export function newCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

/** challenge S256 : BASE64URL(SHA256(verifier)) sans padding (§4.2) */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** state/nonce anti-rejeu/csrf */
export function newState(): string {
  return randomBytes(16).toString('base64url');
}

/** URL d'autorisation complète (challenges + state + nonce injectés). */
export function buildAuthorizeUrl(verifier: string, state: string, nonce: string): string {
  const url = new URL(authorizeUrl());
  url.searchParams.set('client_id', OIDC.clientId);
  url.searchParams.set('redirect_uri', OIDC.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('code_challenge', codeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
};

/** Échange code ↔ tokens (public client, no secret — PKCE fait foi). */
export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OIDC.clientId,
      redirect_uri: OIDC.redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`échange de code refusé (${res.status})`);
  }
  return (await res.json()) as TokenResponse;
}

/** Refresh grant (public client). */
export async function refreshTokens(
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OIDC.clientId,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error('refresh refusé');
  }
  return (await res.json()) as TokenResponse;
}
