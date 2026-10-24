/**
 * ALVEARE Identity — validation des corps de requête "role_grants".
 * Règle B §2.4 : un compte global n'accorde aucun accès automatique —
 * chaque app décide des rôles de ses utilisateurs.
 */

import { BadRequestException } from '@nestjs/common';
import { UserRoleSchema } from '@alveare/contracts';

/** pattern des apps branchées : core-admin | app-01..app-12 */
export const APP_PATTERN = /^(core-admin|app-(0[1-9]|1[0-2]))$/;

export type GrantBody = {
  userId: string;
  app: string;
  role: string;
};

export function parseGrantBody(raw: unknown): GrantBody {
  const body = (raw ?? {}) as Partial<GrantBody>;
  if (typeof body.userId !== 'string' || body.userId.length === 0) {
    throw new BadRequestException('userId manquant');
  }
  if (typeof body.app !== 'string' || !APP_PATTERN.test(body.app)) {
    throw new BadRequestException('app invalide (attendu : core-admin | app-01..app-12)');
  }
  const role = UserRoleSchema.safeParse(body.role);
  if (!role.success) {
    throw new BadRequestException(
      `role invalide (attendu : ${UserRoleSchema.options.join(' | ')})`,
    );
  }
  return { userId: body.userId, app: body.app, role: body.role as string };
}
