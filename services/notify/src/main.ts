/**
 * @alveare/notify — service de notifications (E5, FR-05.1/FR-05.2).
 * Zone Red : toute modification du stockage des destinataires ou des
 * adaptateurs d'envoi exige une revue indépendante (auteur ≠ réviseur).
 *
 * Principes :
 * - Adresse destinataire : hash pour l'indexation + JWE au repos —
 *   jamais en clair en BD, jamais en log, jamais en réponse API.
 * - Auth = @alveare/auth (RS256 épinglé, client autorisé).
 * - S1 (plan E5) : healthz + auth + listing du statut pour le user
 *   connecté. POST /send + adaptateurs : S2/S3.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { requireToken, type TokenUser } from '@alveare/auth';
import { hashRecipient } from './pii';

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

/** Exige un access token valide (RS256, client autorisé). */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    req.user = await requireToken(req);
    return true;
  }
}

@Controller()
class NotifyController {
  constructor(private prisma: PrismaService) {}

  /** Statut des notifications du user connecté — hash only (via
   * hashRecipient(email claim)) : jamais le `to` ni son chiffre. */
  @Get('notifications')
  @UseGuards(AuthGuard)
  async mine(@Req() req: AuthRequest) {
    const user = req.user as TokenUser;
    if (!user.email) return [];
    const rows = await this.prisma.notification.findMany({
      where: { recipientHash: hashRecipient(user.email) },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        channel: true,
        template: true,
        lang: true,
        status: true,
        sentAt: true,
        createdAt: true,
        via: true,
      },
    });
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  }
}

@Controller()
class HealthController {
  @Get('/healthz')
  health() {
    return {
      service: 'alveare-notify',
      status: 'ok',
      version: '0.1.0',
      bricks: ['auth-rs256', 'pii-sealed-recipients'],
    };
  }
}

@Module({
  controllers: [HealthController, NotifyController],
  providers: [PrismaService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number.parseInt(process.env.NOTIFY_PORT ?? '4020', 10);
  await app.listen(port, 'localhost');
  console.log(`alveare-notify up : http://localhost:${port}/healthz`);
}
void bootstrap();
