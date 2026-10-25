/**
 * E3 T3.5 — lecture admin FR-03.3 (GET /admin/audit). Zone Red :
 * revue indépendante obligatoire (AGENTS.md / revue-criticite).
 *
 * Ce module est PUR (testable sans Nest/BD) :
 *   * parseAuditQuery — normalise + valide les params de la requête
 *     HTTP via AuditQuerySchema (@alveare/contracts) ; limit arrive en
 *     string depuis le query string (coercion bornée) ;
 *   * encodeCursor / decodeCursor — curseur opaque base64url « at|id »
 *     (pagination par jeu de résultats stable : tri at DESC, id DESC) ;
 *   * buildAuditListSql — construction du SELECT paramétré sur la
 *     table partitionnée (audit.events, toutes partitions) : toute
 *     valeur utilisateur passe par un paramètre ($1…) via Prisma.Sql
 *     — aucune interpolation de contenu utilisateur dans le SQL.
 */

import { Prisma } from '@prisma/client';
import { AuditQuerySchema } from '@alveare/contracts';

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 500;

/** Requête normalisée (après validation Zod). */
export interface AuditReadQuery {
  actor?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export type ParseResult =
  | { ok: true; query: AuditReadQuery }
  | { ok: false; error: string };

/** Champ texte du query string : undefined si absent/vide. */
function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : undefined;
  return s !== undefined && s.length > 0 ? s : undefined;
}

/**
 * Normalise + valide les params bruts du query string (Fastify/Express
 * → { actor?: string, … }). `limit` est coercé depuis string (ex. "20"),
 * les dates from/to doivent être ISO 8601 (Zod).
 */
export function parseAuditQuery(raw: Record<string, unknown>): ParseResult {
  const limitStr = str(raw.limit);
  // Coercion numérique : limit est une string du query string. Zod
  // (AuditQuerySchema) rejette ensuite NaN / flottant / hors bornes.
  const limit = limitStr === undefined ? undefined : Number(limitStr);
  const candidate = {
    actor: str(raw.actor),
    action: str(raw.action),
    target: str(raw.target),
    from: str(raw.from),
    to: str(raw.to),
    limit,
    cursor: str(raw.cursor),
  };
  // Nettoyage des champs absents (Zod optionnel strict).
  for (const k of Object.keys(candidate) as Array<keyof typeof candidate>) {
    if (candidate[k] === undefined) delete candidate[k];
  }
  const parsed = AuditQuerySchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.[0] ?? '<requête>';
    return { ok: false, error: `paramètre ${String(field)} invalide` };
  }
  return { ok: true, query: parsed.data };
}

/** Borne systématique (CPU/BD) : absente → 50, <1 → 50, >500 → 500. */
export function clampLimit(limit?: number): number {
  if (
    limit === undefined ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    return AUDIT_DEFAULT_LIMIT;
  }
  return Math.min(limit, AUDIT_MAX_LIMIT);
}

const CURSOR_SEPARATOR = '|';

/** Encode un pointeur « at ISO 8601 | id » en base64url opaque. */
export function encodeCursor(at: string | Date, id: number | bigint | string): string {
  const iso = at instanceof Date ? at.toISOString() : at;
  return Buffer.from(`${iso}${CURSOR_SEPARATOR}${id.toString()}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Décode un curseur. @returns { at: ISO-string, id } ou null si
 * le curseur est corrompu (error 400 au contrôleur — jamais d'impact
 * sur la requête SQL).
 */
export function decodeCursor(
  cursor: string,
): { at: string; id: number } | null {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sep = raw.lastIndexOf(CURSOR_SEPARATOR);
  if (sep < 0) return null;
  const at = raw.slice(0, sep);
  const id = Number(raw.slice(sep + CURSOR_SEPARATOR.length));
  if (
    !at ||
    Number.isNaN(Date.parse(at)) ||
    !Number.isSafeInteger(id) ||
    id < 0
  ) {
    return null;
  }
  return { at, id };
}

/** Ligne SELECT renvoyée par la BD (mappée par le contrôleur). */
export interface AuditListRow {
  id: unknown; // bigint → number côté JS via Prisma
  at: unknown; // Date
  actor: string;
  action: string;
  target: string | null;
  details: unknown; // jsonb
  outbox_id: unknown; // bigint | null
}

/**
 * Construit le SELECT paramétré (fragments Prisma.Sql : placeholders
 * `?` + valeurs séparées). Le SELECT porte sur la table MÈRE
 * audit.events : PostgreSQL route la lecture sous les partitions
 * mensuelles de manière transparente (plan E3 §3) — pas de UNION
 * manuel.
 */
export function buildAuditListSql(query: AuditReadQuery): Prisma.Sql {
  const filters: Prisma.Sql[] = [Prisma.sql`true`];

  if (query.actor) filters.push(Prisma.sql`actor = ${query.actor}`);
  if (query.action) filters.push(Prisma.sql`action = ${query.action}`);
  if (query.target) filters.push(Prisma.sql`target = ${query.target}`);
  if (query.from) filters.push(Prisma.sql`at >= ${query.from}::timestamptz`);
  if (query.to) filters.push(Prisma.sql`at <= ${query.to}::timestamptz`);

  if (query.cursor) {
    const cur = decodeCursor(query.cursor);
    if (!cur) {
      // Défensif : un curseur corrompu ne doit JAMAIS dégrader en
      // « tout lire » — le contrôleur renverra alors une erreur 400.
      throw new Error('curseur illisible');
    }
    // Comparaison de tuple (at, id) < CURSEUR : reprise STABLE du tri
    // (at DESC, id DESC) — la ligne pivot même id/at est exclue.
    filters.push(
      Prisma.sql`(at, id) < (${cur.at}::timestamptz, ${cur.id}::bigint)`,
    );
  }

  return Prisma.sql`
    SELECT id, at, actor, action, target, details, outbox_id
    FROM audit.events
    WHERE ${Prisma.join(filters, ' AND ')}
    ORDER BY at DESC, id DESC
    LIMIT ${clampLimit(query.limit)}`;
}
