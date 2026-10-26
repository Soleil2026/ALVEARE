/**
 * E6 T4.4 — worker paiements : livraisons webhook SORTANTES signées
 * (HMAC X-ALVEARE-Signature), plafond de tentatives → payments.
 * webhook_dead (S-2 : jamais silencieux), sweep expiry (machine à
 * états + trace audit), simulateur dev. Le boot Nest est neutralisé
 * (NestFactory mocké) et tout le SQL passe par des mocks du store :
 * ZÉRO BD, ZÉRO Redis, ZÉRO réseau réel (fetch systématiquement
 * stubbé). Zone Red : revue indépendante obligatoire.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

// Bootstrap民法典 inert : NestFactory.create → app factice, listen →
// promesse jamais résolue (aucun port, aucun worker réel).
vi.mock('@nestjs/core', () => {
  const appStub = {
    enableShutdownHooks: vi.fn(),
    listen: vi.fn(() => new Promise(() => undefined)),
  };
  return { NestFactory: { create: vi.fn(async () => appStub) } };
});

vi.mock('../src/store', () => ({
  insertTxn: vi.fn(),
  getTxnById: vi.fn(),
  getTxnByAppRef: vi.fn(),
  getTxnByProviderRef: vi.fn(),
  lockTxnById: vi.fn(),
  applyStatus: vi.fn(),
  listPending: vi.fn(),
  listAdmin: vi.fn(),
  claimRefund: vi.fn(),
  getRefund: vi.fn(),
  getEndpoint: vi.fn(),
  insertWebhookDead: vi.fn(),
}));

vi.mock('@alveare/audit', () => ({
  auditOutbox: vi.fn(async () => [101]),
  signalDrain: vi.fn(async () => true),
}));

import { PaymentsWorkerService } from '../src/main';
import * as store from '../src/store';
import { auditOutbox } from '@alveare/audit';
import {
  IllegalTransitionError,
  makeDevProvider,
  verifyOutbound,
} from '@alveare/payments';

const SECRET = 'app-webhook-secret-e2e-DO-NOT-LOG';
const ENDPOINT = {
  url: 'http://127.0.0.1:46080/hooks/app-01',
  enabled: true,
  secret: SECRET,
};

const PAYLOAD = {
  event_uid: 'evt-uid-1',
  event: 'payment.paid' as const,
  payment_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
  app: 'app-01',
  app_ref: 'CMD-2026-1',
  status: 'paid' as const,
  amount: '10000',
  refunded_amount: '0',
  currency: 'DZD',
  ts: '2026-10-25T12:00:00.000Z',
};

const MOCKED_STORE = store as unknown as Record<
  string,
  ReturnType<typeof vi.fn> & { mockReset: () => void }
>;

function makeFakePrisma() {
  return { $transaction: (cb: (tx: unknown) => unknown) => cb({}) };
}

function makeJob(
  data: unknown,
  attemptsMade = 0,
): Job<unknown, unknown, string> {
  return {
    name: 'deliver',
    id: `wh:${(data as { event_uid?: string }).event_uid ?? 'inconnu'}`,
    attemptsMade,
    data,
  } as unknown as Job<unknown, unknown, string>;
}

/** Toutes les saises console (log/warn/error) sérialisées — pour
 * prouver ce qui est JAMAIS loggé (secret) et ce qui EST loggé. */
function allLoggedText(): string {
  const parts: string[] = [];
  for (const spy of [console.log, console.warn, console.error]) {
    for (const call of spy.mock.calls) parts.push(JSON.stringify(call));
  }
  return parts.join('\n');
}

function rowFixture(patch: Record<string, unknown> = {}) {
  return {
    id: 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2',
    app: 'app-01',
    app_ref: 'CMD-2026-1',
    status: 'pending',
    amount: '10000',
    currency: 'DZD',
    rail: 'dzd',
    just_ref: null,
    provider: 'dev',
    provider_ref: 'dev-b2b2',
    event_uid: null,
    receipt_ref: null,
    fee_amount: null,
    refunded: '0',
    created_at: new Date(),
    paid_at: null,
    closed_at: null,
    ...patch,
  };
}

