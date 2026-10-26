/**
 * @alveare/payments — adaptateur `dev` (E6, plan §4/§5) : simulation
 * déterministe SANS réseau. Zone Red : revue indépendante obligatoire.
 *
 * Modèle : un journal JSONL (déterministe, rejouable) portant les
 *événements simulés côté « PSP fictive » — create/confirm/fail/expire/
 * refund. fetchStatus lit le DERNIER état journalisé pour le
 * provider_ref, exactement ce qu'une vraie réconciliation ferait.
 * Fichier sous /tmp (jamais versionné, jamais utilisé en prod :
 * dev = variable d'env explicite).
 */

import { appendFileSync, readFileSync } from 'node:fs';
import type {
  CheckoutInput,
  CheckoutResult,
  FetchStatusResult,
  PaymentProvider,
} from './adapters';

export type DevSimulateAction = 'confirm' | 'fail' | 'expire';

interface DevEvent {
  ts: string;
  ref: string;
  action: 'created' | DevSimulateAction | 'refund';
  /** centimes pour refund, sinon absent */
  amount?: string;
}

export function devOutboxFile(): string {
  return process.env.PAYMENTS_DEV_OUTBOX ?? '/tmp/alv-payments-dev.jsonl';
}

function appendEvent(ev: DevEvent): void {
  appendFileSync(devOutboxFile(), `${JSON.stringify(ev)}\n`, { mode: 0o600 });
}

/** Dernier état journalisé pour ce provider_ref (aucun evt = pending). */
export function devFetchStatus(providerRef: string): FetchStatusResult {
  let rows: DevEvent[] = [];
  try {
    rows = readFileSync(devOutboxFile(), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as DevEvent)
      .filter((e) => e.ref === providerRef);
  } catch {
    // fichier absent (aucun simulateur) → pending
  }
  const last = rows[rows.length - 1];
  if (last === undefined) return { status: 'pending' };
  switch (last.action) {
    case 'confirm':
      return {
        status: 'paid',
        paidAt: last.ts,
        ...(last.amount ? { feeAmount: last.amount } : {}),
      };
    case 'fail':
      return { status: 'failed' };
    case 'expire':
      return { status: 'expired' };
    default:
      return { status: 'pending' };
  }
}

/** Injecte un événement simulé (utilisé par les endpoints e2e-only du
 * service quand ALV_ALLOW_E2E=1 et provider=dev). */
export function devSimulate(
  providerRef: string,
  action: DevSimulateAction,
  opts: { feeAmount?: string } = {},
): void {
  appendEvent({
    ts: new Date().toISOString(),
    ref: providerRef,
    action,
    ...(opts.feeAmount ? { amount: opts.feeAmount } : {}),
  });
}

export function makeDevProvider(): PaymentProvider {
  return {
    name: 'dev',
    async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
      // Référence DÉTERMINISTE dérivée de la txn (idempotence exacte du
      // rejou : même txn → même ref → même journal).
      const providerRef = `dev-${input.txnId}`;
      appendEvent({ ts: new Date().toISOString(), ref: providerRef, action: 'created' });
      return {
        redirectUrl: `http://localhost:${process.env.PAYMENTS_PORT ?? '4040'}/payments/${input.txnId}/dev-checkout`,
        providerRef,
      };
    },
    async fetchStatus(providerRef: string): Promise<FetchStatusResult> {
      return devFetchStatus(providerRef);
    },
    async refund(
      providerRef: string,
      amountCents: string,
    ): Promise<{ providerRef: string }> {
      appendEvent({
        ts: new Date().toISOString(),
        ref: providerRef,
        action: 'refund',
        amount: amountCents,
      });
      return { providerRef };
    },
  };
}
