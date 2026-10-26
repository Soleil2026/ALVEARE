/**
 * E6 T4.2 — tests de la fabrique d'adaptateurs + des deux implantations.
 * Zone Red : revue indépendante obligatoire.
 *
 * Pinnés (consigne T4.2) :
 *   * fabrique : PAYMENTS_PROVIDER inconnu → boot REFUSÉ (throw) ;
 *     'satim' → refusé explicite (homologation V2, aucun code V1) ;
 *   * dev : simulation déterministe via JSONL, zéro réseau ;
 *   * chargily : injectable fetch — les tests n'appellent JAMAIS le
 *     réseau réel ; secret manquant → boot refusé.
 */

import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  devFetchStatus,
  devOutboxFile,
  devSimulate,
  makeDevProvider,
} from '../src/dev';
import {
  chargilyApiBase,
  chargilySecretKey,
  makeChargilyProvider,
  verifyChargilyWebhook,
} from '../src/chargily';
import { makePaymentProvider, type CheckoutInput } from '../src/adapters';

function input(over: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    txnId: '11111111-2222-3333-4444-555555555555',
    app: 'app-01',
    appRef: 'cmd-42',
    amountCents: '50000', // 500,00 DZD
    currency: 'DZD',
    ...over,
  };
}

describe('fabrique makePaymentProvider (boot strict)', () => {
  const original = process.env.PAYMENTS_PROVIDER;

  afterEach(() => {
    if (original === undefined) delete process.env.PAYMENTS_PROVIDER;
    else process.env.PAYMENTS_PROVIDER = original;
    vi.restoreAllMocks();
  });

  it("PAYMENTS_PROVIDER inconnu → throw (démarrage refusé, aucun mode dégradé)", () => {
    vi.stubEnv('PAYMENTS_PROVIDER', ' zdarma-iwwa');
    expect(() => makePaymentProvider()).toThrow(/inconnu/);
    expect(() => makePaymentProvider()).toThrow(/dev \| chargily \| satim/);
  });

  it("PAYMENTS_PROVIDER='satim' → refus explicite (V2, homologation)", () => {
    vi.stubEnv('PAYMENTS_PROVIDER', 'satim');
    expect(() => makePaymentProvider()).toThrow(/satim/);
  });

  it('PAYMENTS_PROVIDER non défini → dev par défaut', () => {
    delete process.env.PAYMENTS_PROVIDER;
    expect(makePaymentProvider().name).toBe('dev');
  });

  it("PAYMENTS_PROVIDER chaîne vide = inconnue → boot refusé (?? ne la masque pas)", () => {
    vi.stubEnv('PAYMENTS_PROVIDER', '');
    expect(() => makePaymentProvider()).toThrow(/inconnu/);
  });
});

describe('chargilySecretKey / chargilyApiBase (config de boot)', () => {
  const sk = process.env.CHARGILY_SECRET_KEY;
  const ab = process.env.CHARGILY_API_BASE;

  afterEach(() => {
    if (sk === undefined) delete process.env.CHARGILY_SECRET_KEY;
    else process.env.CHARGILY_SECRET_KEY = sk;
    if (ab === undefined) delete process.env.CHARGILY_API_BASE;
    else process.env.CHARGILY_API_BASE = ab;
  });

  it('CHARGILY_SECRET_KEY absente → throw (boot refusé)', () => {
    delete process.env.CHARGILY_SECRET_KEY;
    expect(() => chargilySecretKey()).toThrow(/CHARGILY_SECRET_KEY/);
  });

  it('payload sandbox par défaut (pay.chargily.net/test/api/v2)', () => {
    delete process.env.CHARGILY_API_BASE;
    expect(chargilyApiBase()).toBe('https://pay.chargily.net/test/api/v2');
  });
});