let worker: PaymentsWorkerService & {
  queue: { add: ReturnType<typeof vi.fn> };
};
let fetchMock: ReturnType<typeof vi.fn>;
let dirOutbox: string;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PAYMENTS_WEBHOOK_ATTEMPTS_CAP', '5');
  vi.stubEnv('PAYMENTS_TTL_SECONDS', '1200');
  dirOutbox = mkdtempSync(join(tmpdir(), 'alv-pay-tests-'));
  vi.stubEnv('PAYMENTS_DEV_OUTBOX', join(dirOutbox, 'dev.jsonl'));

  for (const key of Object.keys(MOCKED_STORE)) MOCKED_STORE[key].mockReset();
  vi.mocked(auditOutbox).mockReset();
  vi.mocked(auditOutbox).mockImplementation(async () => [101]);

  worker = Object.assign(new PaymentsWorkerService(makeFakePrisma()), {
    providerImpl: makeDevProvider(),
    queue: { add: vi.fn(async () => ({})) },
    connection: {},
  }) as unknown as PaymentsWorkerService & { queue: { add: ReturnType<typeof vi.fn> } };

  console.log = vi.spyOn(console, 'log').mockImplementation(() => undefined) as never;
  console.warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as never;
  console.error = vi.spyOn(console, 'error').mockImplementation(() => undefined) as never;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dirOutbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// Livraison signée (Q4) : HMAC sur le corps brut exact, secret muet.
