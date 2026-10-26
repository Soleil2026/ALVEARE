/**
 * E6 — décisions PURES du service paiements (testables sans BD/Nest).
 * Zone Red : revue indépendante obligatoire.
 *
 * Contenu :
 *   * planRefund — arbitrage d'une demande de remboursement (Q9) :
 *     plafond strict (≤ solde), idempotence par refund_ref (replay =
 *     no-op… si le montant COLLECTÉ est identique), statut cible
 *     conforme à la machine à états (@alveare/payments) ;
 *   * viewFromRow — portrait conforme PaymentViewSchema (montants en
 *     chaînes de chiffres, datetimes ISO) ;
 *   * paymentsWebhookCap / ttlSeconds — plafonds env strictement
 *     positifs (mêmes gardes que AUDIT_ATTEMPTS_CAP, E3).
 */

import {
  PAYMENT_STATUS,
  PaymentViewSchema,
  type PaymentStatus,
  type PaymentView,
} from '@alveare/contracts';
import type { TxnRow } from './store';

/** Demande (déjà validée par RefundRequestSchema). */
export interface RefundAsk {
  refundRef: string;
  /** centimes ; absente = TOTAL du solde restant. */
  amountCents?: string;
}

/** Arbitrage d'une demande (aucun effet de bord : décision seule). */
export type RefundPlan =
  | { kind: 'conflict-status'; status: PaymentStatus }
  | { kind: 'noop'; status: PaymentStatus } // même refund_ref, même montant
  | { kind: 'conflict-ref' } // même refund_ref, montant différent
  | { kind: 'over' } // montant > solde restant
  | { kind: 'apply'; amountCents: string; newStatus: PaymentStatus };

/**
 * Décide le remboursement depuis l'état verrouillé de la transaction.
 * @param ctx.txnStatus      statut courant (paid | partially_refunded
 *        requis — tout autre statut est un conflit d'état)
 * @param ctx.amountCents    montant payé (centimes)
 * @param ctx.refundedCents  déjà remboursé (SUM du table refunds)
 * @param existing           remboursement en BD pour CE refund_ref
 *        (replay) — null si la clé est libre
 */
export function planRefund(
  ctx: { txnStatus: PaymentStatus; amountCents: string; refundedCents: string },
  ask: RefundAsk,
  existing: { amountCents: string } | null,
): RefundPlan {
  if (ctx.txnStatus !== 'paid' && ctx.txnStatus !== 'partially_refunded') {
    return { kind: 'conflict-status', status: ctx.txnStatus };
  }

  const total = BigInt(ctx.amountCents);
  const refunded = BigInt(ctx.refundedCents);
  const remaining = total - refunded;
  const want = BigInt(ask.amountCents ?? remaining.toString());

  // Idempotence Q9 : replay du MÊME refund_ref (décidé AVANT l'éligible
  // plafond — un replay ne doit jamais retomber sur un autre arbitrage).
  if (existing) {
    // Replay à montant identique, OU replay sans montant précisé (le
    // solde a changé depuis la première application) → no-op : un
    // nouveau remboursement DOIT utiliser un nouveau refund_ref.
    if (
      ask.amountCents === undefined ||
      existing.amountCents === want.toString()
    ) {
      return { kind: 'noop', status: ctx.txnStatus };
    }
    return { kind: 'conflict-ref' };
  }

  if (want > remaining) return { kind: 'over' };

  // Solde connu >= 1 quand le statut est refundable (garde du service) ;
  // la demande a déjà été validée RefundRequestSchema (>= 1 centime).
  const newStatus: PaymentStatus =
    want === remaining ? 'refunded' : 'partially_refunded';
  return { kind: 'apply', amountCents: want.toString(), newStatus };
}

/** Statuts qui ferment l'énoncé (now() sur closed_at). */
export function closesOn(to: PaymentStatus): boolean {
  return to === 'failed' || to === 'expired' || to === 'refunded';
}

/** Transforme une ligne BD en portrait API conforme (jamais de number). */
export function viewFromRow(row: TxnRow): PaymentView {
  if (!PAYMENT_STATUS.includes(row.status)) {
    throw new Error(`statut inconnu en BD : ${row.status}`);
  }
  return PaymentViewSchema.parse({
    id: row.id,
    app: row.app,
    app_ref: row.app_ref,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    rail: row.rail,
    provider: row.provider,
    provider_ref: row.provider_ref ?? null,
    receipt_ref: row.receipt_ref ?? null,
    fee_amount: row.fee_amount ?? null,
    refunded_amount: row.refunded,
    created_at: iso(row.created_at),
    paid_at: row.paid_at ? iso(row.paid_at) : null,
    closed_at: row.closed_at ? iso(row.closed_at) : null,
  });
}

/** Date BD → ISO ; invalide = erreur explicite (jamais « Invalid Date »
 * laissé passer dans l'API). */
function iso(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new Error(`horodatage invalide : ${String(d)}`);
  }
  const s = d.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(s)) {
    throw new Error(`horodatage invalide : ${s}`);
  }
  return s;
}

/**
 * PAYMENTS_WEBHOOK_ATTEMPTS_CAP : entier STRICTEMENT positif, défaut 5
 * (invalide/absente → défaut ; jamais de cap nul).
 */
export function paymentsWebhookCap(): number {
  const raw = process.env.PAYMENTS_WEBHOOK_ATTEMPTS_CAP;
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
}

/**
 * PAYMENTS_TTL_SECONDS : délai de silence avant auto-expiry d'un
 * 'pending' (miroir de l'auto-cancel SATIM, 20 min). Entier strictement
 * positif — défaut 1200.
 */
export function ttlSeconds(): number {
  const raw = process.env.PAYMENTS_TTL_SECONDS;
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1200;
}
