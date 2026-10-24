/*
 * Tests session chiffrée (zone Red) — round-trip + refus de
 * cookie falsifié + store serveur des flux PKCE (single-use).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { decodeSession, encodeSession } from '../lib/session';
import { putFlow, takeFlow } from '../lib/flowStore';

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
    // falsifier le PREMIER caractère du tag GCM : en base64url,
    // le dernier caractère encode des bits indifférents (padding)
    const parts = jwe.split('.');
    const tag = parts[3];
    parts[3] = (tag[0] === 'H' ? 'I' : 'H') + tag.slice(1);
    const corrupt = parts.join('.');
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

describe('store serveur des flux PKCE', () => {
  it('round-trip : putFlow → takeFlow retrouve verifier/nonce', () => {
    putFlow('state-test-1', 'V', 'N');
    const f = takeFlow('state-test-1');
    expect(f?.verifier).toBe('V');
    expect(f?.nonce).toBe('N');
  });

  it('single-use : un flux déjà consommé ne se rejoue pas', () => {
    putFlow('state-test-2', 'V', 'N');
    expect(takeFlow('state-test-2')).toBeDefined();
    expect(takeFlow('state-test-2')).toBeUndefined();
  });

  it("un état inconnu → undefined (pas d'exception)", () => {
    expect(takeFlow('state-test-inconnu')).toBeUndefined();
  });

  it('capacité plafonnée : la plus ancienne entrée est évacuée (anti-DoS)', () => {
    for (let i = 0; i < 10_002; i++) putFlow(`state-cap-${i}`, 'V', 'N');
    expect(takeFlow('state-cap-0')).toBeUndefined();
    expect(takeFlow('state-cap-10001')).toBeDefined();
  });
});
