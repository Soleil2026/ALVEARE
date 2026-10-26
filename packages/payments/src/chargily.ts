/**
 * @alveare/payments — adaptateur `chargily` (Chargily Pay v2, E6 Q1/Q2)
 * Zone Red : revue indépendante obligatoire + JAMAIS d'appel réseau réel
 * depuis les tests (toujours injecté/mocké).
 *
 * Hors code : le LIVE exige le KYB fait par l'opérateur (R6) — le
 * code vise la SANDBOX par défaut (CHARGILY_API_BASE finit en /test/).
 * Les chemins d'API sont surchargés via env si la doc v2 précise
 * autre chose — voir docs/ops-payments.md (section tâches opérateur).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  assertAmountCents,
  paymentsHttpTimeoutMs,
} from './adapters';
import type {
  CheckoutInput,
  CheckoutResult,
  FetchStatusResult,
  PaymentProvider,
} from './adapters';

export interface ChargilyOptions {
  secretKey: string;
  apiBase: string;
  fetchImpl: typeof fetch;
}

export function chargilyApiBase(): string {
  return process.env.CHARGILY_API_BASE ?? 'https://pay.chargily.net/test/api/v2';
}

export function chargilySecretKey(): string {
  const key = process.env.CHARGILY_SECRET_KEY;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      'CHARGILY_SECRET_KEY absente — démarrage refusé (PAYMENTS_PROVIDER=chargily exige un secret sandbox)',
    );
  }
  return key;
}

/** Mapping du statut rapprochant vers notre machine à états. */
function normalizeStatus(raw: string): FetchStatusResult['status'] {
  switch (raw) {
    case 'paid':
    case 'succeeded':
      return 'paid';
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return 'failed';
    case 'expired':
      return 'expired';
    default:
      // processing / pending / inconnu → pas de conclusion (pending),
      // source de vérité = sweep (aucun démarrage dégradé).
      return 'pending';
  }
}

export function makeChargilyProvider(
  opts: Partial<ChargilyOptions> = {},
): PaymentProvider {
  const secretKey = opts.secretKey ?? chargilySecretKey();
  const apiBase = opts.apiBase ?? chargilyApiBase();
  // fetch injectable : les tests n'appellent JAMAIS le vrai réseau.
  const impl = opts.fetchImpl ?? fetch;

  async function call(
    path: string,
    method: 'POST' | 'GET',
    payload?: unknown,
  ): Promise<Record<string, unknown>> {
    // D-1 (revue T4.7) : abort configurable — un PSP lent ne doit
    // jamais suspendre un lock BD (refund) ou un worker BullMQ.
    const res = await impl(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(paymentsHttpTimeoutMs()),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // AUCUNE trace de secret : message générique + statut HTTP.
      throw new Error(
        `chargily : appel ${method} ${path} refusé (HTTP ${res.status}, aucun détail exposé)`,
      );
    }
    return body;
  }

  return {
    name: 'chargily',
    async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
      const resp = await call('/checkout/new', 'POST', {
        // D-9 : garde de précision AVANT Number() (écart BD ↔ PSP
        // interdit) ; montant borné CHECK BD amount >= 100.
        amount: Number(assertAmountCents(input.amountCents)),
        currency: input.currency,
        metadata: { alveare_txn: input.txnId }, // routage app côté Core (Q7)
      });
      const redirectUrl = resp['checkout_url'] ?? resp['payment_url'];
      const providerRef = resp['id'] ?? resp['payment_id'];
      if (typeof redirectUrl !== 'string' || typeof providerRef !== 'string') {
        throw new Error('chargily : réponse de checkout sans URL/référence attendues');
      }
      return { redirectUrl, providerRef };
    },
    async fetchStatus(providerRef: string): Promise<FetchStatusResult> {
      const resp = await call(`/checkout/${encodeURIComponent(providerRef)}`, 'GET');
      const raw = typeof resp['status'] === 'string' ? resp['status'] : 'pending';
      const status = normalizeStatus(raw);
      const out: FetchStatusResult = { status };
      if (status === 'paid' && typeof resp['paid_at'] === 'string') {
        out.paidAt = resp['paid_at'];
      }
      if (typeof resp['fee'] === 'number') {
        out.feeAmount = String(resp['fee']);
      }
      return out;
    },
    async refund(
      providerRef: string,
      amountCents: string,
    ): Promise<{ providerRef: string }> {
      const resp = await call(`/payments/${encodeURIComponent(providerRef)}/refund`, 'POST', {
        amount: Number(assertAmountCents(amountCents)), // D-9 : même garde
      });
      const providerRefOut = resp['id'] ?? resp['payment_id'];
      return { providerRef: typeof providerRefOut === 'string' ? providerRefOut : providerRef };
    },
  };
}

/**
 * Vérifie un webhook ENTRANT chargily : entête `signature` = HMAC-SHA256
 * hex du corps brut, clé = CHARGILY_SECRET_KEY. Format toléré : hex brut
 * OU « v1=<hex> » ; comparaison à temps constant. Retourne FALSE sur
 * toute anomalie (jamais d'exception — la source PSP n'est jamais
 * une excuse à crasher).
 */
export function verifyChargilyWebhook(
  secretKey: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (
    typeof signatureHeader !== 'string' ||
    typeof secretKey !== 'string' ||
    secretKey.length === 0
  ) {
    return false;
  }
  const sig = signatureHeader.trim().startsWith('v1=')
    ? signatureHeader.trim().slice(3)
    : signatureHeader.trim();
  const expected = createHmac('sha256', secretKey).update(rawBody).digest('hex');
  const ab = Buffer.from(sig, 'hex');
  const bb = Buffer.from(expected, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}
