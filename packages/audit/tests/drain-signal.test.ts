/*
 * Tests du signal de drain (zone Red) — fakes BullMQ : la classe Queue
 * est mockée au module (aucun Redis requis). On épingle : queue et
 * connexion transmises telles quelles, coalescence (jobId 'signal' +
 * removeOnComplete), RÉUTILISATION de la queue partagée (revue T3.8
 * R-1 : une seule ouverture par nom, jamais refermée), et l'absence
 * TOTAL d'exception (fire-and-forget : false + console.warn en cas
 * d'échec, jamais muet).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Fake Queue (interception avant le vrai module bullmq) -------------
const calls = {
  opens: [] as string[],
  adds: [] as { name: string; data: unknown; opts: unknown }[],
  closes: [] as number[],
  /** Contrôle par-test du comportement de add(). */
  throwOnAdd: false,
  lastOpts: undefined as undefined | { connection?: unknown },
};

vi.mock('bullmq', async () => {
  class Queue {
    constructor(name: string, opts?: { connection?: unknown }) {
      calls.opens.push(name);
      calls.lastOpts = opts;
    }
    add(name: string, data: unknown, opts: unknown) {
      if (calls.throwOnAdd) return Promise.reject(new Error('redis down'));
      calls.adds.push({ name, data, opts });
      return Promise.resolve({ name, data, opts });
    }
    close() {
      calls.closes.push(1);
      return Promise.resolve();
    }
  }
  return { Queue };
});

// Le module garde la QUEUE PARTAGÉE en état process (Map nom→Queue,
// revue T3.8 R-1) — chaque test repart donc d'un module FRAIS
// (vi.resetModules + re-import) : le mock bullmq reste en place et la
// Map repart vide, comme un processus vierge.
let signalDrain: typeof import('../src/drain-signal').signalDrain;
let AUDIT_DRAIN_QUEUE: string;

beforeEach(async () => {
  calls.opens.length = 0;
  calls.adds.length = 0;
  calls.closes.length = 0;
  calls.throwOnAdd = false;
  calls.lastOpts = undefined;
  vi.resetModules();
  ({ signalDrain, AUDIT_DRAIN_QUEUE } = await import('../src/drain-signal'));
});

// L'espion console.warn est restauré après chaque test (aucun bruit
// résiduel dans les autres suites).
const warnSpy = vi.spyOn(console, 'warn');
afterEach(() => {
  warnSpy.mockRestore();
});

describe('signalDrain', () => {
  it('enfile un job signal coalescé sur la queue audit-drain (connexion transmise telle quelle)', async () => {
    const conn = { host: 'localhost', port: 6379 };
    const ok = await signalDrain(conn, { source: 'documents' });

    expect(ok).toBe(true);
    // Queue UNIQUEMENT le contrat : nom par défaut audit-drain.
    expect(calls.opens).toEqual([AUDIT_DRAIN_QUEUE]);
    expect(AUDIT_DRAIN_QUEUE).toBe('audit-drain');
    // La connexion est passée telle quelle (aucun conteneur nouveau —
    // REDIS_URL du compose existant, plan E3 §4).
    expect(calls.lastOpts?.connection).toBe(conn);
    // Coalescence : jobId fixe + removeOnComplete (un seul signal
    // en attente).
    expect(calls.adds).toHaveLength(1);
    expect(calls.adds[0]).toMatchObject({
      name: 'signal',
      data: { source: 'documents' },
      opts: { jobId: 'signal' },
    });
    expect(
      (calls.adds[0].opts as { removeOnComplete: object }).removeOnComplete,
    ).toBeTruthy();
  });

  it('REUTILISE la queue partagée (revue T3.8 R-1) : un signal n\'ouvre ni ne referme une queue', async () => {
    const conn = { host: 'localhost' };
    await signalDrain(conn);
    await signalDrain(conn, { source: 'identity' });

    // Deux signaux → UNE SEULE création de queue (création paresseuse
    // au premier appel, réutilisée ensuite).
    expect(calls.opens).toEqual([AUDIT_DRAIN_QUEUE]);
    expect(calls.adds).toHaveLength(2);
    // La queue est une ressource du processus : JAMAIS refermée
    // (rapproche chaque signal d'une socket éphémère).
    expect(calls.closes).toEqual([]);
  });

  it('queue sur-mesure acceptée (nom distinct → une autre queue partagée)', async () => {
    await signalDrain({ host: 'localhost' }, { queueName: 'audit-drain-test' });
    await signalDrain({ host: 'localhost' }, { queueName: 'audit-drain-test' });
    // Seule la queue du nom demandé est ouverte, une seule fois.
    expect(calls.opens).toEqual(['audit-drain-test']);
  });

  it('ne lève JAMAIS : erreur add() → false + console.warn avec la raison', async () => {
    const warn = vi.spyOn(console, 'warn');
    calls.throwOnAdd = true;
    const ok = await signalDrain({ host: 'localhost' });
    expect(ok).toBe(false);
    // Revue T3.8 R-1 : l'échec est avalé mais JAMAIS muet — la raison
    // (redis down) apparaît dans le warn.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('enfilage raté'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('redis down'));
    // Pas de refermeture : la queue partagée reste en place.
    expect(calls.closes).toEqual([]);
  });
});
