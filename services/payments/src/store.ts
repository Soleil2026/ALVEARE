/**
 * E6 T4.3 — accès SQL DIRECT paramétré au schéma payments (post-migration
 * 006). Zone Red : revue indépendante obligatoire (AGENTS.md /
 * revue-criticite).
 *
 * Règles d'or :
 *   * SQL 100% paramétré : les valeurs passent par les marqueurs du
 *     template tagué ($queryRaw / $executeRaw de Prisma) — JAMAIS
 *     d'interpolation de contenu utilisateur dans le texte SQL ;
 *   * un seul énoncé par rendu (jamais de CTE en écriture mixte :
 *     piège de snapshot PostgreSQL, cf. @alveare/audit) ;
 *   * les secrets (app_endpoints.secret) sont lus mais JAMAIS loggés ;
 *   * idempotence par unicité BD : create (app, app_ref), refund
 *     (txn_id, refund_ref), webhook (event_uid) — conflits traités via
 *     ON CONFLICT ... DO NOTHING + re-select (jamais un duplicata).
 */

import { Prisma } from '@prisma/client';
import type { PaymentStatus } from '@alveare/contracts';

/** Surface SQL brute minimale (PrismaService ou transaction Prisma). */
export interface SqlClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Promise<T[]>;
  $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<number>;
}

/** Transaction complète telle que stockée (montants en centimes). */
export interface TxnRow {
  id: string;
  app: string;
  app_ref: string;
  status: PaymentStatus;
  /** centimes (chaîne de chiffres — BIGINT safe) */
  amount: string;
  currency: string;
  rail: 'dzd' | 'fx';
  just_ref: string | null;
  provider: string;
  provider_ref: string | null;
  event_uid: string | null;
  receipt_ref: string | null;
  fee_amount: string | null;
  refunded: string;
  created_at: Date;
  paid_at: Date | null;
  closed_at: Date | null;
}

/** Colonnes RETURNING/SELECT complètes — fragment FIXE (aucune valeur
 * utilisateur) interpolé comme Prisma.Sql par $queryRaw. */
const TXN_COLS = Prisma.sql`
  t.id, t.app, t.app_ref, t.status, t.amount, t.currency, t.rail, t.just_ref,
  t.provider, t.provider_ref, t.event_uid, t.receipt_ref, t.fee_amount,
  t.created_at, t.paid_at, t.closed_at,
  COALESCE((SELECT SUM(r.amount) FROM payments.refunds r WHERE r.txn_id = t.id), 0) AS refunded`;

/** Colonnes pour INSERT … RETURNING (sans alias — le row inséré) :
 * le refunded est nécessairement 0 à la création. */
const INSERT_COLS = Prisma.sql`
  id, app, app_ref, status, amount, currency, rail, just_ref,
  provider, provider_ref, event_uid, receipt_ref, fee_amount,
  created_at, paid_at, closed_at`;

type RawTxn = Record<string, unknown>;

