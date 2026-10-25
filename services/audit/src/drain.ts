/**
 * E3 T3.4 — cœur du drain outbox → audit.events. Zone Red : revue
 * indépendante obligatoire (AGENTS.md / revue-criticite).
 *
 * Ce module est le cœur PUR du worker (testable avec fakes Prisma,
 * sans Nest ni Redis ni BD réelle) — `main.ts` ne fait que le brancher
 * sur une transaction Prisma et une queue BullMQ.
 *
 * Invariants (plan E3 §2 / T3.4) :
 *   * un lot = une transaction : SELECT … WHERE delivered = false
 *     ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED, puis insertion
 *     partitionnée idempotente INSERT … ON CONFLICT (outbox_id, at)
 *     DO NOTHING, puis delivered=true pour les lignes traitées et
 *     attempts++ pour les lignes en échec (SAVEPOINT par ligne : une
 *     ligne réfractaire n'empoisonne pas le lot) ;
 *   * le routage de partition est automatique : la valeur `at`
 *     (payload.at sinon created_at de l'outbox) place la ligne dans la
 *     partition mensuelle correspondant à son mois — cf. migration
 *     002-partition-events.sql (PARTITION BY RANGE (at)) ;
 *   * idempotence stricte : re-drain d'un même outbox → conflit
 *     (outbox_id, at) → ignoré, zéro doublon, delivered=true quand
 *     même (sans ce flip un doublon re-scanné à l'infini) ;
 *   * un lot < BATCH (ou un lot avec des lignes échouées) termine le
 *     sweep : ni spin sur une ligne réfractaire, ni balayage vide.
 */

import { AuditEntrySchema, type AuditEntry } from '@alveare/contracts';

/** Taille des lots de drain (plan E3 T3.4 : LIMIT 100). */
export const DRAIN_BATCH_SIZE = 100;

/** Nombre maximal de lots par sweep (garde-fou anti-boucle). */
export const DRAIN_MAX_CYCLES = 1000;

/**
 * Surface SQL brute minimale — le même gabarit de client que le helper
 * outbox : la transaction Prisma (Prisma.TransactionClient) est
 * utilisée uniquement via ses tags $queryRaw / $executeRaw.
 */
export interface DrainRawClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/** Compteur du drain — scalaires pour réponse API / retour de job. */
export interface DrainStats {
  scanned: number;
  inserted: number;
  deduped: number;
  failed: number;
}

export const ZERO_STATS: DrainStats = { scanned: 0, inserted: 0, deduped: 0, failed: 0 };

export function addStats(a: DrainStats, b: DrainStats): DrainStats {
  return {
    scanned: a.scanned + b.scanned,
    inserted: a.inserted + b.inserted,
    deduped: a.deduped + b.deduped,
    failed: a.failed + b.failed,
  };
}

/** Ligne SELECT lockée du outbox — tout est passé en unknown puis
 * normalisé (Prisma renvoie bigint, Date, jsonb). */
