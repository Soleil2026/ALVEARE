import { describe, expect, it } from 'vitest';
import {
  AuditEntrySchema,
  AuditQuerySchema,
  HealthSchema,
  UserRoleSchema,
  MoneyAmountSchema,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUS,
  PaymentCreateSchema,
  PaymentWebhookEventSchema,
  PaymentWebhookPayloadSchema,
  RefundRequestSchema,
} from './index';

describe('HealthSchema', () => {
  it('accepte une réponse /healthz conforme', () => {
    const parsed = HealthSchema.safeParse({
      service: 'alveare-identity',
      status: 'ok',
      version: '0.0.1',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejette un service non conforme', () => {
    const parsed = HealthSchema.safeParse({
      service: '',
      status: 'ko',
      version: 'pas-une-version',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('UserRoleSchema', () => {
  it('accepte les trois rôles de base', () => {
    expect(UserRoleSchema.safeParse('admin').success).toBe(true);
    expect(UserRoleSchema.safeParse('gestionnaire').success).toBe(true);
    expect(UserRoleSchema.safeParse('utilisateur').success).toBe(true);
  });

  it('rejette un rôle inconnu', () => {
    expect(UserRoleSchema.safeParse('superadmin').success).toBe(false);
  });
});

describe('AuditEntrySchema', () => {
  it('accepte une entrée minimale (actor + action)', () => {
    const parsed = AuditEntrySchema.parse({
      actor: 'user-1',
      action: 'document.upload',
    });
    expect(parsed.actor).toBe('user-1');
    expect(parsed.action).toBe('document.upload');
    expect(parsed.at).toBeUndefined();
    expect(parsed.outboxId).toBeUndefined();
  });

  it("normalise un champ at Date vers un ISO 8601 UTC", () => {
    const parsed = AuditEntrySchema.parse({
      at: new Date('2026-10-25T18:00:00.000Z'),
      actor: 'user-1',
      action: 'share.grant',
      target: 'doc-42',
      details: { taille_octets: 1024 },
    });
    expect(parsed.at).toBe('2026-10-25T18:00:00.000Z');
    expect(parsed.target).toBe('doc-42');
    expect(parsed.details).toEqual({ taille_octets: 1024 });
  });

  it('accepte un champ at ISO 8601 (string)', () => {
    const parsed = AuditEntrySchema.parse({
      at: '2026-10-25T18:00:00.000Z',
      actor: 'user-1',
      action: 'consent.grant',
    });
    expect(parsed.at).toBe('2026-10-25T18:00:00.000Z');
  });

  it('accepte target null explicitement', () => {
    const parsed = AuditEntrySchema.parse({
      actor: 'user-1',
      action: 'login',
      target: null,
    });
    expect(parsed.target).toBeNull();
  });

  it('transforme un outboxId bigint/number/string vers une string', () => {
    const viaBigint = AuditEntrySchema.parse({
      actor: 'a',
      action: 'act',
      outboxId: 17n,
    });
    const viaNumber = AuditEntrySchema.parse({
      actor: 'a',
      action: 'act',
      outboxId: 17,
    });
    const viaString = AuditEntrySchema.parse({
      actor: 'a',
      action: 'act',
      outboxId: '17',
    });
    expect(viaBigint.outboxId).toBe('17');
    expect(viaNumber.outboxId).toBe('17');
    expect(viaString.outboxId).toBe('17');
  });

  it('rejette actor vide', () => {
    expect(
      AuditEntrySchema.safeParse({ actor: '', action: 'login' }).success,
    ).toBe(false);
  });

  it('rejette action manquante', () => {
    expect(AuditEntrySchema.safeParse({ actor: 'user-1' }).success).toBe(false);
  });

  it('rejette un at non ISO (date au format FR)', () => {
    expect(
      AuditEntrySchema.safeParse({
        at: '25/10/2026',
        actor: 'user-1',
        action: 'login',
      }).success,
    ).toBe(false);
  });

  it('rejette un outboxId négatif', () => {
    expect(
      AuditEntrySchema.safeParse({ actor: 'a', action: 'act', outboxId: -1 })
        .success,
    ).toBe(false);
  });
});

describe('AuditQuerySchema', () => {
  it('accepte une requête vide', () => {
    expect(AuditQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepte les filtres FR-03.3 + pagination curseur', () => {
    const parsed = AuditQuerySchema.parse({
      actor: 'user-1',
      action: 'share.grant',
      target: 'doc-42',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-25T23:59:59.000Z',
      limit: 100,
      cursor: 'MTc4MDI4',
    });
    expect(parsed.limit).toBe(100);
    expect(parsed.from).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rejette un limit <= 0 ou > 500', () => {
    expect(AuditQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AuditQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
  });

  it("rejette un from non ISO", () => {
    expect(
      AuditQuerySchema.safeParse({ from: 'octobre 2026' }).success,
    ).toBe(false);
  });
});

/**
 * E6 paiements (zone Red) — contrats versionnés : PAYMENT_STATUS,
 * PAYMENT_PROVIDERS, schémas create/view/refund/webhooks.
 */
describe('PAYMENT_STATUS / PAYMENT_PROVIDERS (constantes versionnées)', () => {
  it('expose exactement les 7 états du plan §2.3, dans l’ordre du plan', () => {
    expect([...PAYMENT_STATUS]).toEqual([
      'created', 'pending', 'paid', 'failed', 'expired',
      'partially_refunded', 'refunded',
    ]);
  });

  it('expose les 3 fournisseurs (dev | chargily | satim)', () => {
    expect([...PAYMENT_PROVIDERS]).toEqual(['dev', 'chargily', 'satim']);
  });
});

describe('PaymentCreateSchema', () => {
  it('accepte une création minimale (défauts rail=dzd/currency=DZD)', () => {
    const parsed = PaymentCreateSchema.parse({
      app: 'app-01',
      app_ref: 'CMD-2026-000123',
      amount: 250000, // centimes
    });
    expect(parsed.currency).toBe('DZD');
    expect(parsed.rail).toBe('dzd');
    expect(parsed.app_ref).toBe('CMD-2026-000123');
  });

  it('normalise un montant number vers une chaîne de chiffres', () => {
    const parsed = PaymentCreateSchema.parse({
      app: 'app-01', app_ref: 'r1', amount: 100,
    });
    expect(parsed.amount).toBe('100');
  });

  it('rejette un amount au-delà de la précision PSP (D-9 : 15 chiffres max)', () => {
    // 9007199254740993 (16 chiffres) > 2^53 : un Number() perdrait la
    // précision avant l'appel PSP — refus au contrat.
    expect(
      PaymentCreateSchema.safeParse({ app: 'app-01', app_ref: 'r1', amount: '9007199254740993' }).success,
    ).toBe(false);
    // 15 chiffres : dernière valeur sûre.
    expect(
      PaymentCreateSchema.safeParse({ app: 'app-01', app_ref: 'r1', amount: '999999999999999' }).success,
    ).toBe(true);
  });

  it('rejette amount < 100 centimes (R rail SATIM min)', () => {
    expect(
      PaymentCreateSchema.safeParse({ app: 'app-01', app_ref: 'r', amount: 99 }).success,
    ).toBe(false);
  });

  it('rejette un montant négatif ou flottant', () => {
    expect(
      PaymentCreateSchema.safeParse({ app: 'app-01', app_ref: 'r', amount: -100 }).success,
    ).toBe(false);
    expect(
      PaymentCreateSchema.safeParse({ app: 'app-01', app_ref: 'r', amount: 100.5 }).success,
    ).toBe(false);
  });

  it('rejette une app hors pattern (core-admin | app-01..app-12)', () => {
    expect(
      PaymentCreateSchema.safeParse({ app: 'app-99', app_ref: 'r', amount: 100 }).success,
    ).toBe(false);
    expect(
      PaymentCreateSchema.safeParse({ app: 'ap-01;', app_ref: 'r', amount: 100 }).success,
    ).toBe(false);
  });

  it('rejette currency non DZD sur rail dzd (R1 réglementaire)', () => {
    expect(
      PaymentCreateSchema.safeParse({
        app: 'app-01', app_ref: 'r', amount: 100, rail: 'dzd', currency: 'EUR',
      }).success,
    ).toBe(false);
  });

  it('exige un just_ref sur rail fx (Q8)', () => {
    expect(
      PaymentCreateSchema.safeParse({
        app: 'app-01', app_ref: 'r', amount: 100, rail: 'fx',
      }).success,
    ).toBe(false);
    expect(
      PaymentCreateSchema.safeParse({
        app: 'app-01', app_ref: 'r', amount: 100, rail: 'fx',
        just_ref: 'BDL-2026-00042',
      }).success,
    ).toBe(true);
  });

  it('rejette les champs inconnus (strictObject)', () => {
    expect(
      PaymentCreateSchema.safeParse({
        app: 'app-01', app_ref: 'r', amount: 100, extra: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('RefundRequestSchema', () => {
  it('accepte un refund partiel explicite', () => {
    const parsed = RefundRequestSchema.parse({
      refund_ref: 'REF-1', amount: 5000, reason: 'annulation client',
    });
    expect(parsed.amount).toBe('5000');
  });

  it('amount facultatif = total restant par défaut', () => {
    expect(RefundRequestSchema.parse({ refund_ref: 'REF-2' }).amount).toBeUndefined();
  });

  it('rejette refund_ref vide et amount <= 0', () => {
    expect(RefundRequestSchema.safeParse({ refund_ref: '' }).success).toBe(false);
    expect(RefundRequestSchema.safeParse({ refund_ref: 'r', amount: 0 }).success).toBe(false);
  });

  it('rejette les champs inconnus (strictObject)', () => {
    expect(RefundRequestSchema.safeParse({
      refund_ref: 'r', admin_bypass: true,
    }).success).toBe(false);
  });
});

describe('PaymentWebhookEventSchema (entrant PSP)', () => {
  const base = {
    event_uid: 'evt-1',
    provider: 'chargily' as const,
    provider_ref: 'chk-42',
    status: 'paid' as const,
  };

  it('accepte un événement paid', () => {
    expect(PaymentWebhookEventSchema.safeParse(base).success).toBe(true);
  });

  it('accepte fee_amount en string ou number (MoneyAmount)', () => {
    expect(PaymentWebhookEventSchema.safeParse({ ...base, fee_amount: 300 }).success).toBe(true);
    expect(PaymentWebhookEventSchema.safeParse({ ...base, fee_amount: '300' }).success).toBe(true);
  });

  it('rejette une status inconnue (ex. refund côté PSP) et un provider inconnu', () => {
    expect(PaymentWebhookEventSchema.safeParse({ ...base, status: 'refunded' }).success).toBe(false);
    expect(PaymentWebhookEventSchema.safeParse({ ...base, provider: 'stripe' }).success).toBe(false);
  });

  it('rejette un event_uid vide (idempotence impossible)', () => {
    expect(PaymentWebhookEventSchema.safeParse({ ...base, event_uid: '' }).success).toBe(false);
  });
});

describe('PaymentWebhookPayloadSchema (sortant vers les apps)', () => {
  const base = {
    event_uid: 'evt-1',
    event: 'payment.paid' as const,
    payment_id: '11111111-1111-1111-1111-111111111111',
    app: 'app-01',
    app_ref: 'CMD-1',
    status: 'paid' as const,
    amount: '10000',
    refunded_amount: '0',
    currency: 'DZD',
    ts: '2026-10-25T12:00:00.000Z',
  };

  it('accepte un payload conforme', () => {
    expect(PaymentWebhookPayloadSchema.safeParse(base).success).toBe(true);
  });

  it('cohérence event/status payés', () => {
    expect(PaymentWebhookPayloadSchema.safeParse({ ...base, event: 'payment.refunded' }).success)
      .toBe(false);
  });

  it('rejette les champs inconnus (strictObject)', () => {
    expect(PaymentWebhookPayloadSchema.safeParse({ ...base, signature: 'zz' }).success)
      .toBe(false);
  });
});

describe('MoneyAmountSchema (helper bigint-safe)', () => {
  it('accepte string de chiffres et entier non négatif, rejette le reste', () => {
    expect(MoneyAmountSchema.safeParse('0').success).toBe(true);
    expect(MoneyAmountSchema.safeParse(2_147_483_647).success).toBe(true);
    expect(MoneyAmountSchema.safeParse('-1').success).toBe(false);
    expect(MoneyAmountSchema.safeParse(1.5).success).toBe(false);
    expect(MoneyAmountSchema.safeParse('12a').success).toBe(false);
  });
});
