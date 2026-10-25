/**
 * @alveare/audit-service — service d'audit :4030 (E3 T3.4 + T3.5).
 * Zone Red : toute modification du cœur de drain ou de l'API lecture
 * exige une revue indépendante (auteur ≠ réviseur) + accord humain
 * final (AGENTS.md / revue-criticite).
 *
 * Rôle : transférer audit.outbox → audit.events (table partitionnée
 * mensuellement, FR-03.2) via BullMQ, et exposer la lecture admin
 * FR-03.3 (GET /admin/audit). Socle = convention services (notify) :
 * PrismaService, AuthGuard @alveare/auth, initialisations STRICTES
 * avant listen, enableShutdownHooks.
 *
 * Déclenchement du drain (plan E3 §2) :
 *   * sweep répétable BullMQ toutes les 30 s (rattrape tout, y compris
 *     un job signal perdu — garantie outbox transactionnelle intacte) ;
 *   * les émetteurs peuvent en plus enfiler un signal de latence
 *     `signalDrain()` (@alveare/audit) après commit — brancher dans un
 *     commit SUIVANT (consigne T3.4).
 *
 * Idempotence : unicité (outbox_id, at) sur audit.events + ON CONFLICT
 * DO NOTHING — un double drain ne crée JAMAIS de doublon.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Request } from 'express';
import { isAdminEffective, requireToken, type TokenUser } from '@alveare/auth';
import {
  DRAIN_BATCH_SIZE,
  drainBatch,
  drainUntilEmpty,
  type DrainRawClient,
  type DrainStats,
} from './drain';
import {
  buildAuditListSql,
  clampLimit,
  decodeCursor,
  encodeCursor,
  parseAuditQuery,
  type AuditListRow,
} from './read';

type AuthRequest = Request & { user?: TokenUser };

/** Queue unique du pipeline (contrat partagé avec @alveare/audit). */
export const AUDIT_DRAIN_QUEUE = 'audit-drain';
/** Période du sweep répétable (plan E3 §2.b : toutes les 30 s). */
export const SWEEP_INTERVAL_MS = 30_000;

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

/**
 * Admin : rôle realm 'admin' OU grant 'admin' sur core-admin (B §2.4,
 * mirror identity) — compte global ≠ accès automatique.
 */
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

/**
 * Worker BullMQ : connecte Redis (STRICT avant listen — Redis
 * injoignable = refus de démarrer, convention « pas de démarrage
 * dégradé silencieux »), ajoute le sweep répétable 30 s, ferme
 * proprement (worker → queue → connection) à l'arrêt.
 */
@Injectable()
export class DrainWorkerService implements OnModuleInit, OnModuleDestroy {
  private connection!: Redis;
  private queue!: Queue;
  private worker!: Worker<undefined, DrainStats, string>;

  constructor(private prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
    this.connection = new Redis(url, {
      // BullMQ : requêtes bloquantes (BRPOPLPUSH) — jamais de cap de
      // retries par requête sur la connexion partagée queue+worker.
      maxRetriesPerRequest: null,
    });
    await this.connection.ping(); // STRICT : avorte le boot si Redis est down

    this.queue = new Queue(AUDIT_DRAIN_QUEUE, {
      connection: this.connection,
      // Backoff exponentiel 2 s ×5 pour les jobs signal / sweep
      // (plan E3 T3.4) — un job en échec refait un sweep au retry.
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });

    this.worker = new Worker(
      AUDIT_DRAIN_QUEUE,
      this.processJob,
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('error', (err) =>
      console.error(`drain worker : ${String(err)}`),
    );

    // Sweep répétable : rattrapage universel (signal perdu, émetteur
    // qui n'enfile pas, crash BullMQ) — idempotent par design.
    await this.queue.add('sweep', undefined, {
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 600, count: 20 },
      removeOnFail: { age: 3600 },
    });
    console.log(
      `audit drain : queue « ${AUDIT_DRAIN_QUEUE} » (sweep ${SWEEP_INTERVAL_MS / 1000}s, lot max ${DRAIN_BATCH_SIZE})`,
    );
  }

