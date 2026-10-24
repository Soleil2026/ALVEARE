/*
 * Tests du paquet @alveare/auth (zone Red).
 * Simule un Keycloak local : RSA + JWKS en mémoire via jose.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { UnauthorizedException } from '@nestjs/common';
import { isAdminEffective, verifyToken, ISSUER, type TokenUser } from '../src';

let signKey: Uint8Array | KeyLike;
type KeyLike = Parameters<typeof SignJWT>[1];
let localJwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  signKey = privateKey as KeyLike & { type: 'private' };
  const jwk = await exportJWK(publicKey);
  localJwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', kid: 'test-1', use: 'sig' }] });
});

async function sign(claims: Record<string, unknown>, opts: { exp?: string } = {}) {
  return new SignJWT({ scope: 'openid e2e', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setSubject('sub-user-1')
    .setExpirationTime(opts.exp ?? '5m')
    .sign(signKey);
}

const base = { azp: 'web-admin' };

describe('verifyToken', () => {
  it('accepte un token conforme (signature, iss, exp, azp)', async () => {
    const token = await sign({ ...base, realm_access: { roles: ['admin'] }, email: 'a@b.c' });
    const user: TokenUser = await verifyToken(token, { jwks: localJwks });
    expect(user.sub).toBe('sub-user-1');
    expect(user.email).toBe('a@b.c');
    expect(user.realmRoles).toEqual(['admin']);
  });

  it('rejette un token sans azp', async () => {
    const token = await sign({ realm_access: { roles: [] } });
    await expect(verifyToken(token, { jwks: localJwks })).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un azp de client inconnu', async () => {
    const token = await sign({ ...base, azp: 'app-malveillante' });
    await expect(verifyToken(token, { jwks: localJwks })).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un issuer différent', async () => {
    const token = await new SignJWT(base)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
      .setIssuer('http://pirate.local/realms/x')
      .setSubject('sub-user-1')
      .setExpirationTime('5m')
      .sign(signKey);
    await expect(verifyToken(token, { jwks: localJwks })).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un token expiré', async () => {
    const token = await sign(base, { exp: '-5m' });
    await expect(verifyToken(token, { jwks: localJwks })).rejects.toThrow(UnauthorizedException);
  });

  it('rejette une signature inconnue', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
    const token = await new SignJWT(base)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setSubject('sub-user-1')
      .setExpirationTime('5m')
      .sign(otherKey as Parameters<typeof SignJWT>[1]);
    await expect(verifyToken(token, { jwks: localJwks })).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un token sans claim scope (un ID token par ex.)', async () => {
    const token = await new SignJWT({ ...base })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setSubject('sub-user-1')
      .setExpirationTime('5m')
      .sign(signKey);
    await expect(verifyToken(token, { jwks: localJwks })).rejects.toThrow('access token requis');
  });

  it('rejette un token sans sub', async () => {
    const token = await new SignJWT({ ...base, scope: 'openid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setSubject('')
      .setExpirationTime('5m')
      .sign(signKey);
    await expect(verifyToken(token, { jwks: localJwks })).rejects.toThrow('sujet manquant');
  });

  it('rejette une alg différente de RS256 (HS256 signé puis vérifié contre le JWKS RSA)', async () => {
    const token = await new SignJWT({ ...base, scope: 'openid' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setSubject('sub-user-1')
      .setExpirationTime('5m')
      .setIssuedAt()
      .sign(new TextEncoder().encode('secret-hmac-inconnu'));
    await expect(verifyToken(token, { jwks: localJwks })).rejects.toThrow(UnauthorizedException);
  });
});

describe('isAdminEffective', () => {
  const realmAdmin: TokenUser = { sub: 'u', realmRoles: ['admin'] };
  const simple: TokenUser = { sub: 'u', realmRoles: [] };

  it('reconnaît le rôle realm admin', () => {
    expect(isAdminEffective(realmAdmin)).toBe(true);
  });

  it('reconnaît un grant admin posé en BD sur l\'app', () => {
    expect(isAdminEffective(simple, 'admin')).toBe(true);
  });

  it('refuse sans rôle ni grant', () => {
    expect(isAdminEffective(simple, 'utilisateur')).toBe(false);
    expect(isAdminEffective(simple)).toBe(false);
  });

  it('un grant utilisateur ne donne pas le pouvoir admin (B §2.4)', () => {
    expect(isAdminEffective(simple, 'gestionnaire')).toBe(false);
  });
});

