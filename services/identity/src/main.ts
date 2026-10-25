/**
 * ALVEARE Identity — service NestJS (E2).
 * Zone Red : toute modification auth/permissions exige une revue
 * indépendante (auteur ≠ réviseur) — AGENTS.md + revue-criticite.
 *
 * Principes :
 * - JWT validé via `jose` (JWKS Keycloak) : signature, issuer, exp, azp
 *   → logique isolée dans src/token.ts (testée unitairement).
 * - Un compte global ≠ accès automatique (B §2.4) : le rôle EFFECTIF
 *   d'une app vient de la BD (role_grants), pas du realm seul.
 * - Audit = outbox transactionnel (@alveare/audit, E3 T3.3) : l'écrit
 *   se fait dans la transaction métier (ou l'autocommit du client pour
 *   les cas hors-tx — même borne de commit qu'avant) ; audit.events
 *   n'est plus que la CIBLE du drain BullMQ du service audit :4030.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';
import { isAdminEffective, requireToken, type TokenUser } from '@alveare/auth';
import { auditOutbox } from '@alveare/audit';
import { APP_PATTERN, parseGrantBody } from './grants';

type AuthRequest = Request & { user?: TokenUser };

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/**
 * Journal d'audit — E3 T3.3 (zone Red).
 * Écritures : outbox transactionnel @alveare/audit (INSERT audit.outbox,
 * paramétré, validé Zod par le helper). `record` est appelé dans le
 * même périmètre d'exécution qu'avant (hors grandes transactions :
 * l'INSERT simple est en autocommit sur le client, borne de commit
 * inchangée — aucune transaction ouverte ici).
 * Lectures : audits GET /admin/audit lit encore audit.events
 * (table cible du drain, désormais partitionnée mensuellement).
 */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async record(input: {
    actor: string;
    action: string;
    target?: string;
    details?: unknown;
  }) {
    await auditOutbox(this.prisma, this.prisma, {
      actor: input.actor,
      action: input.action,
      ...(input.target ? { target: input.target } : {}),
      ...(input.details !== undefined && input.details !== null
        ? { details: input.details as Record<string, unknown> }
        : {}),
    });
  }

  async list(limit = 50) {
    return this.prisma.$queryRaw`
      SELECT at, actor, action, target, details
      FROM audit.events ORDER BY at DESC LIMIT ${limit}`;
  }
}

/** Exige un access token valide sur la requête. */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    req.user = await requireToken(req);
    return true;
  }
}

/** Admin : rôle realm 'admin' OU grant 'admin' sur core-admin (B §2.4). */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    const user = req.user ?? (await requireToken(req));
    req.user = user;
    const grant = await this.prisma.roleGrant.findUnique({
      where: { userId_app: { userId: user.sub, app: 'core-admin' } },
    });
    if (isAdminEffective(user, grant?.role ?? null)) return true;
    throw new ForbiddenException('rôle admin requis sur core-admin');
  }
}

@Controller()
class HealthController {
  @Get('/healthz')
  health() {
    return {
      service: 'alveare-identity',
      status: 'ok',
      version: '0.2.0',
      bricks: ['oidc-guard', 'role-grants', 'consents', 'audit-minimal'],
    };
  }
}

@Controller('me')
class MeController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @UseGuards(AuthGuard)
  async me(@Req() req: AuthRequest) {
    const user = req.user as TokenUser;
    const grants = await this.prisma.roleGrant.findMany({
      where: { userId: user.sub },
    });
    return {
      sub: user.sub,
      email: user.email,
      realmRoles: user.realmRoles,
      /** rôles EFFECTIFS par application (B §2.4) */
      appRoles: grants.map((g) => ({ app: g.app, role: g.role })),
    };
  }
}

