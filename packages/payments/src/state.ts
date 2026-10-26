/**
 * @alveare/payments — machine à états des transactions (E6, plan §2.3).
 * Zone Red (argent) : revue indépendante obligatoire (auteur ≠ réviseur,
 * AGENTS.md / revue-criticite).
 *
 * Module PUR (aucune I/O, jamais de BD ni réseau) : chaque mutation de
 * statut passe par setState() qui refuse toute transition illégale —
 * la source de vérité du graphe est ICI, jamais dans le service.
 *
 * Graphe (plan §2.3) :
 *   created → pending | failed
 *   pending → paid | failed | expired
 *   paid → partially_refunded | refunded   (un refund partiel peut aussi
 *                                          couvrir le reste : paid → refunded)
 *   partially_refunded → refunded
 *   failed / expired / refunded : terminaux — aucune transition sortante.
 *
 * Idempotence « repasse » : répéter la MÊME destination que l'état
 * courant est un no-op (paid → paid, failed → failed…) SAUF created →
 * created (la recréation est déjà interdite par l'unicité (app, app_ref)
 * — un signal répété ne doit jamais réactiver une création).
 */

import type { PaymentStatus } from '@alveare/contracts';

/** Table de transition — whitelist explicite, il n'existe AUCUN default. */
export const TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  created: ['pending', 'failed'],
  pending: ['paid', 'failed', 'expired'],
  paid: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  failed: [],
  expired: [],
  refunded: [],
};

/** États « repassables » sans changement (idempotence des signaux
 * redelivery : paid→paid, failed→failed…) — created en est exclu. */
export const REPEATABLE: ReadonlySet<PaymentStatus> = new Set([
  'pending',
  'paid',
  'failed',
  'expired',
  'partially_refunded',
  'refunded',
]);

export type TransitionResult =
  | { kind: 'applied' } // transition réelle (doit être tracée à l'audit)
  | { kind: 'noop' }; // repasse identique (aucun nouveau trace)

/** Toute transition hors graphe (ou depuis un état terminal différent). */
export class IllegalTransitionError extends Error {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;

  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(`transition illégale : ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Décision pure : peut-on passer de `from` à `to` ? */
export function canTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  if (from === to) return REPEATABLE.has(from);
  return TRANSITIONS[from].includes(to);
}

/**
 * Juge la transition (from → to).
 * @throws IllegalTransitionError si la transition est hors graphe
 *   (y compris tout départ d'un état terminal vers un AUTRE état).
 */
export function transition(
  from: PaymentStatus,
  to: PaymentStatus,
): TransitionResult {
  if (from === to) {
    if (REPEATABLE.has(from)) return { kind: 'noop' };
    throw new IllegalTransitionError(from, to);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError(from, to);
  }
  return { kind: 'applied' };
}
