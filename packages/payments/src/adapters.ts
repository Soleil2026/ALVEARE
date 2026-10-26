/**
 * @alveare/payments — interface des providers + fabrique à boot STRICT
 * (E6, plan §4-§5). Zone Red : revue indépendante obligatoire.
 *
 * Pattern transposé de services/notify/src/sms.ts : fabrique par var
 * d'env, DÉMARRAGE REFUSÉ (throw) si la valeur est inconnue — aucun
 * démarrage dégradé silencieux. `PAYMENTS_PROVIDER=dev` = simulation
 * déterministe sans AUCUN contact réseau (moteur des tests/e2e).
 */

import type { PaymentProviderName } from '@alveare/contracts';
import { makeDevProvider } from './dev';
import { makeChargilyProvider } from './chargily';

/** Entrées de création d'un checkout (jamais le token utilisateur —
 * le webmarchand est unique au Core, l'app est portée en metadata). */
export interface CheckoutInput {
  txnId: string;
  app: string;
  appRef: string;
  /** centimes (chaîne de chiffres — BIGINT safe) */
  amountCents: string;
  currency: string;
}

export interface CheckoutResult {
  redirectUrl: string;
  providerRef: string;
}

/** Statut constaté par la réconciliation (source de vérité serveur,
 * plan §2.2 — le webhook ne reste qu'un signal). */
export interface FetchStatusResult {
  status: 'pending' | 'paid' | 'failed' | 'expired';
  paidAt?: string;
  /** frais PSP tracés (R5), centimes */
  feeAmount?: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  fetchStatus(providerRef: string): Promise<FetchStatusResult>;
  /** Rembourse le montant demandé côté PSP. */
  refund(providerRef: string, amountCents: string): Promise<{ providerRef: string }>;
}

/**
 * Fabrique : PAYMENTS_PROVIDER (env, défaut 'dev') → adapter.
 * @throws si la valeur est inconnue OU si la config de l'adapter
 *         demandé est manquante (ex. CHARGILY_SECRET_KEY absente).
 */
export function makePaymentProvider(): PaymentProvider {
  const name = process.env.PAYMENTS_PROVIDER ?? 'dev';
  switch (name) {
    case 'dev':
      return makeDevProvider();
    case 'chargily':
      return makeChargilyProvider();
    case 'satim':
      throw new Error(
        'PAYMENTS_PROVIDER=satim : homologation V2 (aucun code V1) — démarrage refusé',
      );
    default:
      throw new Error(
        `PAYMENTS_PROVIDER inconnu (${name}) — démarrage refusé (attendu : dev | chargily | satim)`,
      );
  }
}
