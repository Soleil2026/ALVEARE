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
