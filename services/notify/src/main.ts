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
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpException,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { requireToken, type TokenUser } from '@alveare/auth';
import { hashRecipient, sealRecipient } from './pii';
import { parseSendInput } from './validate';
import { floodScore } from './flood';

type AuthRequest = Request & { user?: TokenUser };

/** Trace d'audit sync (schéma audit, table events — SQL brut). */
async function audit(
  tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  actor: string,
  action: string,
  target: string,
) {
  await tx.$queryRaw`
    INSERT INTO audit.events (actor, action, target)
    VALUES (${actor}, ${action}, ${target})`;
}

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

  /**
   * POST /send (FR-05.1) — enregistre un message destinataire chiffré,
   * idempotent via dedupKey, anti-flood 5/destinataire/minute, puis
   * répond 202. L'envoi effectif est branché en S3 (adaptateurs) —
   * en S2 le message reste 'queued' ; le sandbox ne promet jamais un
   * envoi qu'il n'a pas prouvé.
   * Zone Red : le `to` n'apparaît NI dans la réponse NI dans les
   * erreurs NI dans les logs.
   */
  @Post('send')
  @UseGuards(AuthGuard)
  async send(@Req() req: AuthRequest, @Body() body: unknown) {
    const user = req.user as TokenUser;
    const parsed = parseSendInput(body);
    if (!parsed.ok) {
      throw new HttpException(parsed.error, parsed.status);
    }
    const input = parsed.input;
    const recipientHash = hashRecipient(input.to);
    const recipientCipher = await sealRecipient(input.to);

    const verdict = floodScore(recipientHash);
    if (!verdict.ok) {
      throw new HttpException('trop de messages pour ce destinataire (cap 5/minute)', 429);
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.notification.create({
          data: {
            channel: input.channel,
            template: input.template,
            lang: input.lang,
            recipientHash,
            recipientCipher,
            via: input.via,
            status: 'queued',
            dedupKey: input.dedupKey,
          },
        });
        await audit(
          tx,
          user.sub,
          'notify.send',
          `${row.id}:${input.channel}:${input.template}`,
        );
        return row;
      });
      return { id: created.id.toString(), status: 'queued', deduped: false };
    } catch (err) {
      // dedupKey déjà consommé → idempotent (pas de 2e envoi)
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const prior = await this.prisma.notification.findFirst({
          where: { dedupKey: input.dedupKey },
          select: { id: true, status: true, createdAt: true },
        });
        if (prior) {
          return { id: prior.id.toString(), status: prior.status, deduped: true };
        }
      }
      throw err;
    }
  }

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
      bricks: ['auth-rs256', 'pii-sealed-recipients', 'api-send-idempotent', 'anti-flood'],
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