describe('adaptateur dev (simulation déterministe, zéro réseau)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alv-pay-dev-'));
    vi.stubEnv('PAYMENTS_DEV_OUTBOX', join(dir, 'dev.jsonl'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('createCheckout → providerRef déterministe `dev-<txn id>` + entrée created', async () => {
    const p = makeDevProvider();
    const res = await p.createCheckout(input());
    expect(res.providerRef).toBe(`dev-${input().txnId}`);
    expect(res.redirectUrl).toContain(`payments/${input().txnId}/dev-checkout`);
    const lines = readFileSync(devOutboxFile(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      ref: res.providerRef,
      action: 'created',
    });
  });

  it('aucun simulateur lancé → fetchStatus répond pending (source de vérité serveur)', async () => {
    const p = makeDevProvider();
    expect(await p.fetchStatus('dev-none')).toEqual({ status: 'pending' });
  });

  it('confirm → paid ; fail → failed ; expire → expired (dernier état journalisé)', async () => {
    const p = makeDevProvider();
    devSimulate('dev-t1', 'confirm', { feeAmount: '150' });
    expect(await p.fetchStatus('dev-t1')).toEqual({
      status: 'paid',
      paidAt: expect.any(String),
      feeAmount: '150',
    });
    devSimulate('dev-t1', 'expire');
    expect(await p.fetchStatus('dev-t1')).toEqual({ status: 'expired' });
    devSimulate('dev-t2', 'fail');
    expect(await p.fetchStatus('dev-t2')).toEqual({ status: 'failed' });
  });

  it('refund journalise le montant exact', async () => {
    const p = makeDevProvider();
    await p.refund('dev-t1', '1200');
    const lines = readFileSync(devOutboxFile(), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({
      ref: 'dev-t1',
      action: 'refund',
      amount: '1200',
    });
  });
});

describe('adaptateur chargily (fetch injectable — JAMAIS de réseau réel)', () => {
  const SECRET = 'sk-test-chargily-sandbox';

  it('createCheckout : POST /checkout/new avec Authorization Bearer + metadata alveare_txn', async () => {
    const calls: Array<Parameters<typeof fetch>> = [];
    const fakeFetch = (async (url: any, init: any) => {
      calls.push([url, init] as unknown as Parameters<typeof fetch>);
      return Response.json({
        checkout_url: 'https://pay.chargily.net/checkout/abc',
        id: 'chk-123',
      });
    }) as unknown as typeof fetch;
    const p = makeChargilyProvider({
      secretKey: SECRET,
      apiBase: 'https://mock/api/v2',
      fetchImpl: fakeFetch,
    });
    const res = await p.createCheckout(input());
    expect(res).toEqual({
      redirectUrl: 'https://pay.chargily.net/checkout/abc',
      providerRef: 'chk-123',
    });
    const [url, init] = calls[0];
    expect(url).toBe('https://mock/api/v2/checkout/new');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ' + SECRET);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      amount: 50000,
      currency: 'DZD',
      metadata: { alveare_txn: input().txnId },
    });
  });

  it('réponse sans URL/référence → erreur explicite (jamais un providerRef fantôme)', async () => {
    const p = makeChargilyProvider({
      secretKey: SECRET,
      apiBase: 'https://mock/api/v2',
      fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
    });
    await expect(p.createCheckout(input())).rejects.toThrow(/sans URL/);
  });

  it('statuts PSP ramenés vers la machine à états (paid/succeeded/failed/canceled/expired)', async () => {
    const mk = (body: Record<string, unknown>) =>
      makeChargilyProvider({
        secretKey: SECRET,
        apiBase: 'https://mock/api/v2',
        fetchImpl: (async () => Response.json(body)) as unknown as typeof fetch,
      }) as unknown as {
        fetchStatus(ref: string): Promise<{ status: string; paidAt?: string; feeAmount?: string }>;
      };
    expect((await mk({ status: 'paid' }).fetchStatus('c1')).status).toBe('paid');
    expect((await mk({ status: 'succeeded' }).fetchStatus('c1')).status).toBe('paid');
    expect((await mk({ status: 'failed' }).fetchStatus('c1')).status).toBe('failed');
    expect((await mk({ status: 'canceled' }).fetchStatus('c1')).status).toBe('failed');
    expect((await mk({ status: 'cancelled' }).fetchStatus('c1')).status).toBe('failed');
    expect((await mk({ status: 'expired' }).fetchStatus('c1')).status).toBe('expired');
    // Statut inconnu / latence → aucune conclusion (pending).
    expect((await mk({ status: 'processing' }).fetchStatus('c1')).status).toBe('pending');
    expect((await mk({}).fetchStatus('c1')).status).toBe('pending');
    // paid_at conservé quand paid.
    expect((await mk({ status: 'paid', paid_at: '2026-10-25T10:00:00Z' }).fetchStatus('c1')).paidAt).toBe(
      '2026-10-25T10:00:00Z',
    );
  });

  it('erreur HTTP PSP : throw générique SANS exposer le secret ni les détails', async () => {
    const p = makeChargilyProvider({
      secretKey: SECRET,
      apiBase: 'https://mock/api/v2',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'rate limited', key: SECRET }), {
          status: 429,
        })) as unknown as typeof fetch,
    });
    let msg = '';
    try {
      await p.fetchStatus('c1');
    } catch (err) {
      msg = String((err as Error).message);
    }
    expect(msg).toMatch(/HTTP 429/);
    // Le corps d'erreur PSP (avec le secret qu'il contiendrait) n'est
    // jamais remonté dans le message.
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain('rate limited');
  });

  it('refund : POST montant exact', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fakeFetch = (async (url: any, init: any) => {
      calls.push([String(url), init]);
      return Response.json({ id: 'r-9' });
    }) as unknown as typeof fetch;
    const p = makeChargilyProvider({
      secretKey: SECRET,
      apiBase: 'https://mock/api/v2',
      fetchImpl: fakeFetch,
    });
    expect(await p.refund('chk-123', '1500')).toEqual({ providerRef: 'r-9' });
    expect(calls[0][0]).toBe('https://mock/api/v2/payments/chk-123/refund');
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ amount: 1500 });
  });
});

describe('verifyChargilyWebhook (HMAC du corps, clef PSP)', () => {
  const KEY = 'sk-test-chargily-sandbox';
  const hex = (secret: string, body: string) =>
    createHmac('sha256', secret).update(body).digest('hex');

  it('signature hex brute correcte → true', () => {
    const body = '{"event":"checkout.paid"}';
    expect(verifyChargilyWebhook(KEY, body, hex(KEY, body))).toBe(true);
  });

  it('format tolerant v1=<hex> → true', () => {
    const body = '{"event":"checkout.paid"}';
    expect(verifyChargilyWebhook(KEY, body, `v1=${hex(KEY, body)}`)).toBe(true);
  });

  it('corps altéré / clef différente / entête pourrie → false (jamais throw)', () => {
    const body = '{"event":"checkout.paid"}';
    expect(verifyChargilyWebhook(KEY, body + ' ', hex(KEY, body))).toBe(false);
    expect(verifyChargilyWebhook('autre', body, hex(KEY, body))).toBe(false);
    expect(verifyChargilyWebhook(KEY, body, '')).toBe(false);
    expect(verifyChargilyWebhook('', body, hex(KEY, body))).toBe(false);
  });
});
