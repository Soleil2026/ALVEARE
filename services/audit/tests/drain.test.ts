/*
 * E3 T3.7 — tests vitest du cœur de drain (zone Red). SANS BD ni
 * Redis : fake tx qui modélise le template tagué Prisma (marqueurs
 * $N + valeurs séparées, même gabarit que packages/audit/tests) et
 * scripte REPLY-calendrier des SELECT / INSERT / UPDATE.
 *
 * Pinné ici (plan T3.7) :
 *   * lot verrouillé : SELECT … WHERE delivered = false ORDER BY id
 *     LIMIT 100 FOR UPDATE SKIP LOCKED ;
 *   * routage de partition : la valeur `at` (payload.at sinon
 *     created_at) est le 1er paramètre de l'INSERT — c'est elle qui
 *     place la ligne dans la partition du mois correspondant ;
 *   * idempotence : INSERT … ON CONFLICT (outbox_id, at) DO NOTHING ;
 *   * delivered=true UNIQUEMENT pour les lignes traitées (insérées ou
 *     déjà présentes) ; attempts++ pour la ligne en échec uniquement ;
 *   * sweep vide = aucune écriture, aucun spin (drainUntilEmpty).
 */

import { describe, expect, it } from 'vitest';
import {
  DRAIN_BATCH_SIZE,
  drainBatch,
  drainUntilEmpty,
  type DrainRawClient,
} from '../src/drain';

/** Énoncé SQL journalisé par le fake. */
type Stmt = {
  sql: string; // avec marqueurs $1..$n (aucune valeur interpolée)
  values: unknown[];
  execute: boolean; // $executeRaw sinon $queryRaw
};

const MATCH = {
  select: /SELECT id, created_at, payload\s+FROM audit\.outbox/,
  insert: /INSERT INTO audit\.events/,
  savepoint: /^SAVEPOINT drain_row/,
  rollback: /^ROLLBACK TO SAVEPOINT drain_row/,
  delivered: /UPDATE audit\.outbox SET delivered/,
  attempts: /UPDATE audit\.outbox SET attempts/,
};

function renderSql(q: TemplateStringsArray, values: unknown[]): string {
  let sql = '';
  q.forEach((piece, i) => {
    sql += piece;
    if (i < values.length) sql += `$${i + 1}`;
  });
  return sql;
}

/**
 * Fake de transaction Prisma : scripts par fenêtre — `sweeps` est une
 * file de « résultats de SELECT verrouillé » (une entrée par sweep),
 * `inserts` une file de comportements par INSERT (tableau RETURNING,
 * ou fonction jetant = ligne réfractaire).
 */
function makeFakeTx(opts: {
  sweeps: Array<Array<{ id: bigint; created_at: Date; payload: object }>>;
  inserts: Array<() => Array<{ outbox_id: number }>>;
}): { tx: DrainRawClient; stmts: Stmt[] } {
  const stmts: Stmt[] = [];
  let sweepIdx = 0;
  let insertIdx = 0;

  const record = (q: TemplateStringsArray, v: unknown[], ex: boolean): Stmt => {
    const s = { sql: renderSql(q, v), values: [...v], execute: ex };
    stmts.push(s);
    return s;
  };

  const fakeTx: DrainRawClient = {
    // Simule : Prisma compile le tag en paramètres $N (jamais d'inline).
    async $queryRaw<T = unknown>(q, ...v): Promise<T[]> {
      const s = record(q, v, false);
      if (MATCH.select.test(s.sql)) {
        // Récupère depuis la file de sweeps (script épuisé = test KO).
        const sweep = opts.sweeps[sweepIdx++];
        if (sweep === undefined) throw new Error('fake : file de sweeps épuisée');
        return sweep as T[];
      }
      if (MATCH.insert.test(s.sql)) {
        const next = opts.inserts[insertIdx++];
        if (next === undefined) throw new Error('fake : file INSERT épuisée');
        return next() as T[];
      }
      throw new Error(`fake : $queryRaw inattendu : ${s.sql}`);
    },
    async $executeRaw(q: TemplateStringsArray, ...v: unknown[]): Promise<number> {
      const s = record(q, v, true);
      if (MATCH.savepoint.test(s.sql) || MATCH.rollback.test(s.sql)) return 1;
      if (MATCH.delivered.test(s.sql) || MATCH.attempts.test(s.sql)) return 1;
      throw new Error(`fake : $executeRaw inattendu : ${s.sql}`);
    },
  };
  return { tx: fakeTx, stmts };
}

const at = (iso: string) => new Date(iso);

describe('drainBatch — lot verrouillé', () => {
  it('le SELECT du lot utilise FOR UPDATE SKIP LOCKED + delivered=false + ORDER BY id', async () => {
    const { tx, stmts } = makeFakeTx({
      sweeps: [[]],
      inserts: [],
    });
    const stats = await drainBatch(tx);

    expect(stats).toEqual({ scanned: 0, inserted: 0, deduped: 0, failed: 0 });
    expect(stmts).toHaveLength(1); // sweep vide : select seul, rien d'autre
    const sel = stmts[0].sql;
    expect(sel).toContain('WHERE delivered = false');
    expect(sel).toContain('ORDER BY id');
    expect(sel).toContain('LIMIT $1'); // LIMIT paramétré ($1), pas littéral
    expect(sel).toContain('FOR UPDATE SKIP LOCKED');
    // La taille du lot est bien la constante planifiée (LIMIT 100).
    expect(DRAIN_BATCH_SIZE).toBe(100);
    // Aucune valeur interpolée : le SQL de verrouillage est figé.
    expect(sel).not.toMatch(/LIMIT 100/);
  });
});