@Controller('admin')
class AdminController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** Rôles par application (B §2.4) — upsert. Zone Red. */
  @Post('role-grants')
  @UseGuards(AdminGuard)
  async setGrant(
    @Req() req: AuthRequest,
    @Body() raw: unknown,
  ) {
    const admin = req.user as TokenUser;
    const body = parseGrantBody(raw);
    await this.prisma.$transaction(async (tx) => {
      await tx.roleGrant.upsert({
        where: { userId_app: { userId: body.userId, app: body.app } },
        create: {
          userId: body.userId,
          app: body.app,
          role: body.role,
          createdBy: admin.sub,
        },
        update: { role: body.role, createdBy: admin.sub },
      });
      // Audit DANS la transaction métier (borne de commit inchangée) :
      // rollback métier => rollback de l'entrée outbox.
      await auditOutbox(tx, tx, {
        actor: admin.sub,
        action: 'role_grant.set',
        target: `${body.userId}:${body.app}=${body.role}`,
        details: { app: body.app, role: body.role },
      });
    });
    return { ok: true, granted: body };
  }

  /**
   * Lecture de l'audit (admin uniquement) — endpoint hérité DÉPRÉCIÉ
   * (E3 §5) : réponse inchangée, mais en-tête `Deprecation` annoncé ;
   * bascule du backoffice vers GET /admin/audit du service audit :4030.
   */
  @Get('audit')
  @UseGuards(AdminGuard)
  async auditList(@Res({ passthrough: true }) res: Response) {
    res.setHeader(
      'Deprecation',
      'Tue, 25 Oct 2026 00:00:00 GMT; sunsetting=alveare/audit-service',
    );
    return this.audit.list();
  }
}

@Controller('consents')
class ConsentsController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** Historique des consentements de l'authentifié. */
  @Get()
  @UseGuards(AuthGuard)
  async list(@Req() req: AuthRequest) {
    const user = req.user as TokenUser;
    return this.prisma.consent.findMany({
      where: { userId: user.sub },
      orderBy: { grantedAt: 'desc' },
    });
  }

  /** Consentement (FR-02.5) : l'utilisateur autorise une app. */
  @Post()
  @UseGuards(AuthGuard)
  async grant(@Req() req: AuthRequest, @Body() raw: unknown) {
    const user = req.user as TokenUser;
    const b = (raw ?? {}) as { consumingApp?: string; scope?: string };
    if (typeof b.consumingApp !== 'string' || !APP_PATTERN.test(b.consumingApp)) {
      throw new BadRequestException('consumingApp invalide');
    }
    if (typeof b.scope !== 'string' || b.scope.length === 0) {
      throw new BadRequestException('scope manquant');
    }
    const app: string = b.consumingApp;
    const scope: string = b.scope;
    const consent = await this.prisma.$transaction(async (tx) => {
      const c = await tx.consent.upsert({
        where: {
          userId_consumingApp_scope: {
            userId: user.sub,
            consumingApp: app,
            scope,
          },
        },
        create: { userId: user.sub, consumingApp: app, scope },
        update: { revokedAt: null },
      });
      // Audit DANS la transaction métier (borne de commit inchangée).
      await auditOutbox(tx, tx, {
        actor: user.sub,
        action: 'consent.grant',
        target: `${app}:${scope}`,
      });
      return c;
    });
    return { ok: true, consentId: consent.id };
  }

  /** Révocation : l'utilisateur retire son consentement. */
  @Delete(':id')
  @UseGuards(AuthGuard)
  async revoke(@Req() req: AuthRequest, @Param('id') id: string) {
    const user = req.user as TokenUser;
    const parsedId = Number.parseInt(id, 10);
    if (!Number.isInteger(parsedId)) throw new BadRequestException('id invalide');
    const existing = await this.prisma.consent.findFirst({
      where: { id: parsedId, userId: user.sub },
    });
    if (!existing) throw new NotFoundException('consentement inconnu');
    if (existing.revokedAt) return { ok: true, already: true };
    await this.prisma.$transaction(async (tx) => {
      await tx.consent.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      // Audit DANS la transaction métier (borne de commit inchangée).
      await auditOutbox(tx, tx, {
        actor: user.sub,
        action: 'consent.revoke',
        target: `${existing.consumingApp}:${existing.scope}`,
      });
    });
    return { ok: true };
  }
}

@Module({
  controllers: [HealthController, MeController, AdminController, ConsentsController],
  providers: [
    PrismaService,
    {
      provide: AuditService,
      useFactory: (p: PrismaService) => new AuditService(p),
      inject: [PrismaService],
    },
  ],
})
class AppModule {}

const cleanup = () => process.exit(0);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number.parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port, 'localhost');
  console.log(`alveare-identity up : http://localhost:${port}/healthz`);
}
void bootstrap();