/** Normalise une ligne brute (BIGINT → string, Date telle quelle). */
export function normalizeTxnRow(raw: unknown): TxnRow {
  const r = (raw ?? {}) as RawTxn;
  return {
    id: String(r.id),
    app: String(r.app),
    app_ref: String(r.app_ref),
    status: String(r.status) as PaymentStatus,
    amount: String(r.amount),
    currency: String(r.currency),
    rail: String(r.rail) as 'dzd' | 'fx',
    just_ref: r.just_ref === null || r.just_ref === undefined ? null : String(r.just_ref),
    provider: String(r.provider),
    provider_ref:
      r.provider_ref === null || r.provider_ref === undefined ? null : String(r.provider_ref),
    event_uid: r.event_uid === null || r.event_uid === undefined ? null : String(r.event_uid),
    receipt_ref:
      r.receipt_ref === null || r.receipt_ref === undefined ? null : String(r.receipt_ref),
    fee_amount:
      r.fee_amount === null || r.fee_amount === undefined ? null : String(r.fee_amount),
    refunded: String(r.refunded ?? '0'),
    created_at: r.created_at as Date,
    paid_at: (r.paid_at as Date | null) ?? null,
    closed_at: (r.closed_at as Date | null) ?? null,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Garde de forme : un id non-UUID ne doit JAMAIS toucher le SQL (cast). */
export function isUuid(s: string): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}

/**
 * Crée une transaction (état 'created'). Retourne la ligne créée, ou
 * null si (app, app_ref) existe déjà — l'appelant re-sélectionne la
 * ligne existante (création idempotente, plan §2.6).
 */
export async function insertTxn(
  tx: SqlClient,
  p: {
    app: string;
    appRef: string;
    amountCents: string;
    currency: string;
    rail: 'dzd' | 'fx';
    justRef: string | null;
    provider: string;
  },
): Promise<TxnRow | null> {
  const rows = await tx.$queryRaw`
    INSERT INTO payments.transactions
      (app, app_ref, amount, currency, rail, just_ref, provider, status)
    VALUES
      (${p.app}, ${p.appRef}, ${BigInt(p.amountCents)}, ${p.currency},
       ${p.rail}, ${p.justRef}, ${p.provider}, 'created')
    ON CONFLICT (app, app_ref) DO NOTHING
    RETURNING ${INSERT_COLS}`;
  return rows.length === 1 ? normalizeTxnRow(rows[0]) : null;
}

/** Portrait complet d'une transaction par id (0 ligne → non trouvée). */
export async function getTxnById(tx: SqlClient, id: string): Promise<TxnRow | null> {
  if (!isUuid(id)) return null;
  const rows = await tx.$queryRaw`
    SELECT ${TXN_COLS} FROM payments.transactions t WHERE t.id = ${id}::uuid`;
  return rows.length === 1 ? normalizeTxnRow(rows[0]) : null;
}

/** Portrait complet (reprise après conflit d'unicité create). */
export async function getTxnByAppRef(
  tx: SqlClient,
  app: string,
  appRef: string,
): Promise<TxnRow | null> {
  const rows = await tx.$queryRaw`
    SELECT ${TXN_COLS} FROM payments.transactions t
    WHERE t.app = ${app} AND t.app_ref = ${appRef}`;
  return rows.length === 1 ? normalizeTxnRow(rows[0]) : null;
}

/** Portrait complet verrouillé (FOR UPDATE — flux webhook/refund). */
export async function lockTxnById(
  tx: SqlClient,
  id: string,
): Promise<TxnRow | null> {
  if (!isUuid(id)) return null;
  const rows = await tx.$queryRaw`
    SELECT ${TXN_COLS} FROM payments.transactions t WHERE t.id = ${id}::uuid FOR UPDATE`;
  return rows.length === 1 ? normalizeTxnRow(rows[0]) : null;
}

export async function getTxnByProviderRef(
  tx: SqlClient,
  providerRef: string,
): Promise<TxnRow | null> {
  const rows = await tx.$queryRaw`
    SELECT ${TXN_COLS} FROM payments.transactions t
    WHERE t.provider_ref = ${providerRef} FOR UPDATE`;
  return rows.length === 1 ? normalizeTxnRow(rows[0]) : null;
}

/**
 * Transition d'état GUARDÉE : l'UPDATE ne passe QUE si le statut courant
 * est exactement `from` (garde atomique — deux flux concurrents
 * rapprochés n'appliquent JAMAIS la transition deux fois). Renvoie 1 si
 * la ligne a été mutée, 0 si un autre flux a déjà bougé l'état.
 */
export async function applyStatus(
  tx: SqlClient,
  id: string,
  from: PaymentStatus,
  to: PaymentStatus,
  extras: {
    eventUid?: string | null;
    paidAt?: string | null;
    feeCents?: string | null;
    providerRef?: string | null;
    /** close l'énoncé (now()) ; sinon closed_at est conservé. */
    close?: boolean;
  } = {},
): Promise<number> {
  const spent = await tx.$executeRaw`
    UPDATE payments.transactions SET
      status = ${to},
      event_uid = COALESCE(${extras.eventUid ?? null}, event_uid),
      paid_at = COALESCE(${extras.paidAt ?? null}::timestamptz, paid_at),
      fee_amount = COALESCE(${extras.feeCents == null ? null : BigInt(extras.feeCents)}, fee_amount),
      provider_ref = COALESCE(${extras.providerRef ?? null}, provider_ref),
      closed_at = CASE WHEN ${extras.close === true} THEN now() ELSE closed_at END
    WHERE id = ${id}::uuid AND status = ${from}`;
  return spent;
}

/**
 * Un candidat au sweep (statut pending — index transactions_pending_idx).
 */
export async function listPending(
  tx: SqlClient,
  limit: number,
): Promise<TxnRow[]> {
  const rows = await tx.$queryRaw`
    SELECT ${TXN_COLS} FROM payments.transactions t
    WHERE t.status = 'pending'
    ORDER BY t.created_at ASC
    LIMIT ${limit}`;
  return rows.map(normalizeTxnRow);
}

/** Réclamation de clé d'idempotence refund (ON CONFLICT → idempotent). */
export async function claimRefund(
  tx: SqlClient,
  txnId: string,
  refundRef: string,
  amountCents: string,
  reason: string | null,
): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<{ id: unknown }>`
    INSERT INTO payments.refunds (txn_id, refund_ref, amount, reason)
    VALUES (${txnId}::uuid, ${refundRef}, ${BigInt(amountCents)}, ${reason})
    ON CONFLICT (txn_id, refund_ref) DO NOTHING
    RETURNING id`;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('claimRefund : RETURNING inattendu');
  return { id: String(rows[0].id) };
}

