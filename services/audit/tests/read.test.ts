/*
 * E3 T3.7 — tests vitest de la lecture admin FR-03.3 (pur, sans Nest).
 * Pinné ici : parse (coercion limit, dates ISO), curseur roundtrip,
 * borne limit, et SÉCURITÉ SQL : toute valeur utilisateur passe par un
 * paramètre (Prisma.Sql.values), jamais interpolée dans le texte SQL.
 */

import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  buildAuditListSql,
  clampLimit,
  decodeCursor,
  encodeCursor,
  parseAuditQuery,
} from '../src/read';
describe('parseAuditQuery', () => {
  it('tolère tout absent (requête brute = dernière page)', () => {
    expect(parseAuditQuery({})).toEqual({ ok: true, query: {} });
  });

  it('coerce limit depuis le query string et écarte le non-numérique', () => {
    expect(parseAuditQuery({ limit: '20' })).toEqual({ ok: true, query: { limit: 20 } });
    expect(parseAuditQuery({ limit: 'abc' })).toMatchObject({ ok: false });
    // flottant → rejeté par AuditQuerySchema (int 1..500)
    expect(parseAuditQuery({ limit: '1.5' })).toMatchObject({ ok: false });
    // hors bornes → rejeté explicite (400 au contrôleur)
    expect(parseAuditQuery({ limit: '800' })).toMatchObject({ ok: false });
    expect(parseAuditQuery({ limit: '0' })).toMatchObject({ ok: false });
  });

  it('dates from/to ISO uniquement (champ cité dans l’erreur)', () => {
    const r = parseAuditQuery({ from: 'demain' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('from');
    expect(parseAuditQuery({ to: '2026-10-25T10:00:00Z' }).ok).toBe(true);
  });

  it('filtres actor/action/target/cursor passés tels quels', () => {
    const r = parseAuditQuery({ actor: 'auth|u1', action: 'document.upload', target: '42', cursor: 'x' });
    expect(r.ok && r.query).toEqual({ actor: 'auth|u1', action: 'document.upload', target: '42', cursor: 'x' });
  });
});

describe('curseur opaque at|id (base64url)', () => {
  it('roundtrip', () => {
    const c = encodeCursor('2026-10-25T09:00:00.000Z', 1234);
    expect(decodeCursor(c)).toEqual({ at: '2026-10-25T09:00:00.000Z', id: 1234 });
  });

  it('roundtrip depuis Date/bigint (retour brut Prisma)', () => {
    const c = encodeCursor(new Date('2026-10-25T09:00:00.000Z'), BigInt(99));
    expect(decodeCursor(c)).toEqual({ at: '2026-10-25T09:00:00.000Z', id: 99 });
  });

  it('corrompus → null (le contrôleur convertit en 400)', () => {
    expect(decodeCursor('%%%')).toBeNull();
    expect(decodeCursor(Buffer.from('sans-separateur', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(encodeCursor('pas-une-date', 5))).toBeNull();
    expect(decodeCursor(encodeCursor('2026-10-25T09:00:00Z', -3))).toBeNull();
  });

  it('la barre verticale DANS l’id/at ne peut pas casser le découpage (lastIndexOf)', () => {
    const c = encodeCursor('2026-10-25T09:00:00.000Z', 42);
    expect(c).toBe(Buffer.from('2026-10-25T09:00:00.000Z|42').toString('base64url'));
  });
});

describe('clampLimit', () => {
  it('absent ou <1 → 50 ; >500 → 500 ; sinon tel quel', () => {
    expect(clampLimit(undefined)).toBe(AUDIT_DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(AUDIT_DEFAULT_LIMIT);
    expect(clampLimit(-5)).toBe(AUDIT_DEFAULT_LIMIT);
    expect(clampLimit(5000)).toBe(AUDIT_MAX_LIMIT);
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(500)).toBe(500);
    expect(clampLimit(12.5)).toBe(AUDIT_DEFAULT_LIMIT); // non int → défaut
  });
});

describe('buildAuditListSql — sécurité SQL', () => {
  it('le texte SQL ne contient AUCUNE valeur utilisateur (params `?` uniquement)', () => {
    const injection = "x' OR 1=1; DELETE FROM audit.events; --";
    const sql = buildAuditListSql({ actor: injection, action: 'document.upload' });

    // Texte : placeholders `?` + SQL de structure uniquement.
    expect(sql.sql).not.toContain(injection);
    expect(sql.sql).toContain('actor = ?');
    expect(sql.sql).toContain('action = ?');
    // Valeurs séparées, dans l'ordre, + LIMIT en paramètre au bout.
    expect(sql.values).toEqual([injection, 'document.upload', AUDIT_DEFAULT_LIMIT]);
  });

  it('filtres combinés + FROM audit.events + ORDER BY at DESC, id DESC', () => {
    const sql = buildAuditListSql({
      actor: 'u1',
      action: 'document.upload',
      target: '42:a.pdf',
      from: '2026-10-25T00:00:00Z',
      to: '2026-10-26T00:00:00Z',
      limit: 25,
    });
    expect(sql.sql).toContain('FROM audit.events');
    expect(sql.sql).toContain('ORDER BY at DESC, id DESC');
    expect(sql.sql).toContain('at >= ?::timestamptz');
    expect(sql.sql).toContain('at <= ?::timestamptz');
    expect(sql.values).toEqual([
      'u1',
      'document.upload',
      '42:a.pdf',
      '2026-10-25T00:00:00Z',
      '2026-10-26T00:00:00Z',
      25,
    ]);
  });

  it('curseur → comparaison de tuple (at, id) < (curseur…)', () => {
    const cur = encodeCursor('2026-10-25T09:00:00.000Z', 77);
    const sql = buildAuditListSql({ cursor: cur, limit: 10 });
    expect(sql.sql).toContain('(at, id) < (');
    expect(sql.sql).toContain('?::timestamptz, ?::bigint)');
    // Convention Prisma.Sql : at passé comme timestamptz, id bigint.
    expect(sql.values).toEqual(['2026-10-25T09:00:00.000Z', 77, 10]);
  });

  it('aucun filtre → WHERE true (toutes partitions lues)', () => {
    const sql = buildAuditListSql({});
    expect(sql.sql).toContain('WHERE true');
    expect(sql.values).toEqual([AUDIT_DEFAULT_LIMIT]);
  });
});