describe('drainBatch — insertion partitionnée idempotente', () => {
  it('la valeur `at` (=> partition du mois) = payload.at, 1er paramètre de l’INSERT', async () => {
    const payloadAt = '2026-02-15T08:30:00.000Z';
    const { tx, stmts } = makeFakeTx({
      sweeps: [
        [
          {
            id: BigInt(11),
            created_at: at('2026-02-15T08:30:00.001Z'),
            payload: {
              actor: 'auth|u1',
              action: 'document.upload',
              target: '42:rapport.pdf',
              details: null,
              at: payloadAt,
              outbox_source: 11,
            },
          },
        ],
      ],
      inserts: [() => [{ outbox_id: 11 }]],
    });
    const stats = await drainBatch(tx);

    expect(stats).toEqual({ scanned: 1, inserted: 1, deduped: 0, failed: 0 });
    const ins = stmts.find((s) => MATCH.insert.test(s.sql))!;
    expect(ins).toBeTruthy();
    expect(ins.sql).toContain('ON CONFLICT (outbox_id, at) DO NOTHING');
    expect(ins.sql).toContain('INSERT INTO audit.events');
    expect(ins.sql).toContain('outbox_id)'); // colonnes liées au drain
    // Le `at` de la ligne pilote le routage de partition (grain mensuel) :
    // il arrive EN PARAMÈTRE ($1::timestamptz), jamais interpolé.
    expect(ins.values[0]).toBe(payloadAt);
    expect(ins.sql).toContain('$1::timestamptz');
    expect(ins.values).toEqual([
      payloadAt,
      'auth|u1',
      'document.upload',
      '42:rapport.pdf',
      null, // details null → paramètre null
      11,
    ]);
  });

  it('created_at de l’outbox remplace payload at absent (valeur STABLE => idempotence)', async () => {
    const created = at('2026-03-01T12:00:00.000Z');
    const { tx, stmts } = makeFakeTx({
      sweeps: [
        [
          {
            id: BigInt(7),
            created_at: created,
            payload: { actor: 'u', action: 'consent.grant', target: null, details: { scope: 'e2e' } },
          },
        ],
      ],
      inserts: [() => [{ outbox_id: 7 }]],
    });
    await drainBatch(tx);
    const ins = stmts.find((s) => MATCH.insert.test(s.sql))!;
    // Instable : si on reprenait now(), le (outbox_id, at) du re-drain
    // ne conflitait plus => doublons. created_at est la clé stable.
    expect(ins.values[0]).toBe(created.toISOString());
    expect(ins.values[4]).toBe(JSON.stringify({ scope: 'e2e' }));
  });
});

describe('drainBatch — livraison (delivered) et échecs (attempts)', () => {
  it('delivered pour insérées ET doublons (idempotence) ; attempts++ pour l’échec seules', async () => {
    const { tx, stmts } = makeFakeTx({
      sweeps: [
        [
          { id: BigInt(1), created_at: at('2026-01-10T00:00:00Z'), payload: { actor: 'a', action: 'x1', target: null, details: null } },
          { id: BigInt(2), created_at: at('2026-01-10T00:00:01Z'), payload: { actor: 'b', action: 'x2', target: null, details: null } }, // doublon
          { id: BigInt(3), created_at: at('2026-01-10T00:00:02Z'), payload: { nope: true } }, // réfractaire
        ],
      ],
      inserts: [
        () => [{ outbox_id: 1 }], // INSERT avec RETURNING → insérée
        () => [], // conflit (outbox_id, at) → déjà présente : deduped
        () => {
          throw new Error('payload non conforme AuditEntry');
        },
      ],
    });
    const stats = await drainBatch(tx);

    expect(stats).toEqual({ scanned: 3, inserted: 1, deduped: 1, failed: 1 });
    const delivered = stmts.filter((s) => MATCH.delivered.test(s.sql));
    expect(delivered.map((s) => s.values[0]).sort()).toEqual([1, 2]);
    // La ligne 3 n'a PAS été flip deliverée (re-scanner au next sweep).
    expect(delivered.map((s) => s.values[0])).not.toContain(3);
    const attempted = stmts.filter((s) => MATCH.attempts.test(s.sql));
    expect(attempted.map((s) => s.values[0])).toEqual([3]);
    // Savepoint posé 3× et annulé 1× (l'échec n'empoisonne rien).
    expect(stmts.filter((s) => MATCH.savepoint.test(s.sql))).toHaveLength(3);
    expect(stmts.filter((s) => MATCH.rollback.test(s.sql))).toHaveLength(1);
  });
});

describe('drainUntilEmpty — boucle du sweep', () => {
  it('enchaîne les lots jusqu’à un incomplet (fin de outbox) et cumule les stats', async () => {
    const batches: Array<{ scanned: number; inserted: number; deduped: number; failed: number }> = [
      { scanned: 100, inserted: 100, deduped: 0, failed: 0 },
      { scanned: 30, inserted: 28, deduped: 2, failed: 0 },
    ];
    let i = 0;
    const stats = await drainUntilEmpty(async () => batches[i++]);
    expect(i).toBe(2);
    expect(stats).toEqual({ scanned: 130, inserted: 128, deduped: 2, failed: 0 });
  });

  it('s’arrête sur un lot avec échecs (pas de spin sur la ligne réfractaire)', async () => {
    let i = 0;
    const stats = await drainUntilEmpty(async () =>
      i++ === 0
        ? { scanned: 100, inserted: 99, deduped: 0, failed: 1 }
        : { scanned: 0, inserted: 0, deduped: 0, failed: 0 },
    );
    expect(i).toBe(1); // un seul lot : pas de relance immédiate
    expect(stats.failed).toBe(1);
  });
});
