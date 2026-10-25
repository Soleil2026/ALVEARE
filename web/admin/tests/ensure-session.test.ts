/*
 * Tests ensure-session (S1 silent refresh + remédiation revue N6
 * M-1) — décision D-1 : renouvellement PAR le rt stocké, injectable
 * pour test. Single-flight, adoption, classification transient.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  ADOPTION_TTL_MS,
  ensureSession,
  resetEnsureState,
} from '../lib/ensure-session';
import { RefreshTransientError } from '../lib/oidc';
import { decodeSession, encodeSession } from '../lib/session';

beforeAll(() => {
  process.env.SESSION_KEY = 'a'.repeat(64);
});
afterAll(() => {
  resetEnsureState();
});

const NOW = () => Math.floor(Date.now() / 1000);

describe('ensureSession — courant', () => {
  it('session saine → valide, AUCUN appel réseau', async () => {
    let calls = 0;
    const fn = async (): Promise<never> => { calls++; throw new Error('ne doit pas être appelé'); };
    const jwe = await encodeSession({ at: 'AT', rt: 'RT', exp: NOW() + 500 });
    const r = await ensureSession(jwe, fn);
    expect(r.status).toBe('valide');
    expect(calls).toBe(0);
  });

  it('exp proche + rt → renewée (nouveau at, rt roté, JWE déchiffrable)', async () => {
    const jwe = await encodeSession({ at: 'VIEUX', rt: 'RT1', exp: NOW() + 30 });
    const fn = async () => ({
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

  it("refresh refusé (4xx) → 'expirée' (le middleware détruit le cookie)", async () => {
    const jwe = await encodeSession({ at: 'VIEUX', rt: 'RT1', exp: NOW() + 10 });
    const fn: Parameters<typeof ensureSession>[1] = async () => { throw new Error('refresh refusé'); };
    expect((await ensureSession(jwe, fn)).status).toBe('expirée');
  });

  it("Keycloak 5xx → 'transient' : PAS une mort (m-1)", async () => {
    const jwe = await encodeSession({ at: 'VIEUX', rt: 'RT1', exp: NOW() + 10 });
    const fn = async (): Promise<never> => {
      throw new RefreshTransientError('keycloak indisponible');
    };
    const r = await ensureSession(jwe, fn);
    expect(r.status).toBe('transient');
    if (r.status !== 'transient') return;
    expect(r.claims.at).toBe('VIEUX'); // rien mangé
  });

  it("exp proche SANS rt → 'valide' (pas de crash ni d'appel)", async () => {
    let calls = 0;
    const fn: Parameters<typeof ensureSession>[1] = async () => { calls++; throw new Error('non'); };
    const jwe = await encodeSession({ at: 'AT', exp: NOW() + 10 });
    const r = await ensureSession(jwe, fn);
    expect(r.status).toBe('valide');
    expect(calls).toBe(0);
  });

  it('cookie absent → absente', async () => {
    expect((await ensureSession(undefined)).status).toBe('absente');
  });
});

describe('ensureSession — courses (M-1 : single-flight + adoption)', () => {
  it('n requêtes en parallèle avec le MÊME cookie → 1 seul refresh', async () => {
    const jwe = await encodeSession({ at: 'V', rt: 'RTc', exp: NOW() + 10 });
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30)); // laisser la course prendre
      return { access_token: 'AT_X', refresh_token: 'RTc2', expires_in: 600 };
    };
    const results = await Promise.all([
      ensureSession(jwe, fn),
      ensureSession(jwe, fn),
      ensureSession(jwe, fn),
      ensureSession(jwe, fn),
    ]);
    expect(calls).toBe(1); // single-flight
    for (const r of results) expect(r.status).toBe('renewée');
  });

  it('une requête concurrente recommande le résultat frais (adoption, TTL)', async () => {
    const jwe = await encodeSession({ at: 'V2', rt: 'RTd', exp: NOW() + 10 });
    let calls = 0;
    const fn = async () => {
      calls++;
      return { access_token: 'AT_F', refresh_token: 'RTd2', expires_in: 600 };
    };
    const first = await ensureSession(jwe, fn);
    expect(first.status).toBe('renewée');
    if (first.status !== 'renewée') return;
    // la course suivante (deadline avant TTL) en appelle PAS le réseau :
    const second = await ensureSession(jwe, fn);
    expect(calls).toBe(1);
    expect(second.status).toBe('renewée');
    if (second.status !== 'renewée') return;
    expect(second.jwe).toBe(first.jwe);
  });

  it("après le TTL, un vrai refresh est de re-fait", { timeout: 10_000 }, async () => {
    resetEnsureState();
    const jwe = await encodeSession({ at: 'V3', rt: 'RTe', exp: NOW() + 10 });
    let calls = 0;
    const fn = async () => {
      calls++;
      return { access_token: `AT_N${calls}`, expires_in: 600 };
    };
    const a = await ensureSession(jwe, fn);
    await new Promise((r) => setTimeout(r, ADOPTION_TTL_MS + 20));
    const b = await ensureSession(jwe, fn);
    expect(calls).toBe(2);
    if (a.status !== 'renewée' || b.status !== 'renewée') throw new Error('should be renewed');
    expect(b.jwe).not.toBe(a.jwe); // at différent à chaque tour
  });
});
