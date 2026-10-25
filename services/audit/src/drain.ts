/**
 * E3 T3.4 — cœur du drain outbox → audit.events. Zone Red : revue
 * indépendante obligatoire (AGENTS.md / revue-criticite).
 *
 * Ce module est le cœur PUR du worker (testable avec fakes Prisma,
 * sans Nest ni Redis ni BD réelle) — `main.ts` ne fait que le brancher
 * sur une transaction Prisma et une queue BullMQ.
 *
 * Invariants (plan E3 §2 / T3.4, correctifs revue T3.8) :
 *   * un lot = une transaction : SELECT … WHERE delivered = false
 *     AND attempts < plafond ORDER BY id LIMIT 100 FOR UPDATE SKIP
 *     LOCKED, puis insertion partitionnée idempotente INSERT …
 *     ON CONFLICT (outbox_id, at) DO NOTHING, puis delivered=true pour
 *     les lignes traitées et attempts++ pour les lignes en échec
 *     (SAVEPOINT par ligne : une ligne réfractaire n'empoisonne pas le
 *     lot) ;
 *   * quarantaine (S-2 revue T3.8) : après le lot, les lignes encore
 *     NON livrées et réfractaires trop de fois (attempts >= cap, env
 *     AUDIT_ATTEMPTS_CAP, défaut 5) passent EN DEAD-LETTER
 *     (audit.outbox_deadletter) puis sortent du outbox dans la MÊME
 *     transaction — jamais silencieux (log structuré), jamais
 *     re-sélectionnées ensuite ; le drain reste ainsi sain même avec
 *     une ligne empoisonnée.
 *     Garde SQL : énoncés DISTINCTS pour la quarantaine — une CTE qui
 *     lirait un INSERT/UPDATE du même énoncé ne le verrait jamais
 *     (piège de snapshot PostgreSQL, cf. @alveare/audit).
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
  /** Lignes déplacées en dead-letter durant ce lot (S-2 revue T3.8). */
  quarantined: number;
}

export const ZERO_STATS: DrainStats = {
  scanned: 0,
  inserted: 0,
  deduped: 0,
  failed: 0,
  quarantined: 0,
};

export function addStats(a: DrainStats, b: DrainStats): DrainStats {
  return {
    scanned: a.scanned + b.scanned,
    inserted: a.inserted + b.inserted,
    deduped: a.deduped + b.deduped,
    failed: a.failed + b.failed,
    quarantined: a.quarantined + b.quarantined,
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
 * Plafond de tentatives (revue T3.8 S-2) : une ligne encore livrée
 * (delivered = false) avec attempts >= cap quitte le outbox pour la
 * dead-letter au sweep suivant. Env `AUDIT_ATTEMPTS_CAP` : entier
 * STRICTEMENT POSITIF (garde : un cap nul viderait le outbox au
 * premier sweep) ; valeur absente ou invalide → défaut 5. Aucune
 * valeur <= 0 n'est possible par construction.
 */
export function attemptsCap(): number {
  const raw = process.env.AUDIT_ATTEMPTS_CAP;
  // Number() (et pas parseInt : « 1.5 » tronqué serait accepté) —
  // l'entier STRICTEMENT POSITIF est le seul format retenu.
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
}

/** Raison tracée dans audit.outbox_deadletter.error (grep du runbook : 
 * cf. docs/ops-audit.md). */
export const QUARANTINE_REASON = 'plafond de tentatives atteint';

/**
 * Passe de QUARANTAINE (S-2) — énoncés SÉPARÉS (jamais de CTE qui lirait
 * un INSERT du même énoncé : piège de snapshot), DANS la transaction du
 * lot. Une ligne encore NON livrée (delivered = false) et réfractaire
 * trop de fois (attempts >= cap) est copiée TELLE QUEL en
 * audit.outbox_deadletter
 * (payload, attempts, raison) PUIS supprimée du outbox : elle n'est
 * plus jamais re-sélectionnée, un lot suivant n'est plus empoisonné,
 * et la trace reste consultable pour réparation humaine.
 *
 * @returns le nombre de lignes mises en quarantaine.
 */
export async function quarantineExhausted(
  tx: DrainRawClient,
  cap: number,
): Promise<number> {
  const rows = await tx.$queryRaw<{ id: unknown; attempts: unknown; payload: unknown }>`
    SELECT id, attempts, payload
    FROM audit.outbox
    WHERE delivered = false
      AND attempts >= ${cap}
    ORDER BY id
    LIMIT ${DRAIN_BATCH_SIZE}
    FOR UPDATE SKIP LOCKED`;

  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id < 0) {
      // id non représentable en number : ligne non adressable —
      // signalée (jamais silencieux) mais pas copiable en dead-letter.
      console.error(
        'audit drain : quarantaine impossible, id outbox non représentable',
      );
      continue;
    }
    // Payload copié TEL QUEL (aucune revalidation : c'est justement une
    // ligne qui a résisté au parse) ; jsonb arrive en string ou objet
    // selon le pilote — tout est repris tel quel côté BD.
    const payloadStr =
      typeof row.payload === 'string'
        ? row.payload
        : JSON.stringify(row.payload ?? null);
    await tx.$executeRaw`INSERT INTO audit.outbox_deadletter (id, attempts, payload, error)
      VALUES (${id}::bigint, ${Number(row.attempts)}::int, ${payloadStr}::jsonb, ${QUARANTINE_REASON})`;
    await tx.$executeRaw`DELETE FROM audit.outbox WHERE id = ${id}::bigint`;
  }

  if (rows.length > 0) {
    console.error(
      `audit drain : quarantaine de ${rows.length} ligne(s) réfractaire(s) (attempts>=${cap})`,
    );
  }
  return rows.length;
}

/**
 * Traite UN lot dans la transaction ouverte par l'appelant (Prisma
 * `$transaction` : BEGIN/COMMIT gérés par Prisma, jamais ici).
 *
 * @returns le compte du lot : `inserted` = lignes réellement écrites,
 *   `deduped` = lignes déjà présentes dans audit.events (conflit
 *   (outbox_id, at) — idempotence), `failed` = lignes réfractaires
 *   (attempts++ enregistré, retry au sweep suivant), `quarantined` =
 *   lignes déplacées en dead-letter (rare et jamais muet).
 */
export async function drainBatch(tx: DrainRawClient): Promise<DrainStats> {
  // Plafond de tentatives : les lignes déjà trop réfractaires ne sont
  // même PAS sélectionnées (pas de retry infini) — elles passent en
  // quarantaine en fin de lot (cf. quarantineExhausted).
  const cap = attemptsCap();

  // 1) LOT VERROUILLÉ : SKIP LOCKED = plusieurs workers peuvent
  //    sweeper en parallèle sans se disputer une même ligne.
  const rows = await tx.$queryRaw<OutboxRow>`
    SELECT id, created_at, payload
    FROM audit.outbox
    WHERE delivered = false
      AND attempts < ${cap}
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

  // 3) Quarantaine (S-2) : les lignes réfractaires tentées jusqu'au
  //    plafond sortent du outbox et partent en dead-letter — DANS LA
  //    MÊME transaction (tout le lot, ou rien).
  stats.quarantined = await quarantineExhausted(tx, cap);

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
