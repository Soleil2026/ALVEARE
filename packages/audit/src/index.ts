/**
 * @alveare/audit — helper outbox transactionnel (E3, plan §5).
 * Zone Red : revue indépendante obligatoire (AGENTS.md / revue-criticite).
 *
 * Rôle : écrire les entrées d'audit dans audit.outbox DANS la
 * transaction métier déjà ouverte par l'émetteur (identity /
 * documents / notify). Garantie identique à l'écriture sync actuelle :
 * si la transaction métier est committée, l'audit est forcément
 * présent — le drain BullMQ transfère ensuite vers audit.events.
 *
 * Contrat strict :
 *   * le helper n'ouvre JAMAIS begin/commit (la transaction appartient
 *     à l'émetteur) ;
 *   * TOUT le SQL passe par un template tagué Prisma ($executeRaw /
 *     $queryRaw) : les valeurs sont des paramètres ($1, $2, ...),
 *     aucune interpolation de contenu utilisateur dans le SQL ;
 *   * une entrée invalide plante AVANT la première écriture
 *     (validation Zod @alveare/contracts, schema AuditEntry) ;
 *   * le payload inséré reçoit son propre id en `payload.outbox_source`
 *     (lien de déduplication pour le drain idempotent, unicité
 *     (outbox_id, at) sur audit.events).
 */

import {
  AuditEntrySchema,
  type AuditEntryInput,
} from '@alveare/contracts';

export { signalDrain, AUDIT_DRAIN_QUEUE, type SignalDrainOptions } from './drain-signal';

/**
 * Client min-privilege : surface SQL brute de Prisma
 * (PrismaService du service émetteur — `$executeRaw` / `$queryRaw`).
 * Rien d'autre n'est requis : le helper ne touche aucun modèle Prisma.
 */
export interface AuditRawClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
}

/** Ligne renvoyée par le INSERT ... RETURNING du outbox. */
type OutboxReturningRow = { id: bigint | number };

/**
 * Écrit chaque entrée dans audit.outbox et renvoie les ids outbox
 * assignés (mapping 1:1 avec l'ordre d'entrée).
 *
 * @param client  le client Prisma du service émetteur (PrismaService).
 *                Déclaré pour homogénéité avec les émetteurs ; toute
 *                l'écriture passe par `tx` (le helper est FORCÉMENT
 *                appelé à l'intérieur d'une transaction ouverte, plan
 *                E3 §5 — les usages hors-tx appartiennent au service
 *                audit :4030, pas à ce helper).
 * @param tx      la transaction métier (Prisma.TransactionClient) déjà
 *                ouverte par l'émetteur — ni begin, ni commit, jamais.
 * @param entries une entrée ou un lot d'entrées d'audit.
 * @returns les ids outbox créés, dans l'ordre d'entrée.
 * @throws  ZodError si une entrée est invalide (prévalidation du lot
 *          COMPLET avant la boucle SQL : aucune écriture partielle
 *          contestable).
 */
export async function auditOutbox(
  client: AuditRawClient,
  tx: AuditRawClient,
  entries: AuditEntryInput | AuditEntryInput[],
): Promise<number[]> {
  if (!client || !tx) {
    throw new Error(
      'auditOutbox : client et tx requis (transaction métier ouverte)',
    );
  }
  const list = Array.isArray(entries) ? entries : [entries];

  // D-4 (revue T3.8) : TOUT le lot est prévalidé AVANT la boucle SQL —
  // une entrée invalide (même en fin de lot) lève AVANT le premier
  // INSERT : un lot invalide ne peut pas laisser une écriture partielle
  // derrière lui.
  const parsedEntries = list.map((entry) => AuditEntrySchema.parse(entry));
  const outboxIds: number[] = [];

  for (const parsed of parsedEntries) {
    const payload = {
      actor: parsed.actor,
      action: parsed.action,
      target: parsed.target ?? null,
      details: parsed.details ?? null,
      // « at » pilote aussi le routage de partition côté drain ; il
      // n'entre dans le payload QUE s'il est explicite (undefined =>
      // now() par défaut côté BD, cohérence horlogé garantie).
      ...(parsed.at ? { at: parsed.at } : {}),
    };

    // INSERT + rattachement outbox_source en UN SEUL ÉNONCÉ
    // paramétré. ATTENTION (piège de snapshot PostgreSQL), l'approche
    // `WITH ins AS (INSERT …) UPD AS (UPDATE …)` NE MARCHE PAS : tous
    // les CTE modifiantes d'un même énoncé partagent le snapshot de
    // départ, l'UPDATE ne voit donc JAMAIS la ligne de l'INSERT. On
    // réserve donc l'id AVANT (nextval dans une CTE SELECT — pas
    // d'écriture, pas de conflit de snapshot) et le payload est
    // tamponné à l'INSERT même (jsonb_set, outbox_source = id).
    const rows = await tx.$queryRaw<OutboxReturningRow>`
      WITH nid AS (SELECT nextval('audit.outbox_id_seq') AS id)
      INSERT INTO audit.outbox (id, created_at, payload)
      SELECT
        id,
        COALESCE(${parsed.at ?? null}::timestamptz, now()),
        jsonb_set(
          ${JSON.stringify(payload)}::jsonb,
          '{outbox_source}',
          to_jsonb(id)
        )
      FROM nid
      RETURNING id`;

    if (rows.length !== 1) {
      throw new Error('auditOutbox : INSERT audit.outbox sans RETURNING id');
    }
    const id = Number((rows[0] as OutboxReturningRow).id);
    if (!Number.isSafeInteger(id)) {
      throw new Error('auditOutbox : id outbox non représentable en number');
    }
    outboxIds.push(id);
  }

  return outboxIds;
}
