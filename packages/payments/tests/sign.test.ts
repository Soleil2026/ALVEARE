/**
 * E6 Q4 — tests de la signature HMAC-SHA256 des webhooks SORTANTS
 * (X-ALVEARE-Signature : t=<unix>, v1=<hex>). Zone Red.
 *
 * Pinnés :
 *   * format exact : HMAC du secret sur `${ts}.${body}` (ts en SECONDES) ;
 *   * bonne signature → verifyOutbound true ;
 *   * corps altéré, secret différent, entête mal formé, v1 tronqué → false ;
 *   * rejou (replay) : entête datée de plus de PAYMENTS_WEBHOOK_MAX_SKEW
 *     secondes → false (garde anti-replay, fermée au bord exact) ;
 *   * comparaison à temps constant (longueurs inégales sans throw) ;
 *   * signOutbound refuse ts non entier et secret vide.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { signOutbound, verifyOutbound, constantTimeHexEqual } from '../src/sign';

const SECRET = 'whsec-app-01-e2e-local';
const BODY = JSON.stringify({
  event_uid: 't1:payment.paid',
  event: 'payment.paid',
  payment_id: 't1',
});

/** Recalcul indépendant du vecteur attendu. */
function hexOf(secret: string, body: string, t: number): string {
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

describe('signOutbound / verifyOutbound (tour de bonne foi)', () => {
  it('le format est exactement t=<unix>, v1=<hex 64>', () => {
    const t = 1_700_000_000;
    const header = signOutbound(SECRET, BODY, t);
    expect(header).toBe(`t=${t}, v1=${hexOf(SECRET, BODY, t)}`);
    expect(name(header)).toBe(true);
  });

  function name(header: string): boolean {
    return /^t=\d+, v1=[0-9a-f]{64}$/.test(header);
  }

  it('vérification en round-trip : bonne signature → true', () => {
    const t = 1_700_000_001;
    const header = signOutbound(SECRET, BODY, t);
    expect(verifyOutbound(SECRET, BODY, header, { now: t })).toBe(true);
    // skew = 0 : l'horloge doit être pile (gardé pour les tests).
    expect(verifyOutbound(SECRET, BODY, header, { now: t, skew: 0 })).toBe(true);
  });

  it('la fenêtre anti-replay est fermée au bord exact (+/- skew)', () => {
    const t = 1_700_000_000;
    const header = signOutbound(SECRET, BODY, t);
    expect(verifyOutbound(SECRET, BODY, header, { now: t + 300 })).toBe(true);
    expect(verifyOutbound(SECRET, BODY, header, { now: t + 301 })).toBe(false);
    expect(verifyOutbound(SECRET, BODY, header, { now: t - 300 })).toBe(true);
    expect(verifyOutbound(SECRET, BODY, header, { now: t - 301 })).toBe(false);
  });

  it('PAYMENTS_WEBHOOK_MAX_SKEW (défaut 300) pilote la fenêtre', () => {
    vi.stubEnv('PAYMENTS_WEBHOOK_MAX_SKEW', '60');
    const head = signOutbound(SECRET, BODY, 1_700_000_000);
    expect(verifyOutbound(SECRET, BODY, head, { now: 1_700_000_060 })).toBe(true);
    expect(verifyOutbound(SECRET, BODY, head, { now: 1_700_000_061 })).toBe(false);
    vi.unstubAllEnvs();
  });

  it('PAYMENTS_WEBHOOK_MAX_SKEW invalide → défaut 300 (pas de désarmement)', () => {
    for (const bad of ['', '0', '-5', '1.5', 'abc']) {
      vi.stubEnv('PAYMENTS_WEBHOOK_MAX_SKEW', bad);
      const head = signOutbound(SECRET, BODY, 1_700_000_000);
      // +120s : ferme au-delà de 300 uniquement (un skew cassé à 0 or 60
      // fermerait ici) ; +310 : ferme toujours.
      expect(verifyOutbound(SECRET, BODY, head, { now: 1_700_000_120 })).toBe(true);
      expect(verifyOutbound(SECRET, BODY, head, { now: 1_700_000_310 })).toBe(false);
      vi.unstubAllEnvs();
    }
  });
});

describe('verifyOutbound — signatures invalides (false, jamais throw)', () => {
  const t = 1_700_000_000;
  const good = signOutbound(SECRET, BODY, t);

  it('corps altéré (recalcul attendu différent)', () => {
    expect(verifyOutbound(SECRET, BODY + 'x', good, { now: t })).toBe(false);
  });

  it('secret différent', () => {
    expect(verifyOutbound('autre-secret', BODY, good, { now: t })).toBe(false);
  });

  it('entête absente ou vide', () => {
    expect(verifyOutbound(SECRET, BODY, undefined, { now: t })).toBe(false);
    expect(verifyOutbound(SECRET, BODY, '', { now: t })).toBe(false);
  });

  it('entête mal formée (v1 tronqué, t non-entier, hex non-conforme)', () => {
    expect(verifyOutbound(SECRET, BODY, `t=${t}, v1=abc`, { now: t })).toBe(false);
    expect(
      verifyOutbound(SECRET, BODY, `t=${t}.5, v1=${hexOf(SECRET, BODY, t)}`, { now: t }),
    ).toBe(false);
    expect(verifyOutbound(SECRET, BODY, 'pas-une-signature', { now: t })).toBe(false);
  });

  it('replay : la MÊME entête ne repasse pas au-delà du skew', () => {
    // Une entête signée 1000 s avant « maintenant » ne passe JAMAIS —
    // un POST capturé et rejoué est refusé.
    const old = signOutbound(SECRET, BODY, t - 1000);
    expect(verifyOutbound(SECRET, BODY, old, { now: t })).toBe(false);
  });

  it('secret vide côté app = refus systématique', () => {
    expect(verifyOutbound('', BODY, good, { now: t })).toBe(false);
  });
});

describe('signOutbound — gardes d’entrée', () => {
  it('ts non entier (fraction) ou négatif : throw', () => {
    expect(() => signOutbound(SECRET, BODY, 1_700_000_000.5)).toThrow();
    expect(() => signOutbound(SECRET, BODY, -1)).toThrow();
  });

  it('secret manquant : throw (jamais une signature silencieuse)', () => {
    expect(() => signOutbound('', BODY, 1_700_000_000)).toThrow(/secret/);
  });
});

describe('constantTimeHexEqual', () => {
  it('vrai seulement pour des hex identiques (longueur égale)', () => {
    const h = 'a'.repeat(64);
    expect(constantTimeHexEqual(h, h)).toBe(true);
    expect(constantTimeHexEqual(h, 'b'.repeat(64))).toBe(false);
  });

  it('longueurs différentes / entrées non-hex : false (jamais throw)', () => {
    expect(constantTimeHexEqual('ab', 'abcd')).toBe(false);
    expect(constantTimeHexEqual('', 'ab')).toBe(false);
    expect(constantTimeHexEqual('zz', 'ab')).toBe(false);
  });
});
