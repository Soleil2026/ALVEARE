/**
 * E6 T4.3 — décisions PURES du service paiements (plan.ts) : arbitrage
 * refund (plafond ≤ payé, idempotence refund_ref), portrait API,
 * plafonds env. Machine à états exhaustive : packages/payments/src/
 * state.ts (74 tests dédiés). Zone Red : revue indépendante obligatoire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closesOn,
  paymentsWebhookCap,
  planRefund,
  ttlSeconds,
  viewFromRow,
} from '../src/plan';
import type { TxnRow } from '../src/store';
import { PAYMENT_STATUS } from '@alveare/contracts';

// ---------------------------------------------------------------------
// planRefund — arbitrage d'un remboursement (Q9 : partiel/total
// idempotent, plafond strict ≤ montant payé).
// ---------------------------------------------------------------------
describe('planRefund — statuts remboursables', () => {
  const PAID = {
    txnStatus: 'paid' as const,
    amountCents: '10000',
    refundedCents: '0',
  };

  it('paid + jamais remboursé → partiel possible', () => {
    expect(
      planRefund(PAID, { refundRef: 'R1', amountCents: '4000' }, null),
    ).toEqual({ kind: 'apply', amountCents: '4000', newStatus: 'partially_refunded' });
  });

  it('paid + montant exact du restant → refunded (remboursement total)', () => {
    expect(
      planRefund(PAID, { refundRef: 'R2', amountCents: '10000' }, null),
    ).toEqual({ kind: 'apply', amountCents: '10000', newStatus: 'refunded' });
  });

  it('paid + amount absent → TOTAL du solde restant (Q9)', () => {
    expect(planRefund(PAID, { refundRef: 'R3' }, null)).toEqual({
      kind: 'apply',
      amountCents: '10000',
      newStatus: 'refunded',
    });
  });

  it('partially_refunded + montant absent → le RESTE uniquement', () => {
    expect(
      planRefund(
        { txnStatus: 'partially_refunded', amountCents: '10000', refundedCents: '4000' },
        { refundRef: 'R4' },
        null,
      ),
    ).toEqual({ kind: 'apply', amountCents: '6000', newStatus: 'refunded' });
  });

  it('partially_refunded + part du prix → encore partiel', () => {
    expect(
      planRefund(
        { txnStatus: 'partially_refunded', amountCents: '10000', refundedCents: '4000' },
        { refundRef: 'R5', amountCents: '2000' },
        null,
      ),
    ).toEqual({ kind: 'apply', amountCents: '2000', newStatus: 'partially_refunded' });
  });

  it('bordure : montant = restant − 1 centime → partiel (jamais total)',
    () => {
      expect(
        planRefund(PAID, { refundRef: 'R6', amountCents: '9999' }, null),
      ).toEqual({
        kind: 'apply',
        amountCents: '9999',
        newStatus: 'partially_refunded',
      });
    });
});

describe('planRefund — plafond strict', () => {
  it('montant > solde restant → refus « over »', () => {
    expect(
      planRefund(
        { txnStatus: 'paid', amountCents: '10000', refundedCents: '4000' },
        { refundRef: 'R7', amountCents: '6001' },
        null,
      ).kind,
    ).toBe('over');
  });

  it('même refund_ref libre : un total > payé est refusé aussi', () => {
    expect(
      planRefund(
        { txnStatus: 'paid', amountCents: '5000', refundedCents: '0' },
        { refundRef: 'R8', amountCents: '5001' },
        null,
      ).kind,
    ).toBe('over');
  });

  it('refund consommé en total : un refund_ref FRAIS sur solde 0 → over',
    () => {
      // statut serait déjà refunded, mais la garde plafond prime :
      expect(
        planRefund(
          { txnStatus: 'paid', amountCents: '5000', refundedCents: '5000' },
          { refundRef: 'R9', amountCents: '1' },
          null,
        ).kind,
      ).toBe('over');
    });

  it('arithmétique BIGINT : montant au-delà de 2^53 reste exact', () => {
    const result = planRefund(
      { txnStatus: 'paid', amountCents: '9007199254740993', refundedCents: '0' },
      { refundRef: 'R10', amountCents: '9007199254740992' },
      null,
    );
    // 2^53 cents remboursés sur 2^53 + 1 → reste 1 centime → partiel.
    expect(result).toEqual({
      kind: 'apply',
      amountCents: '9007199254740992',
      newStatus: 'partially_refunded',
    });
  });
});

describe('planRefund — idempotence refund_ref (Q9 : décidée AVANT le plafond)',
  () => {
    const AFTER_ONE_PARTIAL = {
      txnStatus: 'partially_refunded' as const,
      amountCents: '10000',
      refundedCents: '4000',
    };

    it('même refund_ref + MÊME montant collecté → no-op (replay)', () => {
      expect(
        planRefund(
          AFTER_ONE_PARTIAL,
          { refundRef: 'R1', amountCents: '4000' },
          { amountCents: '4000' },
        ),
      ).toEqual({ kind: 'noop', status: 'partially_refunded' });
    });

    it('même refund_ref SANS montant (total demandé) → no-op honnête', () => {
      // Le solde a bougé depuis la première application : un replay
      // (montant absent) ne peut jamais re-déclencher un remboursement.
      expect(
        planRefund(AFTER_ONE_PARTIAL, { refundRef: 'R11' }, { amountCents: '4000' }),
      ).toEqual({ kind: 'noop', status: 'partially_refunded' });
    });

    it('même refund_ref + montant DIFFÉRENT → conflit (réclamation ambiguë)',
      () => {
        expect(
          planRefund(
            AFTER_ONE_PARTIAL,
            { refundRef: 'R11', amountCents: '1000' },
            { amountCents: '4000' },
          ).kind,
        ).toBe('conflict-ref');
      });

    it("un replay sur la même clé ne retombe jamais dans l'arbitrage",
      () => {
        // Un no-op n'est pas un plafond : refund 4000 deux fois repose
        // exactement sur le MÊME collecté.
        expect(
          planRefund(
            { txnStatus: 'paid', amountCents: '5000', refundedCents: '5000' },
            { refundRef: 'R12', amountCents: '5000' },
            { amountCents: '5000' },
          ).kind,
        ).toBe('noop');
      });
});

describe("planRefund — statuts non remboursables (conflit d'état, 409 attendu)", () => {
  it.each(
    PAYMENT_STATUS.filter(
      (s) => s !== 'paid' && s !== 'partially_refunded',
    ),
  )('statut %s → conflict-status', (stat) => {
    const result = planRefund(
      { txnStatus: stat, amountCents: '10000', refundedCents: '0' },
      { refundRef: 'R100', amountCents: '100' },
      null,
    );
    expect(result).toEqual({ kind: 'conflict-status', status: stat });
  });
});

// ---------------------------------------------------------------------
// viewFromRow — portrait API conforme (montants BIGINT-safe, ISO UTC).
// ---------------------------------------------------------------------
function rowFixture(patch: Partial<Record<keyof TxnRow, unknown>> = {}): TxnRow {
  return {
    id: '2f0dcb32-8b26-46a4-959e-735ba2b2f68d',
    app: 'app-01',
    app_ref: 'CMD-1',
    status: 'paid',
    amount: '10000',
    currency: 'DZD',
    rail: 'dzd',
    just_ref: null,
    provider: 'dev',
    provider_ref: 'dev-txn',
    event_uid: 'uid-1',
    receipt_ref: null,
    fee_amount: null,
    refunded: '2000',
    created_at: new Date('2026-10-25T10:00:00.000Z'),
    paid_at: new Date('2026-10-25T10:05:00.000Z'),
    closed_at: null,
    ...patch,
  } as unknown as TxnRow;
}

describe('viewFromRow', () => {
  it('portrait conforme : statuts/montants/dates', () => {
    const view = viewFromRow(rowFixture());
    expect(view).toMatchObject({
      id: '2f0dcb32-8b26-46a4-959e-735ba2b2f68d',
      status: 'paid',
      amount: '10000',
      refunded_amount: '2000',
      currency: 'DZD',
      rail: 'dzd',
      provider: 'dev',
    });
    expect(view.created_at).toBe('2026-10-25T10:00:00.000Z');
    expect(view.paid_at).toBe('2026-10-25T10:05:00.000Z');
    expect(view.closed_at).toBeNull();
  });

  it('champs facultatifs : reçu et frais tracés ; just_ref non exposé', () => {
    const v = viewFromRow(rowFixture({ receipt_ref: 'RC-3020-0001', fee_amount: '70' }));
    expect(v.receipt_ref).toBe('RC-3020-0001');
    expect(v.fee_amount).toBe('70');
    // just_ref (réglementaire FX) vit côté serveur : le portrait public
    // PaymentViewSchema ne le transporte pas.
    expect('just_ref' in v).toBe(false);
  });

  it('statut BD inconnu → jamais exposé (erreur explicite)', () => {
    expect(() => viewFromRow(rowFixture({ status: 'anything' }))).toThrow(
      /statut inconnu/,
    );
  });

  it('horodatage BD invalide → erreur explicite (jamais « Invalid Date »)',
    () => {
      expect(() =>
        viewFromRow(
          rowFixture({ created_at: new Date('not a date') as unknown as Date }),
        ),
      ).toThrow(/horodatage invalide/);
    });
});

// ---------------------------------------------------------------------
// closesOn — statuts qui ferment l'énoncé (closed_at = now()).
// ---------------------------------------------------------------------
describe('closesOn', () => {
  it.each([
    ['paid', false],
    ['partially_refunded', false],
    ['created', false],
    ['pending', false],
    ['failed', true],
    ['expired', true],
    ['refunded', true],
  ] as const)('%s → closed ? %s', (st, want) => {
    expect(closesOn(st)).toBe(want);
  });
});

// ---------------------------------------------------------------------
// Plafonds env strictement positifs (mêmes gardes que E3).
// ---------------------------------------------------------------------
describe('paymentsWebhookCap / ttlSeconds', () => {
  const CAP = 'PAYMENTS_WEBHOOK_ATTEMPTS_CAP';
  const TTL = 'PAYMENTS_TTL_SECONDS';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('défauts : cap 5, ttl 1200 s (miroir auto-cancel SATIM)', () => {
    delete process.env[CAP];
    delete process.env[TTL];
    expect(paymentsWebhookCap()).toBe(5);
    expect(ttlSeconds()).toBe(1200);
  });

  it('valeurs valides honorées', () => {
    vi.stubEnv(CAP, '3');
    vi.stubEnv(TTL, '45');
    expect(paymentsWebhookCap()).toBe(3);
    expect(ttlSeconds()).toBe(45);
  });

  it('entiers ≤ 0, flottants, non-numériques → défaut (jamais cap nul)',
    () => {
      for (const bad of ['0', '-1', '2.5', 'abc', '']) {
        vi.stubEnv(CAP, bad);
        vi.stubEnv(TTL, bad);
        expect(paymentsWebhookCap()).toBe(5);
        expect(ttlSeconds()).toBe(1200);
      }
    });
});
