/*
 * Tests du paquet @alveare/audit (zone Red) — SANS BD : fake client en
 * mémoire qui modélise le comportement du template tagué Prisma
 * (marqueurs de paramètres $N + valeurs passées séparément).
 */

import { describe, expect, it } from 'vitest';
import { auditOutbox, type AuditRawClient } from '../src';

/** Appel SQL journalisé par le fake (kind : client ou tx). */
type LoggedCall = {
  kind: 'client' | 'tx';
  sql: string; // représentation du SQL avec marqueurs $1..$n
  values: unknown[]; // valeurs paramétrées, dans l'ordre
  beginOrCommit: boolean; // true si ouverture/fermeture de transaction
};

/**
 * Fake de transaction/client Prisma : reconstruit le SQL tagué comme
 * Prisma le fait (chaque `${}` devient un marqueur $N, la valeur est
 * passée à part — c'est précisément ce que ces tests épinglent).
 * La file `returningQueue` fournit, par appel, les lignes « RETURNING »
 * simulées (une file vide = INSERT sans ligne retournée).
 */
function makeFake(
  kind: 'client' | 'tx',
  returningQueue: Array<Array<{ id: bigint | number }>>,
): { client: AuditRawClient; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const nextBase = (() => {
    let counter = 0;
    return () => ++counter;
  })();
  const popRows = (): Array<{ id: bigint | number }> => {
    if (returningQueue.length === 0) {
      throw new Error('fake : file RETURNING épuisée');
    }
    return returningQueue.shift()!;
  };
  const run = <T>(
    query: TemplateStringsArray,
    values: unknown[],
  ): Promise<T[]> => {
    let sql = '';
    query.forEach((piece, i) => {
      sql += piece;
      if (i < values.length) sql += `$${nextBase() + i}`;
    });
    calls.push({
      kind,
      sql,
      values: [...values],
      beginOrCommit: /^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)/.test(
        sql.trim(),
      ),
    });
    return Promise.resolve(popRows() as T[]);
  };
  const client: AuditRawClient = {
    $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) =>
      run(q, v) as Promise<number>,
    $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) =>
      run(q, v) as Promise<Array<{ id: bigint | number }>>,
  };
  return { client, calls };
}

const entryValide = {
  actor: 'user-1',
  action: 'document.upload',
  target: 'doc-42',
  details: { taille_octets: 1024 },
};

