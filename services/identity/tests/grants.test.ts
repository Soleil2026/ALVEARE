/*
 * Tests de validation des corps "role_grants" (service identity, zone Red).
 */

import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseGrantBody } from '../src/grants';

describe('parseGrantBody', () => {
  it('accepte un corps conforme', () => {
    const g = parseGrantBody({ userId: 'sub-1', app: 'app-07', role: 'gestionnaire' });
    expect(g).toEqual({ userId: 'sub-1', app: 'app-07', role: 'gestionnaire' });
  });

  it('accepte core-admin comme app', () => {
    expect(parseGrantBody({ userId: 'x', app: 'core-admin', role: 'admin' }).app).toBe('core-admin');
  });

  it('rejette une app hors pattern', () => {
    expect(() => parseGrantBody({ userId: 'x', app: 'app-999', role: 'admin' })).toThrow(BadRequestException);
    expect(() => parseGrantBody({ userId: 'x', app: 'app-00', role: 'admin' })).toThrow(BadRequestException);
    expect(() => parseGrantBody({ userId: 'x', app: 'app-13', role: 'admin' })).toThrow(BadRequestException);
  });

  it('accepte app-01..app-12 aux bornes', () => {
    expect(parseGrantBody({ userId: 'x', app: 'app-12', role: 'utilisateur' }).app).toBe('app-12');
  });

  it('rejette un rôle inconnu', () => {
    expect(() => parseGrantBody({ userId: 'x', app: 'app-01', role: 'superadmin' })).toThrow(BadRequestException);
  });

  it('rejette un userId manquant', () => {
    expect(() => parseGrantBody({ app: 'app-01', role: 'admin' })).toThrow(BadRequestException);
  });
});