interface OutboxRow {
  id: unknown;
  created_at: unknown;
  payload: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

/**
 * Traite UN lot dans la transaction ouverte par l'appelant (Prisma
 * `$transaction` : BEGIN/COMMIT gérés par Prisma, jamais ici).
 *
 * @returns le compte du lot : `inserted` = lignes réellement écrites,
 *   `deduped` = lignes déjà présentes dans audit.events (conflit
 *   (outbox_id, at) — idempotence), `failed` = lignes réfractaires
 *   (attempts++ enregistré, retry au sweep suivant).
 */
export async function drainBatch(tx: DrainRawClient): Promise<DrainStats> {
  // 1) LOT VERROUILLÉ : SKIP LOCKED = plusieurs workers peuvent
  //    sweeper en parallèle sans se disputer une même ligne.
  const rows = await tx.$queryRaw<OutboxRow>`
    SELECT id, created_at, payload
    FROM audit.outbox
    WHERE delivered = false
    ORDER BY id
    LIMIT ${DRAIN_BATCH_SIZE}
    FOR UPDATE SKIP LOCKED`;

  const stats: DrainStats = { ...ZERO_STATS, scanned: rows.length };
  const processedIds: number[] = [];

  for (const row of rows) {
    const outboxId = Number(row.id);
    // id bigserial : non représentable en number => ligne rejetée
    // (attempts++, retry au sweep suivant) plutôt que corrompue.
    const safeId =
      Number.isSafeInteger(outboxId) && outboxId >= 0 ? outboxId : null;
    if (safeId === null) {
      // Pas d'id exploitable : rien à marquer en BD (la ligne est
      // re-scannée au sweep suivant et le compteur du lot fait foi).
      stats.failed++;
      continue;
    }

    await tx.$executeRaw`SAVEPOINT drain_row`;
    try {
      const inserted = await insertEvent(tx, safeId, row.created_at, row.payload);
      processedIds.push(safeId);
      if (inserted) {
        stats.inserted++;
      } else {
        stats.deduped++;
      }
    } catch (err) {
      // Une ligne invalide ne corrompt pas le lot : savepoint annulé,
      // attempts++ (piste de diagnostic), le sweep suivant retentera.
      stats.failed++;
      console.error(
        `drain: outbox ${safeId} échec (tentative comptée) : ${String(err)}`,
      );
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT drain_row`;
      await markFailure(tx, safeId);
    }
  }

  // 2) Livraison : delivered=true pour les lignes effectivement
  //    écrites OU déjà présentes (idempotence). Mises à jour par id
  //    (paramétrées) — le lot est borné à DRAIN_BATCH_SIZE.
  for (const id of processedIds) {
    await tx.$executeRaw`UPDATE audit.outbox SET delivered = true WHERE id = ${id}`;
  }

  return stats;
}

/** Attempts++ sur une ligne en échec (audit trail : la ligne reste
 * delivered=false et sera retentée au sweep suivant). */
async function markFailure(tx: DrainRawClient, id: number): Promise<void> {
  await tx.$executeRaw`UPDATE audit.outbox SET attempts = attempts + 1 WHERE id = ${id}`;
}

/**
 * Insère l'entrée dans audit.events (routage automatique vers la
 * partition mensuelle de `at`). @returns true si la ligne a été
 * insérée, false si le conflit (outbox_id, at) révèle un doublon déjà
 * traité (idempotence).
 */
async function insertEvent(
  tx: DrainRawClient,
  outboxId: number,
  createdAt: unknown,
  rawPayload: unknown,
): Promise<boolean> {
  const payload = asRecord(rawPayload);
  if (!payload) {
    throw new Error('payload outbox absent ou non-objet');
  }

  // Validation Zod du contrat (champ details null → absent).
  const parsed = AuditEntrySchema.safeParse({
    actor: payload.actor,
    action: payload.action,
    target: payload.target ?? undefined,
    details: payload.details ?? undefined,
    at: payload.at ?? undefined,
  });
  if (!parsed.success) {
    throw new Error(`payload non conforme AuditEntry : ${parsed.error.message}`);
  }
  const entry: AuditEntry = parsed.data;

  // `at` d'insertion : payload.at prioritaire, sinon la created_at
  // (stable) de la ligne outbox — c'est cette valeur stable qui
  // garantit que le conflit (outbox_id, at) retombe au même endroit.
  const atParam =
    entry.at !== undefined ? entry.at : (createdAt instanceof Date ? createdAt.toISOString() : createdAt);

  const details = entry.details ?? null;
  const rows = await tx.$queryRaw<Array<{ outbox_id: unknown }>>`
    INSERT INTO audit.events (at, actor, action, target, details, outbox_id)
    VALUES (${atParam}::timestamptz, ${entry.actor}, ${entry.action}, ${entry.target ?? null},
            ${details === null ? null : JSON.stringify(details)}::jsonb, ${outboxId}::bigint)
    ON CONFLICT (outbox_id, at) DO NOTHING
    RETURNING outbox_id`;

  // RETURNING non vide = ligne réellement insérée.
  return rows.length === 1;
}

/**
 * Un sweep complet : lots successifs dans des transactions DISTINCTES
 * jusqu'à outbox vide (lot incomplet), en s'arrêtant aussi sur un lot
 * contenant une ligne échouée (elle sera retraitée par le sweep
 * suivant — pas de spin sur une ligne réfractaire).
 *
 * @param runBatch lance (!) un drainBatch dans une nouvelle
 *        transaction (wiring Prisma de main.ts — ce module reste
 *        testable avec un fake).
 */
export async function drainUntilEmpty(
  runBatch: () => Promise<DrainStats>,
  opts?: { maxCycles?: number },
): Promise<DrainStats> {
  let total = { ...ZERO_STATS };
  const max = opts?.maxCycles ?? DRAIN_MAX_CYCLES;
  for (let cycle = 0; cycle < max; cycle++) {
    const batch = await runBatch();
    total = addStats(total, batch);
    if (batch.scanned < DRAIN_BATCH_SIZE) break; // outbox vide
    if (batch.failed > 0) break; // lignes réfractaires : exit propre
  }
  return total;
}