describe('auditOutbox — forme du payload', () => {
  it('écrit un payload { actor, action, target, details } paramétré', async () => {
    const { client: tx, calls } = makeFake('tx', [[{ id: 1n }]]);
    const { client } = makeFake('client', []); // aucun appel attendu

    await auditOutbox(client, tx, [entryValide]);

    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('tx'); // l'écriture passe par la tx
    const payload = JSON.parse(calls[0].values[1] as string);
    expect(payload).toEqual({
      actor: 'user-1',
      action: 'document.upload',
      target: 'doc-42',
      details: { taille_octets: 1024 },
    });
    // pas de champ « at » implicite : now() reste la prérogative de la BD
    expect(payload.at).toBeUndefined();
  });

  it('renvoie null pour un target absent (colonne nullable)', async () => {
    const { client: tx, calls } = makeFake('tx', [[{ id: 2n }]]);
    await auditOutbox(tx, tx, { actor: 'user-1', action: 'login' });
    expect(JSON.parse(calls[0].values[1] as string).target).toBeNull();
  });

  it('routé un champ at explicite vers created_at ET le payload', async () => {
    const { client: tx, calls } = makeFake('tx', [[{ id: 3n }]]);
    await auditOutbox(tx, tx, {
      ...entryValide,
      at: '2026-10-25T10:00:00.000Z',
    });
    expect(calls[0].values[0]).toBe('2026-10-25T10:00:00.000Z');
    expect(JSON.parse(calls[0].values[1] as string).at).toBe(
      '2026-10-25T10:00:00.000Z',
    );
  });

  it('rejette une entrée invalide AVANT tout SQL (aucune écriture)', async () => {
    const { client: tx, calls } = makeFake('tx', []);
    await expect(
      auditOutbox(tx, tx, [{ actor: '', action: 'login' }]),
    ).rejects.toThrow();
    await expect(
      auditOutbox(tx, tx, [{ actor: 'user-1', action: '' }]),
    ).rejects.toThrow();
    // Garantie D-4 (revue T3.8) : le lot COMPLET est prévalidé AVANT la
    // boucle SQL — une entrée invalide, même en fin de lot, n'écrit
    // RIEN, même si les entrées précédentes sont valables.
    await expect(
      auditOutbox(tx, tx, [
        { actor: 'user-1', action: 'share.grant' },
        { actor: '', action: 'login' },
      ]),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejette un action manquant', async () => {
    const { client: tx, calls } = makeFake('tx', []);
    await expect(
      auditOutbox(tx, tx, [{ actor: 'user-1' } as never]),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('auditOutbox — mapping des ids retournés', () => {
  it("renvoie les ids outbox dans l'ordre d'entrée (mapping 1:1)", async () => {
    const { client: tx, calls } = makeFake('tx', [
      [{ id: 7n }],
      [{ id: 42n }],
    ]);
    const ids = await auditOutbox(tx, tx, [
      { actor: 'user-1', action: 'share.grant' },
      { actor: 'user-1', action: 'document.download' },
    ]);
    expect(ids).toEqual([7, 42]);
    expect(calls.map((c) => c.kind)).toEqual(['tx', 'tx']);
  });

  it("produit le rattachement outbox_source tamponné à l'INSERT (nextval)", async () => {
    const { client: tx, calls } = makeFake('tx', [[{ id: 9n }]]);
    await auditOutbox(tx, tx, { actor: 'user-1', action: 'role.delegation' });
    expect(calls[0].sql).toContain('outbox_source');
    // Garde-fou regression (piège snapshot) : le rattachement NE PEUT
    // PAS dépendre d'un UPDATE dans le même énoncé (invisible).
    expect(calls[0].sql).not.toMatch(/UPDATE[\s\S]*from/i);
  });

  it('échoue net si le RETURNING ne rapporte pas une seule ligne', async () => {
    const { client: tx, calls } = makeFake('tx', [[]]); // 0 ligne simulée
    await expect(
      auditOutbox(tx, tx, { actor: 'user-1', action: 'notify.send' }),
    ).rejects.toThrow('sans RETURNING id');
    expect(calls).toHaveLength(1);
  });
});

describe('auditOutbox — sûreté SQL brut', () => {
  it('paramétrise TOUT : marqueurs $N dans le SQL, aucun contenu utilisateur', async () => {
    const { client: tx, calls } = makeFake('tx', [[{ id: 5n }]]);

    const acteurInjecant = "attacker'); DROP TABLE audit.outbox; --";
    const detailsHostiles = {
      monde: { une_cle: "1' OR 1=1; --" },
    };

    await auditOutbox(tx, tx, {
      actor: acteurInjecant,
      action: 'document.upload',
      details: detailsHostiles,
    });

    expect(calls).toHaveLength(1);
    const { sql, values } = calls[0];

    // marqueurs de paramètres numériques présents au moins 2 fois ($1, $2)
    expect((sql.match(/\$\d+/g) ?? []).length).toBeGreaterThanOrEqual(2);

    // AUCUNE interpolation : le texte du SQL ne contient ni l'acteur ni
    // le détail hostile (ceux-ci vivent UNIQUEMENT dans les valeurs)
    expect(sql).not.toContain(acteurInjecant);
    expect(sql).not.toContain('attacker');
    expect(sql).not.toContain('une_cle');
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain(JSON.stringify(detailsHostiles));

    // ... mais passés intégralement en valeurs paramétrées
    expect(values[1]).toBe(
      JSON.stringify({
        actor: acteurInjecant,
        action: 'document.upload',
        target: null,
        details: detailsHostiles,
      }),
    );
  });

  it("n'ouvre JAMAIS de transaction lui-même (pas de begin/commit)", async () => {
    const { client: tx, calls } = makeFake('tx', [
      [{ id: 11n }],
      [{ id: 12n }],
    ]);
    await auditOutbox(tx, tx, [
      { actor: 'user-1', action: 'share.grant' },
      { actor: 'user-1', action: 'share.revoke' },
    ]);
    // le fake enregistre tout begin/commit éventuel : son absence est
    // la preuve (l'émetteur garde seul begin/commit, plan E3 §5)
    expect(calls.every((c) => !c.beginOrCommit)).toBe(true);
  });
});
