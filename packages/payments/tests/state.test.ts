/**
 * E6 T4.1/T4.2 — tests de la machine à états des transactions
 * (zone Red : argent). Module PUR — aucune BD, aucun réseau.
 *
 * Pinnés (plan E6 §2.3 / consigne T4.3) :
 *   * transitions légales EXACTEMENT celles du graphe ;
 *   * toute transition illégale → IllegalTransitionError (throw) ;
 *   * états terminaux (failed/expired/refunded) : AUCUN départ ;
 *   * repasse de la MÊME transition : paid→paid, failed→failed… = no-op
 *     idempotent (jamais une nouvelle trace) ; created→created interdit ;
 *   * canTransition ⟺ transition ne lève pas.
 */

import { describe, expect, it } from 'vitest';
import type { PaymentStatus } from '@alveare/contracts';
import {
  canTransition,
  IllegalTransitionError,
  REPEATABLE,
  TRANSITIONS,
  transition,
} from '../src/state';

const ALL: PaymentStatus[] = [
  'created',
  'pending',
  'paid',
  'failed',
  'expired',
  'partially_refunded',
  'refunded',
];

const LEGAL: Array<[PaymentStatus, PaymentStatus]> = [
  ['created', 'pending'],
  ['created', 'failed'],
  ['pending', 'paid'],
  ['pending', 'failed'],
  ['pending', 'expired'],
  ['paid', 'partially_refunded'],
  ['paid', 'refunded'],
  ['partially_refunded', 'refunded'],
];

describe('TRANSITIONS (table de vérité)', () => {
  it('reflète exactement le graphe du plan §2.3', () => {
    expect(TRANSITIONS.created).toEqual(['pending', 'failed']);
    expect(TRANSITIONS.pending).toEqual(['paid', 'failed', 'expired']);
    expect(TRANSITIONS.paid).toEqual(['partially_refunded', 'refunded']);
    expect(TRANSITIONS.partially_refunded).toEqual(['refunded']);
    // Terminaux : aucune transition sortante possible.
    expect(TRANSITIONS.failed).toEqual([]);
    expect(TRANSITIONS.expired).toEqual([]);
    expect(TRANSITIONS.refunded).toEqual([]);
  });

  it('chaque état est couvert par la table (aucune clé manquante)', () => {
    for (const s of ALL) expect(Array.isArray(TRANSITIONS[s])).toBe(true);
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL].sort());
  });
});

describe('transition() — transitions légales', () => {
  for (const [from, to] of LEGAL) {
    it(`${from} → ${to} : appliquée (kind=applied)`, () => {
      expect(transition(from, to)).toEqual({ kind: 'applied' });
      expect(canTransition(from, to)).toBe(true);
    });
  }
});

describe('transition() — transitions illégales (throw)', () => {
  const illegal: Array<[PaymentStatus, PaymentStatus]> = [];
  for (const from of ALL) {
    for (const to of ALL) {
      const legal =
        LEGAL.some(([f, t]) => f === from && t === to) ||
        (from === to && REPEATABLE.has(from));
      if (!legal) illegal.push([from, to]);
    }
  }

  it(`exclut précisément les ${illegal.length} paires hors graphe`, () => {
    // Voyons d'abord la cohérence du dénombrement : 49 paires totales
    // - 8 transitions légales - 6 repasses idempotentes (tout sauf
    // created→created) = 35 paires illégales.
    expect(illegal.length).toBe(49 - LEGAL.length - REPEATABLE.size);
  });

  for (const [from, to] of illegal) {
    it(`${from} → ${to} : IllegalTransitionError`, () => {
      expect(() => transition(from, to)).toThrow(IllegalTransitionError);
      expect(canTransition(from, to)).toBe(false);
    });
  }

  it("l'erreur porte from/to et le message nommé", () => {
    let err: IllegalTransitionError | undefined;
    try {
      transition('created', 'paid');
    } catch (e) {
      err = e as IllegalTransitionError;
    }
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err?.from).toBe('created');
    expect(err?.to).toBe('paid');
    expect(err?.message).toContain('created');
    expect(err?.message).toContain('paid');
    expect(err?.name).toBe('IllegalTransitionError');
  });
});

describe('état terminaux (immuables, sauf la repasse identique)', () => {
  for (const terminal of ['failed', 'expired', 'refunded'] as const) {
    for (const to of ALL) {
      if (to === terminal) continue; // géré ci-dessous (repasse = no-op)
      it(`${terminal} → ${to} : refusé (terminal)`, () => {
        expect(() => transition(terminal, to)).toThrow(IllegalTransitionError);
      });
    }
  }
});

describe('idempotence repasse (même destination)', () => {
  const repeatable = ALL.filter((s) => s !== 'created');
  for (const s of repeatable) {
    it(`${s} → ${s} : no-op idempotent (kind=noop)`, () => {
      expect(transition(s, s)).toEqual({ kind: 'noop' });
      expect(canTransition(s, s)).toBe(true);
    });
  }

  it('created → created : interdit (la ré-création passe par (app, app_ref))', () => {
    expect(() => transition('created', 'created')).toThrow(
      IllegalTransitionError,
    );
    expect(canTransition('created', 'created')).toBe(false);
  });

  it('la repasse d’un jet ping encore pending reste pending', () => {
    expect(transition('pending', 'pending')).toEqual({ kind: 'noop' });
  });

  it("la repasse d'un paid (webhook rejoué) ne redéclenche rien", () => {
    expect(transition('paid', 'paid')).toEqual({ kind: 'noop' });
  });
});
