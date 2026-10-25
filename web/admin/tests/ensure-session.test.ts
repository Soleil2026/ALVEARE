/*
 * Tests ensure-session (S1 silent refresh, zone Red) — décision
 * D-1 : renouvellement PAR le rt stocké, injectable pour test.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureSession, type RefreshFn } from '../lib/ensure-session';
import { decodeSession, encodeSession } from '../lib/session';

beforeAll(() => {
  process.env.SESSION_KEY = 'a'.repeat(64);
});

const NOW = () => Math.floor(Date.now() / 1000);

describe('ensureSession', () => {
  it('session saine → valide, AUCUN appel réseau', async () => {
    let calls = 0;
    const fn: RefreshFn = async () => { calls++; throw new Error('ne doit pas être appelé'); };
    const jwe = await encodeSession({ at: 'AT', rt: 'RT', exp: NOW() + 500 });
    const r = await ensureSession(jwe, fn);
    expect(r.status).toBe('valide');
    expect(calls).toBe(0);
  });

  it('exp proche + rt → renewée (nouveau at, rt roté, JWE déchiffrable)', async () => {
    const jwe = await encodeSession({ at: 'VIEUX', rt: 'RT1', exp: NOW() + 30 });
    const fn: RefreshFn = async () => ({
      access_token: 'NOUVEAU_AT',
      refresh_token: 'RT2',
      expires_in: 600,
    });
    const r = await ensureSession(jwe, fn);
    expect(r.status).toBe('renewée');
    if (r.status !== 'renewée') return;
    const s = await decodeSession(r.jwe);
    expect(s?.at).toBe('NOUVEAU_AT');
    expect(s?.rt).toBe('RT2');
    expect(s?.exp).toBeGreaterThan(NOW() + 500);
  });

  it("refresh refusé → 'expirée' (le middleware détruira le cookie)", async () => {
    const jwe = await encodeSession({ at: 'VIEUX', rt: 'RT1', exp: NOW() + 10 });
    const fn: RefreshFn = async () => { throw new Error('kc down'); };
    expect((await ensureSession(jwe, fn)).status).toBe('expirée');
  });

  it("exp proche SANS rt → 'valide' (pas de crash ni d'appel)", async () => {
    let calls = 0;
    const fn: RefreshFn = async () => { calls++; throw new Error('non'); };
    const jwe = await encodeSession({ at: 'AT', exp: NOW() + 10 });
    const r = await ensureSession(jwe, fn);
    expect(r.status).toBe('valide');
    expect(calls).toBe(0);
  });

  it('cookie absent → absente', async () => {
    expect((await ensureSession(undefined)).status).toBe('absente');
  });
});