  private processJob = async (_job: Job<undefined, DrainStats, string>): Promise<DrainStats> => {
    return this.sweep();
  };

  /**
   * UN sweep : drains successifs — chaque lot = une transaction
   * Prisma dédiée (SELECT verrouillé + INSERT + UPDATE, commit Prisma
   * autour du lot, T3.4).
   */
  async sweep(): Promise<DrainStats> {
    return drainUntilEmpty(async () =>
      this.prisma.$transaction((tx) => drainBatch(tx as unknown as DrainRawClient), {
        timeout: 20_000,
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close(); // fin du job en cours, plus de drain
    await this.queue?.close();
    await this.connection?.quit();
  }
}

@Controller()
class HealthController {
  @Get('/healthz')
  health() {
    return {
      service: 'alveare-audit',
      status: 'ok',
      version: '0.1.0',
      bricks: [
        'auth-rs256',
        'admin-guard',
        'mq-bullmq',
        'drain-sweep-30s',
        'drain-idempotent',
        'outbox-locked-batches',
        'partitions-monthly',
        'cursor-pagination',
      ],
    };
  }
}

/** Lecture admin FR-03.3 : { items, nextCursor }. */
@Controller('admin')
class AdminAuditController {
  constructor(private prisma: PrismaService) {}

  @Get('audit')
  @UseGuards(AdminGuard)
  async list(@Req() req: AuthRequest) {
    const parsed = parseAuditQuery(req.query as unknown as Record<string, unknown>);
    if (!parsed.ok) {
      throw new HttpException(parsed.error, 400);
    }

    // R-2 / F-8 (revue T3.8) : deux échecs de nature différente —
    //   * un curseur ILLISIBLE est une erreur CLIENT (400) : elle est
    //     détectée AVANT la requête, jamais en masquant un échec BD ;
    //   * tout autre échec (SQL, indisponibilité…) est un échec SERVEUR :
    //     il remonte tel quel (Nest → 500 par défaut) avec une trace
    //     serveur concise — on ne le transforme JAMAIS en 400.
    if (
      parsed.query.cursor !== undefined &&
      decodeCursor(parsed.query.cursor) === null
    ) {
      throw new HttpException('curseur illisible', 400);
    }

    let rows: AuditListRow[];
    try {
      rows = await this.prisma.$queryRaw<AuditListRow[]>(
        buildAuditListSql(parsed.query),
      );
    } catch (err) {
      // Échec BD non nommé : log serveur (diagnostic) puis remontée
      // brute — Nest répond 500, l'erreur reste visible côté logs.
      console.error(`audit lecture : échec BD de GET /admin/audit : ${String(err)}`);
      throw err;
    }

    const limit = clampLimit(parsed.query.limit);
    const items = rows.map((r) => ({
      id: String(r.id),
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
      actor: r.actor,
      action: r.action,
      target: r.target,
      details: r.details ?? null,
      outboxId: r.outbox_id === null || r.outbox_id === undefined ? null : String(r.outbox_id),
    }));
    // Page pleine → pointeur opaque sur la dernière ligne (suite du
    // tri at DESC, id DESC) ; sinon c'était la fin.
    const nextCursor =
      items.length === limit && items.length > 0
        ? encodeCursor(rows[rows.length - 1].at as Date, Number(rows[rows.length - 1].id))
        : null;
    return { items, nextCursor };
  }
}

@Module({
  controllers: [HealthController, AdminAuditController],
  providers: [PrismaService, DrainWorkerService],
})
class AppModule {}

async function bootstrap() {
  console.log(
    `audit drain : sweep ${SWEEP_INTERVAL_MS / 1000}s — REDIS_URL=${process.env.REDIS_URL ? 'définie' : 'défaut redis://localhost:6379/0'}`,
  );
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number.parseInt(process.env.AUDIT_PORT ?? '4030', 10);
  await app.listen(port, 'localhost');
  console.log(`alveare-audit up : http://localhost:${port}/healthz`);
}
void bootstrap();
