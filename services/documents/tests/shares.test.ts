/*
 * Tests des tokens de partage HMAC (zone Red).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { clampTtl, createShareToken, verifyShareToken } from '../src/shares';

const HEX64 = 'f'.repeat(64);

beforeAll(() => {
  process.env.SHARE_SIGN_KEY = HEX64;
});

describe('createShareToken / verifyShareToken', () => {
  it('un token créé se vérifie (jti, doc, sub)', async () => {
    const s = await createShareToken('42', 'sub-user-1', 900);
    const v = await verifyShareToken(s.token);
    expect(v.jti).toBe(s.jti);
    expect(v.did).toBe('42');
    expect(v.sub).toBe('sub-user-1');
    expect(s.jti).toMatch(/[0-9a-f-]{36}/);
  });

  it('un token signé avec une autre clé est rejeté', async () => {
    const s = await createShareToken('42', 'sub', 900);
    process.env.SHARE_SIGN_KEY = 'a'.repeat(64);
    await expect(verifyShareToken(s.token)).rejects.toThrow(UnauthorizedException);
    process.env.SHARE_SIGN_KEY = HEX64;
  });

  it('un token expiré est rejeté', async () => {
    const s = await createShareToken('42', 'sub', 60);
    // manipulation : token avec exp passée d'il y a 1 h
    await import('jose').then(async (jose) => {
      const past = await new jose.SignJWT({ did: '42' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(jose.issuer ?? 'alveare:documents')
        .setIssuer('alveare:documents')
        .setSubject('sub')
        .setJti(s.jti)
        .setExpirationTime(1)
        .sign(new Uint8Array(Buffer.from(HEX64, 'hex')));
      await expect(verifyShareToken(past)).rejects.toThrow(UnauthorizedException);
    });
  });

  it('clampTtl borne la durée de vie', () => {
    expect(clampTtl(1)).toBe(60);
    expect(clampTtl(999999)).toBe(86400);
    expect(clampTtl(900)).toBe(900);
    expect(() => clampTtl('nano')).toThrow();
  });
});
