// Contrats partagés ALVEARE (contract-first, ADR-0002 §validation Zod).
// Tout autre repo consomme ces schémas : frontend (validation) et
// backend (documentation + désérialisation sûre).

import { z } from 'zod';

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

/** Réponse standard du endpoint /healthz d'un service ALVEARE. */
export const HealthSchema = z.object({
  service: z.string().min(1),
  status: z.literal('ok'),
  version: z.string().regex(SEMVER, 'version semver attendue (ex. 0.0.1)'),
});

export type Health = z.infer<typeof HealthSchema>;

/** Rôles de base posés au socle — chaque app affine ses permissions. */
export const UserRoleSchema = z.enum(['admin', 'gestionnaire', 'utilisateur']);

export type UserRole = z.infer<typeof UserRoleSchema>;

/**
 * Entrée d'audit (plan E3 §3, FR-03.1) — payload écrit dans
 * audit.outbox puis transféré vers audit.events par le drain
 * BullMQ du service audit :4030. Zone Red : revue indépendante
 * obligatoire (AGENTS.md / revue-criticite).
 */
export const AuditEntrySchema = z.object({
  /** bornage temporel de l'opération : Date ou ISO 8601 (UTC 'Z'). */
  at: z
    .union([
      z.iso.datetime(),
      z.date().transform((d) => d.toISOString()),
    ])
    .optional(),
  actor: z.string().min(1),
  action: z.string().min(1),
  target: z.string().min(1).nullable().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  /** id outbox source (lien de déduplication drain) : fourni en option. */
  outboxId: z
    .union([
      z.bigint().nonnegative(),
      z.number().int().nonnegative(),
      z.string().regex(/^[0-9]+$/),
    ])
    .optional()
    .transform((v) => (v === undefined ? undefined : v.toString())),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditEntryInput = z.input<typeof AuditEntrySchema>;

/**
 * Requête admin FR-03.3 (GET /admin/audit :4030) : qui / quoi / quand /
 * où. Pagination par curseur opaque ; limit borné CPU/BD.
 */
export const AuditQuerySchema = z.object({
  actor: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

export type AuditQuery = z.infer<typeof AuditQuerySchema>;
