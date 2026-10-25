/*
 * Tests du garde-mort e2e (revue T3.8 S-3, zone Red) : le claim azp
 * « audit-e2e » doit être refusé tant que ALV_ALLOW_E2E ≠ « 1 », et
 * accepté sinon. AUTH_E2E_CLIENTS est posé AVANT l'import dynamique du
 * module (ALLOWED_AZP fige sa valeur au chargement) ; ALV_ALLOW_E2E est
 * sauvegardé puis restauré après chaque test (aucune fuite de variable
 * vers les autres suites).
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { UnauthorizedException } from '@nestjs/common';

process.env.AUTH_E2E_CLIENTS = 'audit-e2e';
// Import DYNAMIQUE (top-level await) : ALLOWED_AZP fige la CSV au
// chargement du module — l'extension azp « audit-e2e » est donc active
// pour toute la suite, comme elle le serait pour le service audit
// pendant le e2e.
const { verifyToken, ISSUER } = await import('../src');

type KeyLike = Parameters<typeof SignJWT>[1];
let signKey: KeyLike;
let localJwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  signKey = privateKey as KeyLike;
  const jwk = await exportJWK(publicKey);
  localJwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', kid: 'gate-1', use: 'sig' }] });
});

async function sign(azp: string): Promise<string> {
  return new SignJWT({ scope: 'openid e2e', azp, realm_access: { roles: ['admin'] } })
    .setProtectedHeader({ alg: 'RS256', kid: 'gate-1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setSubject('sub-svc-e2e')
    .setExpirationTime('5m')
    .sign(signKey);
}

/** Sauvegarde/restauration de la variable entre tests (jamais de fuite). */
const ALV_ALLOW_E2E_SAUV = process.env.ALV_ALLOW_E2E;
afterEach(() => {
  if (ALV_ALLOW_E2E_SAUV === undefined) {
    delete process.env.ALV_ALLOW_E2E;
  } else {
    process.env.ALV_ALLOW_E2E = ALV_ALLOW_E2E_SAUV;
  }
});

describe('garde-mort e2e (azp audit-e2e)', () => {
  it('rejette azp audit-e2e sans ALV_ALLOW_E2E', async () => {
    delete process.env.ALV_ALLOW_E2E;
    await expect(verifyToken(await sign('audit-e2e'), { jwks: localJwks })).rejects.toThrow(
      'client e2e non autorisé hors environnement de test',
    );
  });

  it('rejette azp audit-e2e avec ALV_ALLOW_E2E ≠ « 1 » (strict : « true » ne passe pas)', async () => {
    process.env.ALV_ALLOW_E2E = 'true';
    await expect(verifyToken(await sign('audit-e2e'), { jwks: localJwks })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepte azp audit-e2e avec ALV_ALLOW_E2E=1 (environnement e2e explicite)', async () => {
    process.env.ALV_ALLOW_E2E = '1';
    const user = await verifyToken(await sign('audit-e2e'), { jwks: localJwks });
    expect(user.sub).toBe('sub-svc-e2e');
    expect(user.realmRoles).toEqual(['admin']);
  });

  it('la garde ne touche QUE audit-e2e : web-admin reste accepté sans ALV_ALLOW_E2E', async () => {
    delete process.env.ALV_ALLOW_E2E;
    const user = await verifyToken(await sign('web-admin'), { jwks: localJwks });
    expect(user.sub).toBe('sub-svc-e2e');
  });
});