// ---------------------------------------------------------------------
describe('deliver — livraison signée vers l app', () => {
  it('200 → delivered ; POST vers la bonne URL avec un entête t/v1 valide', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    MOCKED_STORE.getEndpoint.mockResolvedValue(ENDPOINT);

    const out = await worker['deliver'](makeJob(PAYLOAD));

    expect(out).toEqual({ delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT.url);
    expect(init.method).toBe('POST');
    expect(init.headers['X-ALVEARE-Signature']).toMatch(/^t=\d+, v1=[0-9a-f]{64}$/);
    expect(init.body).toBe(JSON.stringify(PAYLOAD)); // corps BRUT exact
  });

  it('l entête t/v1 est re-vérifiable avec le SECRET DE L APP (bout en bout)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    MOCKED_STORE.getEndpoint.mockResolvedValue(ENDPOINT);
    await worker['deliver'](makeJob(PAYLOAD));
    const header = fetchMock.mock.calls[0][1].headers['X-ALVEARE-Signature'];
    expect(
      verifyOutbound(SECRET, JSON.stringify(PAYLOAD), header, { skew: 300 }),
    ).toBe(true);
  });

  it('une signature dérivée d un AUTRE secret est rejetée par l app', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    MOCKED_STORE.getEndpoint.mockResolvedValue({
      ...ENDPOINT,
      secret: 'WRONG-APP-SECRET',
    });
    await worker['deliver'](makeJob(PAYLOAD));
    const header = fetchMock.mock.calls[0][1].headers['X-ALVEARE-Signature'];
    expect(
      verifyOutbound(SECRET, JSON.stringify(PAYLOAD), header, { skew: 300 }),
    ).toBe(false);
  });

  it('le secret est présent NI dans les en-têtes transmis NI dans aucun log',
    async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
      MOCKED_STORE.getEndpoint.mockResolvedValue(ENDPOINT);
      await worker['deliver'](makeJob(PAYLOAD));
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(JSON.stringify(headers)).not.toContain(SECRET);
      expect(allLoggedText()).not.toContain(SECRET);
    });

  it('success → trace audit payment.webhook.sent (règle d or n°6)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    MOCKED_STORE.getEndpoint.mockResolvedValue(ENDPOINT);
    await worker['deliver'](makeJob(PAYLOAD));
    expect(auditOutbox).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(auditOutbox).mock.calls[0][2];
    expect(entry).toMatchObject({
      actor: 'system:payments-webhook',
      action: 'payment.webhook.sent',
      target: PAYLOAD.payment_id,
      details: { event_uid: PAYLOAD.event_uid, app: PAYLOAD.app },
    });
  });

  it('endpoint absent → skip propre (ni réseau, ni DLQ, mais JAMAIS muet)', async () => {
    MOCKED_STORE.getEndpoint.mockResolvedValue(null);
    const out = await worker['deliver'](makeJob(PAYLOAD));
    expect(out).toEqual({ delivered: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MOCKED_STORE.insertWebhookDead).not.toHaveBeenCalled();
    expect(allLoggedText()).toMatch(/endpoint_absent/);
  });

  it('endpoint désactivé → même skip', async () => {
    MOCKED_STORE.getEndpoint.mockResolvedValue({ ...ENDPOINT, enabled: false });
    const out = await worker['deliver'](makeJob(PAYLOAD));
    expect(out).toEqual({ delivered: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Échecs → retries BullMQ → quarantaine webhook_dead (S-2).
// ---------------------------------------------------------------------
describe('deliver — échecs et mise en quarantaine', () => {
  it('HTTP 500 (tentative 1 < cap) → rejet du job (retry), PAS de DLQ', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    MOCKED_STORE.getEndpoint.mockResolvedValue(ENDPOINT);

    await expect(worker['deliver'](makeJob(PAYLOAD, 0))).rejects.toThrow(/HTTP 500/);

    expect(MOCKED_STORE.insertWebhookDead).not.toHaveBeenCalled();
    const w = JSON.parse(String(console.warn.mock.calls[0][0])) as {
      event: string;
      attempt: number;
    };
    expect(w.event).toBe('delivery_failed');
    expect(w.attempt).toBe(1); // attemptsMade + 1
  });

  it('tentative >= cap → payments.webhook_dead + trace dead + log structuré', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    MOCKED_STORE.getEndpoint.mockResolvedValue(ENDPOINT);
    // attemptsMade = cap - 1 → c est la dernière tentative.
    await expect(worker['deliver'](makeJob(PAYLOAD, 4))).rejects.toThrow(/HTTP 500/);

    expect(MOCKED_STORE.insertWebhookDead).toHaveBeenCalledTimes(1);
    const [prisma, payload, error, attempts] = MOCKED_STORE.insertWebhookDead.mock.calls[0];
    expect(prisma).toBeDefined();
    expect(JSON.parse(payload)).toMatchObject({ event_uid: PAYLOAD.event_uid });
    expect(error).toMatch(/HTTP 500/);
    expect(attempts).toBe(5);
    const e = JSON.parse(String(console.error.mock.calls[0][0])) as { event: string };
    expect(e.event).toBe('dead_letter');
    expect(auditOutbox).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditOutbox).mock.calls[0][2]).toMatchObject({
      action: 'payment.webhook.dead',
      details: { attempts: 5 },
    });
    expect(allLoggedText()).not.toContain(SECRET);
  });

  it('payload interne corrompu → quarantaine IMMÉDIATE (jamais relancé)', async () => {
    const out = await worker['deliver'](makeJob({ event_uid: 'cassé', status: 42 }));
    expect(out).toEqual({ delivered: false, dead: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MOCKED_STORE.insertWebhookDead).toHaveBeenCalledTimes(1);
    const errorText = MOCKED_STORE.insertWebhookDead.mock.calls[0][2] as string;
    expect(errorText).toMatch(/payload non conforme/);
    expect(vi.mocked(auditOutbox).mock.calls[0][2]).toMatchObject({
      action: 'payment.webhook.dead',
    });
  });

  it("les erreurs loggées sont tronquées à 300 caractères (pas d'inondation)", async () => {
    fetchMock.mockRejectedValueOnce(new Error('x'.repeat(900)));
    MOCKED_STORE.getEndpoint.mockResolvedValue(ENDPOINT);
    await expect(worker['deliver'](makeJob(PAYLOAD, 0))).rejects.toBeTruthy();
    const w = JSON.parse(String(console.warn.mock.calls[0][0])) as { error: string };
    expect(w.error.length).toBeLessThanOrEqual(300);
    expect(w.error.startsWith('Error: ')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// SWEEP : réconciliation PSP + auto-expiry (TTL par défaut 1200 s).
// ---------------------------------------------------------------------
describe('sweep — pending', () => {
  function stubProvider(status: string, extra: Record<string, unknown> = {}) {
    worker.providerImpl = {
      name: 'dev',
      createCheckout: vi.fn(),
      fetchStatus: vi.fn(async () => ({ status, ...extra })),
      refund: vi.fn(),
    } as never;
  }

  it('pending fraîche (< ttl) → aucune écriture, aucune trace', async () => {
    stubProvider('pending');
    MOCKED_STORE.listPending.mockResolvedValue([rowFixture()]);
    const stats = await worker.sweep();
    expect(stats).toEqual({ examined: 1, reconciled: 0, expired: 0, failed: 0 });
    expect(MOCKED_STORE.applyStatus).not.toHaveBeenCalled();
    expect(auditOutbox).not.toHaveBeenCalled();
  });

  it('pending silencieuse > ttl → expired : machine à états + trace audit + webhook', async () => {
    stubProvider('pending');
    const old = rowFixture({ created_at: new Date(Date.now() - 125_000) });
    vi.stubEnv('PAYMENTS_TTL_SECONDS', '120');
    MOCKED_STORE.listPending.mockResolvedValue([old]);
    MOCKED_STORE.applyStatus.mockResolvedValueOnce(1);
    MOCKED_STORE.getTxnById.mockResolvedValue(rowFixture({ ...old, status: 'expired' }));

    const stats = await worker.sweep();

    expect(stats.expired).toBe(1);
    expect(MOCKED_STORE.applyStatus).toHaveBeenCalledTimes(1);
    const args = MOCKED_STORE.applyStatus.mock.calls[0];
    expect(args[2]).toBe('pending');
    expect(args[3]).toBe('expired');
    expect(vi.mocked(auditOutbox).mock.calls[0][2]).toMatchObject({
      actor: 'system:payments-sweep',
      action: 'payment.expired',
      target: old.id,
    });
    // Watchdog jamais silencieux (alerting à brancher — plan §4).
    expect(allLoggedText()).toMatch(/pending_expired/);
    // Un webhook sortant payment.expired est enfilé.
    const add = worker.queue.add as ReturnType<typeof vi.fn>;
    const payload = (add.mock.calls[0]?.[1] ?? {}) as { event?: string };
    expect(payload.event).toBe('payment.expired');
  });

  it('orphelin sans provider_ref → failed (la pending ne converge pas seule)',
    async () => {
      stubProvider('pending');
      const orphan = rowFixture({ provider_ref: null });
      MOCKED_STORE.listPending.mockResolvedValue([orphan]);
      MOCKED_STORE.applyStatus.mockResolvedValueOnce(1);
      MOCKED_STORE.getTxnById.mockResolvedValue(orphan);
      const stats = await worker.sweep();
      expect(stats.failed).toBe(1);
      const args = MOCKED_STORE.applyStatus.mock.calls[0];
      expect(args[3]).toBe('failed');
    });

  it('réconciliation : PSP répond paid → paid avec paid_at + frais tracés', async () => {
    stubProvider('paid', { paidAt: '2026-10-25T11:00:00.000Z', feeAmount: '70' });
    const row = rowFixture();
    MOCKED_STORE.listPending.mockResolvedValue([row]);
    MOCKED_STORE.applyStatus.mockResolvedValueOnce(1);
    MOCKED_STORE.getTxnById.mockResolvedValue(rowFixture({ ...row, status: 'paid' }));
    const stats = await worker.sweep();
    expect(stats.reconciled).toBe(1);
    const args = MOCKED_STORE.applyStatus.mock.calls[0];
    expect(args[3]).toBe('paid');
    const extras = args[4] as { paidAt?: string | null; feeCents?: string | null };
    expect(extras.paidAt).toBe('2026-10-25T11:00:00.000Z');
    expect(extras.feeCents).toBe('70');
  });

  it('colision concurrente (UPDATE 0 ligne) → no-op silencieux, aucun trace',
    async () => {
      stubProvider('paid');
      const row = rowFixture();
      MOCKED_STORE.listPending.mockResolvedValue([row]);
      MOCKED_STORE.applyStatus.mockResolvedValueOnce(0);
      const stats = await worker.sweep();
      expect(stats.reconciled).toBe(0);
      expect(auditOutbox).not.toHaveBeenCalled();
    });

  it('une ligne qui échoue n empoisonne pas le lot (retentée au prochain sweep)', async () => {
    const bad = rowFixture({ id: 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3' });
    const good = rowFixture({ id: 'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4' });
    MOCKED_STORE.listPending.mockResolvedValue([bad, good]);
    worker.providerImpl = {
      name: 'dev',
      createCheckout: vi.fn(),
      fetchStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error('PSP down'))
        .mockResolvedValueOnce({ status: 'pending' }),
      refund: vi.fn(),
    } as never;
    const stats = await worker.sweep();
    expect(stats.examined).toBe(2);
    expect(stats.expired).toBe(0);
    expect(allLoggedText()).toMatch(/row_error/);
  });
});

// ---------------------------------------------------------------------
// devResolve : simulateur PSP fictif (journal JSONL + machine à états).
// ---------------------------------------------------------------------
describe('devResolve — journal dev & application', () => {
  it('confirm → journal + paid + trace actor dev (event_uid dev-confirm:*)', async () => {
    const row = rowFixture() as never;
    MOCKED_STORE.applyStatus.mockResolvedValueOnce(1);
    MOCKED_STORE.getTxnById.mockResolvedValue(rowFixture({ status: 'paid' }));
    const applied = await worker.devResolve(row, 'confirm');
    expect(applied).toBe(true);
    const jsonl = readFileSync(join(dirOutbox, 'dev.jsonl'), 'utf8');
    expect(jsonl).toMatch(/"action":"confirm"/);
    expect(MOCKED_STORE.applyStatus.mock.calls[0][3]).toBe('paid');
    expect(MOCKED_STORE.applyStatus.mock.calls[0][4]).toMatchObject({
      eventUid: expect.stringMatching(/^dev-confirm:/),
    });
    expect(vi.mocked(auditOutbox).mock.calls[0][2]).toMatchObject({
      actor: 'system:payments-dev',
      action: 'payment.paid',
    });
  });

  it('fail → journal + failed appliqué', async () => {
    const row = rowFixture() as never;
    MOCKED_STORE.applyStatus.mockResolvedValueOnce(1);
    MOCKED_STORE.getTxnById.mockResolvedValue(rowFixture({ status: 'failed' }));
    const applied = await worker.devResolve(row, 'fail');
    expect(applied).toBe(true);
    expect(MOCKED_STORE.applyStatus.mock.calls[0][3]).toBe('failed');
    expect(vi.mocked(auditOutbox).mock.calls[0][2]).toMatchObject({
      action: 'payment.failed',
    });
  });

  it('transaction sans référence PSP → 409 (pas de simulation orpheline)', async () => {
    const noRef = rowFixture({ provider_ref: null }) as never;
    await expect(worker.devResolve(noRef, 'confirm')).rejects.toMatchObject({
      status: 409,
    });
  });
});

// ---------------------------------------------------------------------
// Enfilement webhook : jobId BullMQ-compatible (règle BullMQ — un
// custom id contenant ":" est REFUSÉ, cf. Job.validateOptions) :
// l'event_uid entrant est libre (PSP « dehors »), jamais supposé.
// ---------------------------------------------------------------------
describe('enqueueWebhook — jobId BullMQ-safe', () => {
  it('uid PSP libre (« evt-replay-123 ») → jobId sans ":", déterministe', async () => {
    await worker.enqueueWebhook(PAYLOAD);
    const add = worker.queue.add as ReturnType<typeof vi.fn>;
    const opts = add.mock.calls[0][2] as { jobId: string };
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).not.toBe('');
    await worker.enqueueWebhook(PAYLOAD); // même payload → même jobId
    expect((add.mock.calls[1][2] as { jobId: string }).jobId).toBe(opts.jobId);
  });

  it('uid interne (« dev-confirm:<uuid> ») → jobId sans ":" aussi', async () => {
    const uid: typeof PAYLOAD = {
      ...PAYLOAD,
      event_uid: 'dev-confirm:b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2',
    };
    await worker.enqueueWebhook(uid);
    const add = worker.queue.add as ReturnType<typeof vi.fn>;
    const opts = add.mock.calls[0][2] as { jobId: string };
    expect(opts.jobId).not.toContain(':');
    const uid2: typeof PAYLOAD = {
      ...PAYLOAD,
      event_uid: 'a:b:c:d', // pire cas : tous les « : » d'un coup
    };
    await worker.enqueueWebhook(uid2);
    expect((add.mock.calls[1][2] as { jobId: string }).jobId).not.toContain(':');
  });
});

// ---------------------------------------------------------------------
// Garde machine à états côté service.
// ---------------------------------------------------------------------
describe('applyRemoteStatus — transitions illégales', () => {
  it('paid → pending refusé (never d écriture, never de trace)', async () => {
    const paidRow = rowFixture({ status: 'paid' }) as never;
    await expect(
      worker.applyRemoteStatus(paidRow, 'pending', 'sweep-reconcile'),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(MOCKED_STORE.applyStatus).not.toHaveBeenCalled();
    expect(auditOutbox).not.toHaveBeenCalled();
  });
});