/** Remboursement existant pour (txn_id, refund_ref) — replay. */
export async function getRefund(
  tx: SqlClient,
  txnId: string,
  refundRef: string,
): Promise<{ id: string; amount: string; created_at: Date } | null> {
  const rows = await tx.$queryRaw<Record<string, unknown>>`
    SELECT id, amount, created_at FROM payments.refunds
    WHERE txn_id = ${txnId}::uuid AND refund_ref = ${refundRef}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    amount: String(r.amount),
    created_at: r.created_at as Date,
  };
}

/** Endpoint webhook sortant d'une app (secret JAMAIS loggé). */
export async function getEndpoint(
  tx: SqlClient,
  app: string,
): Promise<{ url: string; enabled: boolean; secret: string } | null> {
  const rows = await tx.$queryRaw<Record<string, unknown>>`
    SELECT url, enabled, secret FROM payments.app_endpoints WHERE app = ${app}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    url: String(r.url),
    enabled: r.enabled === true,
    secret: String(r.secret ?? ''),
  };
}

/** Quarantaine des livraisons webhook définitivement échouées (S-2). */
export async function insertWebhookDead(
  tx: SqlClient,
  payload: string,
  error: string,
  attempts: number,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO payments.webhook_dead (payload, error, attempts)
    VALUES (${payload}::jsonb, ${error}, ${attempts})`;
}

/**
 * Lecture admin (miroir FR-03.3) : filtres OPTIONNELS via `IS NULL OR`,
 * limit borné côté appelant — TOUT reste paramétré (aucune concat).
 */
export async function listAdmin(
  tx: SqlClient,
  q: { app?: string; status?: PaymentStatus; limit: number },
): Promise<TxnRow[]> {
  const rows = await tx.$queryRaw`
    SELECT ${TXN_COLS} FROM payments.transactions t
    WHERE (${q.app ?? null}::text IS NULL OR t.app = ${q.app ?? null})
      AND (${q.status ?? null}::text IS NULL OR t.status = ${q.status ?? null})
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ${q.limit}`;
  return rows.map(normalizeTxnRow);
}
