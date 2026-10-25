/*
 * Tests du signal de drain (zone Red) — fakes BullMQ : la classe Queue
 * est mockée au module (aucun Redis requis). On épingle : queue et
 * connexion transmises telles quelles, coalescence (jobId 'signal' +
 * removeOnComplete), fermeture de la queue en finally, et l'absence
 * TOTAL d'exception (fire-and-forget : false en cas d'échec).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// Import APRÈS le mock (hoisting vitest).
const { signalDrain, AUDIT_DRAIN_QUEUE } = await import('../src/drain-signal');

beforeEach(() => {
  calls.opens.length = 0;
  calls.adds.length = 0;
  calls.closes.length = 0;
  calls.throwOnAdd = false;
  calls.lastOpts = undefined;
});

describe('signalDrain', () => {
  it('enfile un job signal coalescé sur la queue audit-drain et referme', async () => {
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
    // La queue éphémère est refermée (aucune socket qui traîne).
    expect(calls.closes).toEqual([1]);
  });

  it('queue sur-mesure acceptée (nom passé tel quel)', async () => {
    await signalDrain({ host: 'localhost' }, { queueName: 'audit-drain-test' });
    expect(calls.opens).toEqual(['audit-drain-test']);
  });

  it('ne lève JAMAIS : erreur add() → false, close quand même (fire-and-forget)', async () => {
    calls.throwOnAdd = true;
    const ok = await signalDrain({ host: 'localhost' });
    expect(ok).toBe(false);
    // Close quand même : finally, même sur chemin d'exception.
    expect(calls.closes).toEqual([1]);
  });
});
