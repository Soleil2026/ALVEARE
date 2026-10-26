/**
 * web-admin — tests des helpers purs de la coupe ADMIN-UI (lecture
 * admin paiements, plan 348b045) : format des montants (garde D-9),
 * couverture des statuts contre le contrat, whitelist des query
 * params, mapping d'erreurs.
 */

import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUS } from '@alveare/contracts';
import {
  STATUT_META,
  fmtMinor,
  mapUpstreamError,
  sanitizeParams,
} from '../lib/payments-admin';

describe('fmtMinor', () => {
  it('sépare les milliers par espace', () => {
    expect(fmtMinor('250000')).toBe('250 000');
    expect(fmtMinor('1000000')).toBe('1 000 000');
  });

  it('laisse une valeur courte telle quelle', () => {
    expect(fmtMinor('500')).toBe('500');
  });

  it('refuse tout ce qui n\'est pas ≤ 15 digits (garde D-9)', () => {
    expect(fmtMinor('1234567890123456')).toBe('—'); // 16 chiffres
    expect(fmtMinor('12,50')).toBe('—');
    expect(fmtMinor('-100')).toBe('—');
    expect(fmtMinor('1e6')).toBe('—');
    expect(fmtMinor('')).toBe('—');
  });
});

describe('STATUT_META', () => {
  it('couvre EXACTEMENT les statuts du contrat (aucun divergence locale)', () => {
    expect(Object.keys(STATUT_META).sort()).toEqual([...PAYMENT_STATUS].sort());
    for (const s of PAYMENT_STATUS) {
      expect(STATUT_META[s].label.length).toBeGreaterThan(0);
      expect(STATUT_META[s].color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('sanitizeParams', () => {
  const empty: Record<string, string | string[] | undefined> = {};
  it('droit : params valides repassés tels quels', () => {
    const r = sanitizeParams({ app: 'app-01', status: 'paid', limit: '50' });
    expect(r).toEqual({ app: 'app-01', status: 'paid', limit: '50' });
    expect(sanitizeParams(empty)).toEqual({});
  });

  it('aucune injection possible dans l\'URL upstream', () => {
    expect(
      sanitizeParams({ app: 'app-01&admin=true' }).app,
    ).toBeUndefined();
    expect(
      sanitizeParams({ app: '../../etc' }).app,
    ).toBeUndefined();
    // status inconnu du contrat → rejeté (le service renverrait 400)
    expect(
      sanitizeParams({ status: 'paid&x=1' }).status,
    ).toBeUndefined();
    expect(
      sanitizeParams({ status: 'finished' }).status,
    ).toBeUndefined();
    // limit hors cap 200 ou non digits → rejeté
    expect(sanitizeParams({ limit: '201' }).limit).toBeUndefined();
    expect(sanitizeParams({ limit: 'abc' }).limit).toBeUndefined();
    expect(sanitizeParams({ limit: '50 OR 1=1' }).limit).toBeUndefined();
    // tableau → rejeté (jamais d'array de query re-copié)
    expect(sanitizeParams({ app: ['app-01', 'app-02'] }).app).toBeUndefined();
  });

  it('signale les filtres présents mais invalides (invalid)', () => {
    const r = sanitizeParams({ status: '<xss>', limit: '500' });
    expect(r.status).toBeUndefined();
    expect(r.limit).toBeUndefined();
    expect(r.invalid?.sort()).toEqual(['limit', 'status']);
    // un filtre valide ne fait rien signaler
    expect(sanitizeParams({ status: 'paid' }).invalid).toBeUndefined();
  });
});

describe('mapUpstreamError', () => {
  it('messages génériques jamais verbatim', () => {
    expect(mapUpstreamError(403)).toContain('accès refusé');
    expect(mapUpstreamError(401)).toContain('reconnectez-vous');
    expect(mapUpstreamError(500)).toContain('refusée');
  });
});
