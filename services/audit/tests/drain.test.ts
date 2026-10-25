/*
 * E3 T3.7 — tests vitest du cœur de drain (zone Red). SANS BD ni
 * Redis : fake tx qui modélise le template tagué Prisma (marqueurs
 * $N + valeurs séparées, même gabarit que packages/audit/tests) et
 * scripte REPLY-calendrier des SELECT / INSERT / UPDATE.
 *
 * Pinné ici (plan T3.7 + correctifs revue T3.8 S-2) :
 *   * lot verrouillé : SELECT … WHERE delivered = false
 *     AND attempts < cap ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED
 *     (cap = AUDIT_ATTEMPTS_CAP, paramétré — pas de retry infini) ;
 *   * routage de partition : la valeur `at` (payload.at sinon
 *     created_at) est le 1er paramètre de l'INSERT — c'est elle qui
 *     place la ligne dans la partition du mois correspondant ;
 *   * idempotence : INSERT … ON CONFLICT (outbox_id, at) DO NOTHING ;
 *   * delivered=true UNIQUEMENT pour les lignes traitées (insérées ou
 *     déjà présentes) ; attempts++ pour la ligne en échec uniquement ;
 *   * QUARANTAINE (S-2) : après le lot, les lignes à attempts >= cap
 *     partent EN DEAD-LETTER — copie INSERT (payload tel quel, raison)
 *     puis DELETE du outbox, énoncés séparés dans la même transaction,
 *     jamais re-sélectionnées, jamais silencieuses ; le drain continue
 *     de fonctionner normalement ;
 *   * sweep vide = aucune écriture, aucun spin (drainUntilEmpty).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAIN_BATCH_SIZE,
  drainBatch,
  drainUntilEmpty,
  quarantineExhausted,
  attemptsCap,
  QUARANTINE_REASON,
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
  deadletterSelect: /SELECT id, attempts, payload\s+FROM audit\.outbox/,
  deadletterInsert: /INSERT INTO audit\.outbox_deadletter/,
  deadletterDelete: /DELETE FROM audit\.outbox WHERE id/,
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
 * ou fonction jetant = ligne réfractaire), `quarantines` la file des
 * résultats du SELECT de quarantaine (absent = lot vide).
 */
function makeFakeTx(opts: {
  sweeps: Array<Array<{ id: bigint; created_at: Date; payload: object }>>;
  inserts: Array<() => Array<{ outbox_id: number }>>;
  quarantines?: Array<Array<{ id: bigint; attempts: number; payload: object }>>;
}): { tx: DrainRawClient; stmts: Stmt[] } {
  const stmts: Stmt[] = [];
  let sweepIdx = 0;
  let insertIdx = 0;
  const quarantines = opts.quarantines ?? [];
  let qIdx = 0;

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
      if (MATCH.deadletterSelect.test(s.sql)) {
        const q0 = quarantines[qIdx++];
        return (q0 ?? []) as T[];
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
      if (MATCH.deadletterInsert.test(s.sql) || MATCH.deadletterDelete.test(s.sql)) return 1;
      throw new Error(`fake : $executeRaw inattendu : ${s.sql}`);
    },
  };
  return { tx: fakeTx, stmts };
}

const at = (iso: string) => new Date(iso);

// AUDIT_ATTEMPTS_CAP est lu À CHAQUE drainBatch (env à chaud) : chaque
// test restaure la variable d'origine (aucune fuite inter-suites).
const CAP_SAUV = process.env.AUDIT_ATTEMPTS_CAP;
afterEach(() => {
  if (CAP_SAUV === undefined) delete process.env.AUDIT_ATTEMPTS_CAP;
  else process.env.AUDIT_ATTEMPTS_CAP = CAP_SAUV;
});

describe('attemptsCap — plafond de quarantaine (S-2)', () => {
  it('défaut 5 ; env respectée si entier > 0 ; invalide ou ≤ 0 → défaut', () => {
    delete process.env.AUDIT_ATTEMPTS_CAP;
    expect(attemptsCap()).toBe(5);
    process.env.AUDIT_ATTEMPTS_CAP = '3';
    expect(attemptsCap()).toBe(3);
    process.env.AUDIT_ATTEMPTS_CAP = '0';
    expect(attemptsCap()).toBe(5); // un cap nul viderait le outbox : refusé
    process.env.AUDIT_ATTEMPTS_CAP = '-2';
    expect(attemptsCap()).toBe(5);
    process.env.AUDIT_ATTEMPTS_CAP = 'abc';
    expect(attemptsCap()).toBe(5); // parseInt diverge → défaut
    process.env.AUDIT_ATTEMPTS_CAP = '1.5';
    expect(attemptsCap()).toBe(5); // non entier → défaut
  });
});

