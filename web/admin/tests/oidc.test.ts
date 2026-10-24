/*
 * Tests helpers OIDC (zone Red) — PKCE RFC 7636 (vecteur officiel
 * de l'Appendice B), construction authorize URL.
 */

import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, codeChallenge, newCodeVerifier, newState } from '../lib/oidc';

describe('codeChallenge (PKCE S256)', () => {
  it('match le vecteur officiel RFC 7636 Appendix B', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(codeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('verifier généré : 43-128 chars base64url sans padding', () => {
    const v = newCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('porte client_id, PKCE S256, state et nonce distincts', () => {
    const nonce = newState();
    const url = new URL(buildAuthorizeUrl(newCodeVerifier(), 'STATE123', nonce));
    expect(url.searchParams.get('client_id')).toBe('web-admin');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE123');
    expect(url.searchParams.get('nonce')).toBe(nonce);
    expect(url.pathname).toContain('/realms/alveare/');
  });

  it('deux appels produisent des challenges distincts', () => {
    const a = new URL(buildAuthorizeUrl(newCodeVerifier(), 's1', 'n1'));
    const b = new URL(buildAuthorizeUrl(newCodeVerifier(), 's2', 'n2'));
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'));
  });
});
