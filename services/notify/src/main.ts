/**
 * @alveare/notify — service de notifications (E5, FR-05.1/FR-05.2).
 * Zone Red : toute modification du stockage des destinataires, des
 * templates ou des adaptateurs d'envoi exige une revue indépendante
 * (auteur ≠ réviseur) + accord humain final.
 *
 * Principes :
 * - Adresse destinataire : hash pour l'indexation + JWE au repos —
 *   jamais en clair en BD, jamais en log, jamais en réponse API.
 * - Templates i18n fr/ar/en chargés STRICTEMENT au démarrage (un
 *   manquant = refus de démarrer) ; AR rendu dir="rtl".
 * - Envoi SYNCHRONE V1 (adaptateur dev instantané) : le POST rend le
 *   statut réel 'sent'/'failed' — l'asynchrone/offline revient avec
 *   le bus d'événements V2 (ADR-0002).
 * - Les erreurs transport sont relayées génériques ('envoi impossible')
 *   : un message SMTP peut refléter l'adresse.
 * - Auth = @alveare/auth (RS256 épinglé, client autorisé).
 * - Audit E3 : outbox transactionnel @alveare/audit (notify.send
 *   INSIDE-tx ; notify.sent/notify.failed hors-tx comme avant) ;
 *   audit.events n'est plus que la cible du drain du service audit
 *   :4030.
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
import * as path from 'node:path';
import type { Request } from 'express';
import { isAdminEffective, requireToken, type TokenUser } from '@alveare/auth';
import { auditOutbox, type AuditRawClient } from '@alveare/audit';
import { hashRecipient, sealRecipient } from './pii';
import { parseSendInput, type Lang, type Template } from './validate';
import { MAX_EMITTER_PER_WINDOW, floodScore } from './flood';
import { loadTemplates, render, type Rendered, type TemplatesMap } from './render';
import { makeEmailAdapter, type EmailAdapter, type MailResult } from './email';
import { makeSmsProvider, type SmsProvider } from './sms';
import { outboxFile } from './outbox';

type AuthRequest = Request & { user?: TokenUser };

/**
 * Trace d'audit — E3 T3.3 (zone Red) : outbox transactionnel
 * @alveare/audit. Le helper n'ouvre JAMAIS de transaction lui-même :
 * `client`/`tx` reçoivent le même objet —
 *   * depuis la transaction métier (`tx`) : audit INSIDE-tx, borne de
 *     commit inchangée (rollback métier => rollback audit) ;
 *   * après envoi (`this.prisma`) : INSERT unique en autocommit sur le
 *     client — même borne de commit qu'avant (l'ancienne écriture
 *     directe audit.events était aussi hors transaction explicite),
 *     aucun begin/commit ouvert ici (consigne T3.3).
 */
async function audit(
  client: AuditRawClient,
  actor: string,
  action: string,
  target: string,
) {
  await auditOutbox(client, client, { actor, action, target });
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

/** Runtime global initialisé STRICTEMENT au démarrage (avant listen). */
type Runtime = { templates: TemplatesMap; email: EmailAdapter; sms: SmsProvider };
let RT!: Runtime;

@Controller()
class NotifyController {
  constructor(private prisma: PrismaService) {}

  /**
   * POST /send (FR-05.1) — validation stricte, rendu i18n, idempotence
   * via dedupKey, anti-flood 5/destinataire/minute, envoi SYNCHRONE via
   * adaptateur, statut réel en retour. Le `to` n'apparaît NI dans la
   * réponse NI dans les erreurs NI dans les logs.
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

    // Revue N5-3 : le template `test` ne sert qu'aux administrateurs —
    // sinon tout compte authentifié pourrait générer du trafic arbitraire.
    if (input.template === 'test' && !isAdminEffective(user)) {
      throw new HttpException('template test réservé aux administrateurs', 403);
    }

    // Revue N5-2 : PRE-CHECK dedup AVANT toute consommation de fente
    // anti-flood — un replay purement idempotent ne doit rien coûter.
    if (input.dedupKey !== undefined) {
      const prior = await this.prisma.notification.findFirst({
        where: { via: input.via, dedupKey: input.dedupKey },
        select: { id: true, status: true },
      });
      if (prior) {
        return { id: prior.id.toString(), status: prior.status, deduped: true };
      }
    }

    let rendered: Rendered;
    try {
      rendered = render(RT.templates, input.template, input.lang, input.params);
    } catch {
      throw new HttpException('params insuffisants pour ce template', 400);
    }

    // Revue N5-3 : plafond PAR ÉMETTEUR (compte authentifié) en plus du
    // plafond destinataire — limite la capacité d'inonder.
    const emitter = floodScore(`usr:${user.sub}`, Date.now(), MAX_EMITTER_PER_WINDOW);
    if (!emitter.ok) {
      throw new HttpException('trop de messages de cet émetteur (cap 20/minute)', 429);
    }

    const recipientHash = hashRecipient(input.to);
    const verdict = floodScore(recipientHash);
    if (!verdict.ok) {
      throw new HttpException('trop de messages pour ce destinataire (cap 5/minute)', 429);
    }
    const recipientCipher = await sealRecipient(input.to);

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

      let result: MailResult = { ok: false, error: 'envoi impossible' };
      if (input.channel === 'email') {
        result = await RT.email.send(input.to, rendered.subject, rendered.text, rendered.html);
      } else {
        result = await RT.sms.send(input.to, rendered.text);
      }
      const status = result.ok ? 'sent' : 'failed';
      await this.prisma.notification.update({
        where: { id: created.id },
        data: { status, error: result.error ?? null, sentAt: result.ok ? new Date() : null },
      });
      await audit(
        this.prisma,
        user.sub,
        result.ok ? 'notify.sent' : 'notify.failed',
        created.id.toString(),
      );
      return { id: created.id.toString(), status, deduped: false };
    } catch (err) {
      // dedupKey déjà consommé → idempotent (pas de 2e envoi)
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const prior = await this.prisma.notification.findFirst({
          where: { via: input.via, dedupKey: input.dedupKey },
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
      bricks: [
        'auth-rs256',
        'pii-sealed-recipients',
        'api-send-idempotent',
        'anti-flood',
        'emitter-cap',
        'dedup-scoped-via',
        'templates-i18n-strict',
        'email-smtp-or-dev',
        'sms-provider-dev',
      ],
    };
  }
}

@Module({
  controllers: [HealthController, NotifyController],
  providers: [PrismaService],
})
class AppModule {}

async function bootstrap() {
  // Templates + adaptateurs : STRICT, avant tout listen (aucun
  // démarrage dégradé silencieux).
  const tplRoot = process.env.NOTIFY_TEMPLATES_DIR ?? path.resolve('templates');
  RT = {
    templates: loadTemplates(tplRoot),
    email: makeEmailAdapter(),
    sms: makeSmsProvider(),
  };
  console.log(
    `templates i18n complets : ${tplRoot} (4 templates × fr/ar/en)`,
  );
  console.log(`adaptateurs : email=${process.env.SMTP_URL ? 'smtp' : 'outbox-dev'} sms=dev`);
  if (!process.env.SMTP_URL) {
    console.log(`outbox dev : ${outboxFile()}`);
  }

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number.parseInt(process.env.NOTIFY_PORT ?? '4020', 10);
  await app.listen(port, 'localhost');
  console.log(`alveare-notify up : http://localhost:${port}/healthz`);
}
void bootstrap();