describe('drainBatch — lot verrouillé', () => {
  it('le SELECT du lot utilise FOR UPDATE SKIP LOCKED + delivered=false + tentatives sous le plafond', async () => {
    const { tx, stmts } = makeFakeTx({
      sweeps: [[]],
      inserts: [],
    });
    const stats = await drainBatch(tx);

    // Sweep vide : select du lot + passe de quarantaine (scriptée
    // vide par défaut) — rien d'autre.
    expect(stats).toEqual({ scanned: 0, inserted: 0, deduped: 0, failed: 0, quarantined: 0 });
    expect(stmts).toHaveLength(2);
    const sel = stmts[0].sql;
    expect(sel).toContain('WHERE delivered = false');
    expect(sel).toContain('AND attempts < $1'); // pas de ré-sélection au-delà du plafond
    expect(sel).toContain('ORDER BY id');
    expect(sel).toContain('LIMIT $2'); // LIMIT paramétré ($2), pas littéral
    expect(sel).toContain('FOR UPDATE SKIP LOCKED');
    expect(stmts[0].values[0]).toBe(5); // plafond par défaut en paramètre
    // La taille du lot est bien la constante planifiée (LIMIT 100).
    expect(DRAIN_BATCH_SIZE).toBe(100);
    // Aucune valeur interpolée : le SQL de verrouillage est figé.
    expect(sel).not.toMatch(/LIMIT 100/);
  });

  it('le plafond lu dans AUDIT_ATTEMPTS_CAP paramètre le SELECT et la quarantaine', async () => {
    process.env.AUDIT_ATTEMPTS_CAP = '3';
    const { tx, stmts } = makeFakeTx({ sweeps: [[]], inserts: [] });
    await drainBatch(tx);
    // Les DEUX énoncés utilisent la même valeur : re-sélection du
    // drain (attempts < 3) et quarantaine (attempts >= 3) se partagent
    // EXACTEMENT la frontière 3 — aucune ligne perdue entre les deux.
    expect(stmts[0].values[0]).toBe(3);
    expect(stmts[1].values[0]).toBe(3);
    expect(stmts[1].sql).toContain('AND attempts >= $1');
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

    expect(stats).toEqual({ scanned: 1, inserted: 1, deduped: 0, failed: 0, quarantined: 0 });
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

    expect(stats).toEqual({ scanned: 3, inserted: 1, deduped: 1, failed: 1, quarantined: 0 });
    const delivered = stmts.filter((s) => MATCH.delivered.test(s.sql));
    expect(delivered.map((s) => s.values[0]).sort()).toEqual([1, 2]);
    // La ligne 3 n'a PAS été flip deliverée (re-scannée au sweep
    // suivant).
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
    const batches: Array<{ scanned: number; inserted: number; deduped: number; failed: number; quarantined: number }> = [
      { scanned: 100, inserted: 100, deduped: 0, failed: 0, quarantined: 0 },
      { scanned: 30, inserted: 28, deduped: 2, failed: 0, quarantined: 0 },
    ];
    let i = 0;
    const stats = await drainUntilEmpty(async () => batches[i++]);
    expect(i).toBe(2);
    expect(stats).toEqual({ scanned: 130, inserted: 128, deduped: 2, failed: 0, quarantined: 0 });
  });

  it('s’arrête sur un lot avec échecs (pas de spin sur la ligne réfractaire)', async () => {
    let i = 0;
    const stats = await drainUntilEmpty(async () =>
      i++ === 0
        ? { scanned: 100, inserted: 99, deduped: 0, failed: 1, quarantined: 0 }
        : { scanned: 0, inserted: 0, deduped: 0, failed: 0, quarantined: 0 },
    );
    expect(i).toBe(1); // un seul lot : pas de relance immédiate
    expect(stats.failed).toBe(1);
  });
});

