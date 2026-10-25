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
 * @throws  ZodError si une entrée est invalide (levant AVANT le SQL :
 *          aucune écriture partielle contestable).
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
  const outboxIds: number[] = [];

  for (const entry of list) {
    // Validation stricte AVANT toute écriture SQL.
    const parsed = AuditEntrySchema.parse(entry);

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
    // paramétré : CTE `ins` (INSERT ... RETURNING id) puis CTE `upd`
    // qui fusionne l'id DANS le payload déjà stocké
    // (jsonb_build_object) — la dédup drain (unicité (outbox_id, at))
    // a son lien prêt sans aller-retour supplémentaire.
    const rows = await tx.$queryRaw<OutboxReturningRow>`
      WITH ins AS (
        INSERT INTO audit.outbox (created_at, payload)
        VALUES (
          COALESCE(${parsed.at ?? null}::timestamptz, now()),
          ${JSON.stringify(payload)}::jsonb
        )
        RETURNING id
      ),
      upd AS (
        UPDATE audit.outbox
        SET payload = payload || jsonb_build_object('outbox_source', ins.id)
        FROM ins
        WHERE audit.outbox.id = ins.id
      )
      SELECT id FROM ins`;

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
