/*
 * Tests session chiffrée (zone Red) — round-trip + refus de
 * cookie falsifié + stash expiré.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { decodeSession, decodeStash, encodeSession, encodeStash } from '../lib/session';

beforeAll(() => {
  process.env.SESSION_KEY = 'a'.repeat(64);
});

describe('encodeSession / decodeSession', () => {
  it('round-trip complet (exp modeste préservé)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const jwe = await encodeSession({ at: 'AT', rt: 'RT', idToken: 'ID', exp });
    const s = await decodeSession(jwe);
    expect(s).not.toBeNull();
    expect(s?.at).toBe('AT');
    expect(s?.rt).toBe('RT');
    expect(s?.idToken).toBe('ID');
    expect(s?.exp).toBe(exp);
  });

  it('un exp farfelu est borné à 12 h (protection anti-stagnation)', async () => {
    const s = await decodeSession(await encodeSession({ at: 'AT', exp: 4102444800 }));
    expect(s?.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 12 * 3600 + 1);
  });

  it("un cookie falsifié est rejeté (null, pas d'exception)", async () => {
    const jwe = await encodeSession({ at: 'AT', exp: Math.floor(Date.now() / 1000) + 300 });
    const corrupt = jwe.replace(/.$/, 'H');
    expect(await decodeSession(corrupt)).toBeNull();
    expect(await decodeSession(undefined)).toBeNull();
    expect(await decodeSession('garbage')).toBeNull();
  });

  it('un cookie signé avec une autre clé est rejeté', async () => {
    const jwe = await encodeSession({ at: 'AT', exp: Math.floor(Date.now() / 1000) + 300 });
    process.env.SESSION_KEY = 'b'.repeat(64);
    expect(await decodeSession(jwe)).toBeNull();
    process.env.SESSION_KEY = 'a'.repeat(64);
  });

  it('une session expirée est rejetée', async () => {
    const jwe = await encodeSession({ at: 'AT', exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await decodeSession(jwe)).toBeNull();
  });
});

describe('stash PKCE', () => {
  it('round-trip verifier/state/nonce', async () => {
    const jwe = await encodeStash({ verifier: 'V', state: 'S', nonce: 'N' });
    const s = await decodeStash(jwe);
    expect(s).toEqual({ verifier: 'V', state: 'S', nonce: 'N' });
  });

  it('un stash falsifié est rejeté', async () => {
    const jwe = await encodeStash({ verifier: 'V', state: 'S', nonce: 'N' });
    expect(await decodeStash(jwe.replace(/.$/, 'Z'))).toBeNull();
  });

  it('un stash au-delà de 5 min est refusé', async () => {
    const jwe = await encodeStash({ verifier: 'V', state: 'S', nonce: 'N' });
    process.env.SESSION_KEY = 'd'.repeat(64);
    expect(await decodeStash(jwe)).toBeNull();
    process.env.SESSION_KEY = 'a'.repeat(64);
  });
});