describe('quarantaine — dead-letter des lignes réfractaires (S-2)', () => {
  it('une ligne au plafond part en dead-letter (payload tel quel, raison tracée) puis sort du outbox', async () => {
    const poison = { action: '__poison__' }; // jamais conforme AuditEntry
    const errSpy = vi.spyOn(console, 'error');
    const { tx, stmts } = makeFakeTx({
      sweeps: [
        // Sweep 1 : le lot contient la ligne empoisonnée (échec d'INSERT).
        [{ id: BigInt(3), created_at: at('2026-10-01T00:00:00Z'), payload: poison }],
        // Sweep 2 : cette ligne n'est PLUS re-sélectionnée (vide).
        [],
      ],
      inserts: [
        () => {
          throw new Error('payload non conforme AuditEntry');
        },
      ],
      quarantines: [
        // À attempts = plafond : la passe de quarantaine la récupère.
        [{ id: BigInt(3), attempts: 5, payload: poison }],
        // Sweep 2 : plus rien à mettre en quarantaine.
        [],
      ],
    });

    const batch1 = await drainBatch(tx);
    expect(batch1).toEqual({ scanned: 1, inserted: 0, deduped: 0, failed: 1, quarantined: 1 });

    // INSERT en dead-letter : id, attempts, payload TEL QUEL, raison
    // « plafond de tentatives atteint » — puis DELETE du outbox.
    const ins = stmts.find((s) => MATCH.deadletterInsert.test(s.sql))!;
    expect(ins).toBeTruthy();
    expect(ins.values).toEqual([3, 5, JSON.stringify(poison), QUARANTINE_REASON]);
    const del = stmts.find((s) => MATCH.deadletterDelete.test(s.sql))!;
    expect(del.values).toEqual([3]);
    // Ordre garanti : la copie PRÉCÈDE la suppression (jamais l'inverse).
    expect(stmts.indexOf(ins)).toBeLessThan(stmts.indexOf(del));

    // JAMAIS silencieux : log structuré avec le nombre mis en quarantaine.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('quarantaine de 1 ligne(s) réfractaire(s) (attempts>=5)'),
    );
    errSpy.mockRestore();

    // Sweep 2 : le drain continue NORMALEMENT — et la ligne est bel et
    // bien hors du outbox (aucune nouvelle re-sélection, aucun outbox
    // empoisonné).
    const batch2 = await drainBatch(tx);
    expect(batch2).toEqual({ scanned: 0, inserted: 0, deduped: 0, failed: 0, quarantined: 0 });
    // Exactement UN SELECT de lot au sweep 2 — il ne rapporte rien, donc
    // la ligne n'apparaîtra plus jamais.
    const sweepSelects = stmts.filter((s) => MATCH.select.test(s.sql));
    expect(sweepSelects).toHaveLength(2);
  });

  it('sous le plafond : aucune quarantaine (la ligne retente au sweep suivant)', async () => {
    const errSpy = vi.spyOn(console, 'error');
    const { tx, stmts } = makeFakeTx({
      sweeps: [
        [{ id: BigInt(9), created_at: at('2026-10-02T00:00:00Z'), payload: { nope: true } }],
      ],
      inserts: [() => { throw new Error('boom'); }],
      quarantines: [[]], // attempts (2) < plafond : rien sélectionné
    });

    const stats = await drainBatch(tx);
    expect(stats.quarantined).toBe(0);
    // Ni INSERT dead-letter, ni DELETE du outbox.
    expect(stmts.some((s) => MATCH.deadletterInsert.test(s.sql))).toBe(false);
    expect(stmts.some((s) => MATCH.deadletterDelete.test(s.sql))).toBe(false);
    // Pas de log de quarantaine quand il n'y a rien à mettre en
    // quarantaine.
    expect(errSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('quarantaine de'),
    );
    errSpy.mockRestore();
  });

  it('quarantineExhausted appelée directement : DEUX énoncés séparés (jamais de CTE lectrice)', async () => {
    const { tx, stmts } = makeFakeTx({
      sweeps: [],
      inserts: [],
      quarantines: [[{ id: BigInt(4), attempts: 7, payload: { actor: 'x', action: 'y' } }]],
    });
    const n = await quarantineExhausted(tx, 5);
    expect(n).toBe(1);
    const all = stmts.map((s) => s.sql);
    // Garde anti-piège de snapshot (cf. @alveare/audit) : la copie et la
    // suppression sont DEUX énoncés DISTINCTS — aucun "WITH … INSERT …
    // DELETE" mélangé.
    expect(all.some((q) => /INSERT INTO audit\.outbox_deadletter/.test(q) && /DELETE/.test(q))).toBe(false);
    expect(all.some((q) => /^DELETE FROM audit\.outbox WHERE id = \$1::bigint/.test(q))).toBe(true);
  });
});
