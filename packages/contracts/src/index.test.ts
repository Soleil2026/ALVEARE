import { describe, expect, it } from 'vitest';
import { HealthSchema, UserRoleSchema } from './index';

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
