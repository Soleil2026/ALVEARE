import { describe, expect, it } from 'vitest';
import {
  AuditEntrySchema,
  AuditQuerySchema,
  HealthSchema,
  UserRoleSchema,
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
