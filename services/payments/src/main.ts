/**
 * @alveare/payments-service — service Paiements :4040 (E6, T4.3/T4.4).
 * Zone Red (argent, réglementaire) : revue indépendante obligatoire
 * (auteur ≠ réviseur, AGENTS.md / revue-criticite).
 *
 * Rôle : transactions, remboursements, webhooks signés sortants vers
 * les apps, sweeps (réconciliation/expiry) — machine à états STRICTE
 * (@alveare/payments, plan E6 §2.3), audit outbox DANS chaque
 * transaction métier (@alveare/audit — héritage E3), SQL paramétré
 * exclusivement (store.ts) : le seul modèle Prisma utilisé est
 * identity RoleGrant (lecture du grant admin/app, miroir
 * services/audit).
 *
 * Conventions services (audit/notify) : guards @alveare/auth, Redis
 * ping STRICT avant listen, enableShutdownHooks, close propre.
 * Fabrique d'adapter : PAYMENTS_PROVIDER inconnu = boot refusé.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Module,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma, PrismaClient } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Request } from 'express';
import {
  PaymentCreateSchema,
  PaymentWebhookEventSchema,
  PaymentWebhookPayloadSchema,
  RefundRequestSchema,
  PAYMENT_STATUS,
  type PaymentWebhookPayload,
} from '@alveare/contracts';
import { isAdminEffective, requireToken, type TokenUser } from '@alveare/auth';
import { auditOutbox, signalDrain, type AuditRawClient } from '@alveare/audit';
import {
  makePaymentProvider,
  signOutbound,
  verifyChargilyWebhook,
  chargilySecretKey,
  transition,
  IllegalTransitionError,
  devSimulate,
  paymentsHttpTimeoutMs,
  type PaymentProvider,
} from '@alveare/payments';
import type { PaymentStatus, PaymentView } from '@alveare/contracts';
import * as store from './store';
import {
  closesOn,
  planRefund,
  paymentsWebhookCap,
  ttlSeconds,
  viewFromRow,
} from './plan';

type AuthRequest = Request & { user?: TokenUser; rawBody?: Buffer };
type SqlTx = store.SqlClient;

/** Queue unique des livraisons webhook sortantes (contrat du service). */
export const PAYMENTS_WEBHOOK_OUT_QUEUE = 'payments-webhooks-out';
/** Période du sweep répétable (réconciliation/expiry, gabarit E3 30 s). */
export const SWEEP_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------
// Guards (miroir services/audit : AuthGuard + AdminGuard).
// ---------------------------------------------------------------------

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
 * miroir services/audit — compte global ≠ accès automatique).
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
 * Décision d'accès « propriétaire d'app » : admin (realm ou grant
 * core-admin) OU tout grant existant (sub, app) — une app ne lit NI ne
 * pilote les transactions d'une AUTRE app (B §2.4).
 */
async function hasAppAccess(
  prisma: PrismaService,
  user: TokenUser,
  app: string,
): Promise<boolean> {
  const grants = await prisma.roleGrant.findMany({
    where: { userId: user.sub, OR: [{ app }, { app: 'core-admin' }] },
    select: { app: true, role: true },
  });
  if (isAdminEffective(user, null)) return true; // realm admin
  if (grants.some((g) => g.role === 'admin')) return true; // app ou core-admin
  return grants.some((g) => g.app === app);
}

/**
 * Garde-mort e2e (pattern packages/auth S-3) : endpoints du simulateur
 * PSP fictif refusés sauf PAYMENTS_PROVIDER=dev ET ALV_ALLOW_E2E=1
 * explicitement posé — variable inexistante en prod (aucun déploiement
 * Infisical ne la porte) : garde contre un accident de configuration.
 */
function e2eGate(): void {
  if (
    process.env.PAYMENTS_PROVIDER !== 'dev' ||
    process.env.ALV_ALLOW_E2E !== '1'
  ) {
    throw new NotFoundException();
  }
}

// ---------------------------------------------------------------------
// Worker : livraisons webhook sortantes + sweep répétable.
// ---------------------------------------------------------------------

@Injectable()
export class PaymentsWorkerService implements OnModuleInit, OnModuleDestroy {
  private connection!: Redis;
  private queue!: Queue;
  private worker!: Worker<unknown, unknown, string>;
  private providerImpl?: PaymentProvider;

  constructor(private prisma: PrismaService) {}

  /** Adapter actif — induit au boot (fabrique STRICTE). */
  get provider(): PaymentProvider {
    if (this.providerImpl === undefined) {
      throw new Error('adapter non initialisé (onModuleInit)');
    }
    return this.providerImpl;
  }

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
    this.connection = new Redis(url, {
      // BullMQ : requêtes bloquantes — jamais de cap par requête.
      maxRetriesPerRequest: null,
    });
    await this.connection.ping(); // STRICT : Redis down → refus de boot

    // Fabrique d'adapter : PAYMENTS_PROVIDER inconnu → THROW
    // (boot refusé, pattern services/notify/src/sms.ts).
    this.providerImpl = makePaymentProvider();

    const cap = paymentsWebhookCap();
    this.queue = new Queue(PAYMENTS_WEBHOOK_OUT_QUEUE, {
      connection: this.connection,
      // Livraisons : retries avec backoff exponentiel ; le plafond
      // d'attempts = cap → fin de vie en payments.webhook_dead (S-2).
      defaultJobOptions: {
        attempts: cap,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });

    this.worker = new Worker(PAYMENTS_WEBHOOK_OUT_QUEUE, this.processJob, {
      connection: this.connection,
      concurrency: 4,
      // D-8 (revue T4.7) : job d'abort PSP ≤ timeout client — un
      // fetchStatus lent ne doit jamais libérer le lock BullMQ sous le
      // traitement (double livraison sinon).
      lockDuration: 120_000,
    });
    this.worker.on('error', (err) =>
      console.error(`payments worker : ${String(err)}`),
    );

    // Sweep répétable : réconciliation source-de-vérité-serveur (plan
    // §2.2) + auto-expiry — idempotent par design.
    await this.queue.add('sweep', undefined, {
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 600, count: 20 },
      removeOnFail: { age: 3600 },
    });
    console.log(
      `payments : queue « ${PAYMENTS_WEBHOOK_OUT_QUEUE} » (sweep ${SWEEP_INTERVAL_MS / 1000}s, cap webhook ${cap}, adapter ${this.provider.name})`,
    );
  }

  /**
   * Enfile une livraison webhook (idempotent par jobId = event_uid :
   * un double enqueue ne livre JAMAIS deux fois).
   *
   * jobId encodé base64url : BullMQ refuse un custom id contenant « : »
   * (sauf composité 3 segments) — or l'event_uid entrant est libre
   * (le PSP « dehors » peut l'écrire comme il veut) ; l'encodage
   * déterministe préserve l'idempotence sans fuite de format.
   */
  async enqueueWebhook(payload: PaymentWebhookPayload): Promise<void> {
    const jobId = Buffer.from(payload.event_uid, 'utf8').toString('base64url');
    await this.queue.add('deliver', payload, {
      jobId,
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 7200 },
    });
  }

  /** Signal de drain audit (optimisation de latence, fire-and-forget). */
  signalAuditDrainPublic(): void {
    void signalDrain(this.connection, { source: 'payments' });
  }

  private processJob = async (job: Job<unknown, unknown, string>): Promise<unknown> => {
    if (job.name === 'sweep') return this.sweep();
    return this.deliver(job);
  };

  /**
   * LIVRAISON signée vers l'app propriétaire. Sur échec DÉFINITIF
   * (tentative >= cap) : déplacement en payments.webhook_dead +
   * console.error STRUCTURÉ — jamais silencieux (pattern E3 S-2). Le
   * secret (app_endpoints.secret) n'est JAMAIS loggé.
   */
  private async deliver(job: Job<unknown, unknown, string>): Promise<unknown> {
    const parsed = PaymentWebhookPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      // Payload interne corrompu = jamais livré — quarantaine immédiate
      // (pas de relance à l'infini sur un format cassé).
      return this.deadLetter(job, `payload non conforme : ${parsed.error.message}`, 1);
    }
    const payload = parsed.data;
    const body = JSON.stringify(payload);
    const endpoint = await store.getEndpoint(this.prisma, payload.app);
    if (
      !endpoint ||
      !endpoint.enabled ||
      typeof endpoint.url !== 'string' ||
      endpoint.url === ''
    ) {
      // App non branchée ≠ échec de livraison : signalé (jamais
      // silencieux), sortie propre (rattrapage par GET /payments/:id).
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          component: 'payments-webhook',
          event: 'endpoint_absent',
          app: payload.app,
          payment_id: payload.payment_id,
          event_uid: payload.event_uid,
        }),
      );
      return { delivered: false, skipped: true };
    }

    const t = Math.floor(Date.now() / 1000);
    // D-5 (revue T4.7) : le secret (signature sortante) est dans le
    // chemin d'échec — un secret vide/absent ne doit JAMAIS mourir
    // hors DLQ : routé via onDeliveryFailure comme un échec réseau.
    let signature: string;
    try {
      signature = signOutbound(endpoint.secret, body, t);
    } catch (err) {
      await this.onDeliveryFailure(
        job,
        payload.event_uid,
        `signature impossible : ${String(err).slice(0, 200)}`,
      );
      throw err; // BullMQ backoff → DLQ au cap (aucune perte silencieuse)
    }
    let res: Response;
    try {
      res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ALVEARE-Signature': signature,
        },
        body,
        // D-1 (revue T4.7) : abort configurable, même budget que les
        // appels PSP (aucun call réseau sans abort).
        signal: AbortSignal.timeout(paymentsHttpTimeoutMs()),
      });
    } catch (err) {
      await this.onDeliveryFailure(job, payload.event_uid, String(err));
      throw err; // BullMQ backoff exponentiel
    }

    if (res.ok) {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          component: 'payments-webhook',
          event: 'delivered',
          app: payload.app,
          event_uid: payload.event_uid,
        }),
      );
      // Règle d'or n°6 : trace payment.webhook.sent DANS le outbox
      // (autocommit hors transaction, pattern notify.sent — cf. T3.3 :
      // aucune transaction ouverte ici, même borne de commit qu'une
      // écriture directe).
      await auditOutbox(
        this.prisma as unknown as AuditRawClient,
        this.prisma as unknown as AuditRawClient,
        {
          actor: 'system:payments-webhook',
          action: 'payment.webhook.sent',
          target: payload.payment_id,
          details: {
            app: payload.app,
            event_uid: payload.event_uid,
            event: payload.event,
            via: 'payments',
          },
        },
      );
      return { delivered: true };
    }

    const msg = `livraison webhook : HTTP ${res.status}`;
    await this.onDeliveryFailure(job, payload.event_uid, msg);
    throw new Error(msg);
  }

  /** Journal d'un échec de livraison (jamais muet ; aucun secret). */
  private async onDeliveryFailure(
    job: Job<unknown, unknown, string>,
    eventUid: string,
    error: string,
  ): Promise<void> {
    const cap = paymentsWebhookCap();
    const attempt = job.attemptsMade + 1;
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        component: 'payments-webhook',
        event: 'delivery_failed',
        event_uid: eventUid,
        attempt,
        attempts_cap: cap,
        error: error.slice(0, 300),
      }),
    );
    if (attempt >= cap) {
      await this.deadLetter(job, error, attempt);
    }
  }

  /**
   * Quarantaine : copie en payments.webhook_dead (payload, erreur,
   * attempts) — jamais silencieux ; exit PROPRE (plus de retry).
   */
  private async deadLetter(
    job: Job<unknown, unknown, string>,
    error: string,
    attempts: number,
  ): Promise<unknown> {
    const payload =
      job.data && typeof job.data === 'object'
        ? (job.data as Record<string, unknown>)
        : null;
    await store.insertWebhookDead(
      this.prisma,
      JSON.stringify(payload ?? { event_uid: `job:${job.id ?? 'inconnu'}` }),
      error.slice(0, 500),
      Math.max(attempts, 0),
    );
    console.error(
      JSON.stringify({
        at: new Date().toISOString(),
        component: 'payments-webhook',
        event: 'dead_letter',
        error: error.slice(0, 500),
        attempts,
      }),
    );
    // Règle d'or n°6 : trace payment.webhook.dead DANS le outbox (S-2 :
    // jamais silencieux — quarantaine + piste audit, autocommit hors tx).
    await auditOutbox(
      this.prisma as unknown as AuditRawClient,
      this.prisma as unknown as AuditRawClient,
      {
        actor: 'system:payments-webhook',
        action: 'payment.webhook.dead',
        target:
          typeof payload?.payment_id === 'string' ? payload.payment_id : null,
        details: {
          error: error.slice(0, 300),
          attempts,
          event_uid:
            typeof payload?.event_uid === 'string' ? payload.event_uid : null,
          via: 'payments',
        },
      },
    );
    return { delivered: false, dead: true };
  }

  /**
   * SWEEP : réconciliation adapter-fetchStatus (source de vérité
   * serveur, R2 SATIM) puis auto-expiry des pending silencieuses
   * (pending > TTL). Chaque application = une transaction dédiée.
   */
  async sweep(): Promise<{
    examined: number;
    reconciled: number;
    expired: number;
    failed: number;
  }> {
    const rows = await store.listPending(this.prisma, 50);
    let reconciled = 0;
    let expired = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (!row.provider_ref) {
          // Checkout jamais abouti : la pending ne peut pas converger
          // seule — failed (trace + webhook), la clé (app, app_ref)
          // reste idempotente pour un nouvel essai… après une purge
          // opérateur (état terminal, cf. runbook).
          if (await this.applyRemoteStatus(row, 'failed', 'sweep-orphelin')) failed++;
          continue;
        }
        const st = await this.provider.fetchStatus(row.provider_ref);
        if (st.status !== 'pending') {
          if (
            await this.applyRemoteStatus(row, st.status, 'sweep-reconcile', {
              paidAt: st.paidAt ?? null,
              feeCents: st.feeAmount ?? null,
            })
          )
            reconciled++;
          continue;
        }
        const ageSeconds = (Date.now() - row.created_at.getTime()) / 1000;
        if (ageSeconds > ttlSeconds()) {
          // Watchdog (jamais silencieux — alerting à brancher, plan §4).
          console.error(
            JSON.stringify({
              at: new Date().toISOString(),
              component: 'payments-sweep',
              event: 'pending_expired',
              payment_id: row.id,
              app: row.app,
              age_seconds: Math.round(ageSeconds),
              ttl_seconds: ttlSeconds(),
            }),
          );
          if (await this.applyRemoteStatus(row, 'expired', 'sweep-expire')) expired++;
        }
      } catch (err) {
        // Une ligne qui échoue au sweep ne casse pas le lot — le
        // prochain sweep la retentera (jamais muet : piste ici).
        console.warn(
          JSON.stringify({
            at: new Date().toISOString(),
            component: 'payments-sweep',
            event: 'row_error',
            payment_id: row.id,
            error: String(err).slice(0, 300),
          }),
        );
      }
    }
    return { examined: rows.length, reconciled, expired, failed };
  }

  /**
   * Applique une résolution (signal PSP / sweep) via la machine à
   * états STRICTE + trace audit DANS la transaction + enfile la
   * livraison webhook APRÈS commit (+ signalDrain piste audit).
   * PUBLIQUE : le contrôleur l'utilise pour les résolutions synchrones
   * (échec de checkout, dev-confirm e2e).
   */
  async applyRemoteStatus(
    row: store.TxnRow,
    to: PaymentStatus,
    kind:
      | 'sweep-reconcile' | 'sweep-expire' | 'sweep-orphelin'
      | 'dev-confirm' | 'dev-fail'
      | 'create-fail',
    extras: { paidAt?: string | null; feeCents?: string | null } = {},
  ): Promise<boolean> {
    transition(row.status, to); // IllegalTransitionError → catch sweep

    const eventUid = `${kind}:${row.id}`;
    const applied = await this.prisma.$transaction(async (tx) => {
      // Garde atomique : l'UPDATE ne passe que si le statut courant est
      // exactement `from` (double-consommation impossible).
      const spent = await store.applyStatus(tx as unknown as SqlTx, row.id, row.status, to, {
        eventUid,
        paidAt: extras.paidAt ?? null,
        feeCents: extras.feeCents ?? null,
        close: closesOn(to),
      });
      if (spent === 0) return false; // déjà appliqué par un flux concurrent

      // Trace d'audit obligatoire DANS la transaction (règle d'or n°6).
      await auditOutbox(
        this.prisma as unknown as AuditRawClient,
        tx as unknown as AuditRawClient,
        {
          actor: kind.startsWith('sweep')
            ? 'system:payments-sweep'
            : kind === 'create-fail'
              ? 'system:payments-create'
              : 'system:payments-dev',
          action: `payment.${to}`,
          target: row.id,
          details: {
            app: row.app,
            from: row.status,
            to,
            via: 'payments',
          },
        },
      );
      return true;
    });
    if (!applied) return false;

    await this.enqueueOutbound(row.id, to, eventUid);
    this.signalAuditDrainPublic();
    return true;
  }

  /** Construit + enfile le webhook SORTANT d'une transition. */
  async enqueueOutbound(
    txnId: string,
    status: PaymentStatus,
    eventUid: string,
  ): Promise<void> {
    const row = await store.getTxnById(this.prisma, txnId);
    if (!row) return;
    const payload = PaymentWebhookPayloadSchema.parse({
      event_uid: eventUid,
      event: `payment.${status}`,
      payment_id: row.id,
      app: row.app,
      app_ref: row.app_ref,
      status,
      amount: row.amount,
      refunded_amount: row.refunded,
      currency: row.currency,
      ts: new Date().toISOString(),
    });
    await this.enqueueWebhook(payload);
  }

  /**
   * Simulateur PSP fictif (e2e-only) : écrit le signal confirm|fail dans
   * le journal JSONL de l'adapter dev (mêmes appels qu'une vraie PSP,
   * fetchStatus du sweep le relit de façon identique) PUIS applique la
   * résolution à la machine à états (trace audit + webhook sortant,
   * idempotent par event_uid).
   */
  async devResolve(
    row: store.TxnRow,
    action: 'confirm' | 'fail',
  ): Promise<boolean> {
    if (!row.provider_ref) {
      throw new HttpException('transaction sans référence PSP', 409);
    }
    // D-10 (revue T4.7) : le simulateur porte des frais PSP (comme sur
    // les rails réels, R5) pour que 'paid' porte fee_amount non-nul
    // dès les e2e — invariant jamais optionnel dans les preuves.
    devSimulate(row.provider_ref, action,
      action === 'confirm' ? { feeAmount: '500' } : {});
    return this.applyRemoteStatus(
      row,
      action === 'confirm' ? 'paid' : 'failed',
      action === 'confirm' ? 'dev-confirm' : 'dev-fail',
      action === 'confirm'
        ? { paidAt: new Date().toISOString(), feeCents: '500' }
        : {},
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit();
  }
}

// ---------------------------------------------------------------------
// Controllers.
// ---------------------------------------------------------------------

@Controller()
class HealthController {
  @Get('healthz')
  health() {
    return {
      service: 'alveare-payments',
      status: 'ok',
      version: '0.1.0',
      bricks: [
        'payments-state-machine',
        'payments-webhooks-signed',
        'payments-webhook-dlq',
        'payments-refund-idempotent',
        'payments-sweep-30s',
        'audit-outbox-sync',
      ],
    };
  }
}

/**
 * Métier : create (idempotent), lecture (app propriétaire OU admin),
 * refund (plafond + idempotent), webhook entrant PSP, lecture admin.
 */
@Controller()
class PaymentsController {
  constructor(
    private prisma: PrismaService,
    private worker: PaymentsWorkerService,
  ) {}

  /**
   * POST /payments — création idempotente (unique (app, app_ref)).
   * Trace payment.created DANS la transaction ; le provider (checkout
   * hosted) est appelé HORS transaction (pas de lock BD en réseau).
   */
  @Post('payments')
  @UseGuards(AuthGuard)
  async create(@Req() req: AuthRequest, @Body() body: unknown) {
    const user = req.user as TokenUser;
    const parsed = PaymentCreateSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException('payload invalide (PaymentCreate)', 400);
    }
    const input = parsed.data;
    if (!(await hasAppAccess(this.prisma, user, input.app))) {
      throw new ForbiddenException("aucun accès à l'app demandée");
    }

    // 1) INSERT idempotent + trace payment.created — UNE transaction.
    let row: store.TxnRow | null = await this.prisma.$transaction(async (tx) => {
      const created = await store.insertTxn(tx as unknown as SqlTx, {
        app: input.app,
        appRef: input.app_ref,
        amountCents: input.amount,
        currency: input.currency,
        rail: input.rail,
        justRef: input.just_ref ?? null,
        provider: this.worker.provider.name,
      });
      if (created) {
        await auditOutbox(
          this.prisma as unknown as AuditRawClient,
          tx as unknown as AuditRawClient,
          {
            actor: user.sub,
            action: 'payment.created',
            target: created.id,
            details: {
              app: input.app,
              app_ref: input.app_ref,
              amount: input.amount,
              currency: input.currency,
              rail: input.rail,
              provider: this.worker.provider.name,
              via: 'payments',
            },
          },
        );
      }
      return created;
    });

    // Idempotence create : la ligne existe déjà — replay, aucun appel
    // PSP supplémentaire (le redirect restera le dernier connu),
    // EXCEPTÉ D-2 (revue T4.7) : une ligne 'created' dont le checkout a
    // expiré sans provider_ref est re-réconciliée (resume) au lieu de
    // rester orpheline pour toujours.
    if (!row) {
      row = await store.getTxnByAppRef(this.prisma, input.app, input.app_ref);
      if (!row) throw new Error('create : unicité (app, app_ref) sans ligne');
      if (row.status === 'created' && row.provider_ref === null) {
        return this.resumeCheckout(row);
      }
      return { payment: viewFromRow(row), redirect_url: null, deduped: true };
    }

    // 2) Checkout PSP (hosted) HORS transaction — pattern vue-retour :
    // ni l'URL ni le webhook PSP ne sont la source de vérité (§2.2).
    let co: Awaited<ReturnType<PaymentProvider['createCheckout']>>;
    try {
      co = await this.worker.provider.createCheckout({
        txnId: row.id,
        app: row.app,
        appRef: row.app_ref,
        amountCents: row.amount,
        currency: row.currency,
      });
    } catch (err) {
      // Échec checkout : created → failed (trace + webhook) ; l'app
      // peut rejouer son app_ref via un refund… ou demander une
      // réparation opérateur (état terminal, cf. runbook).
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          component: 'payments-create',
          event: 'checkout_failed',
          payment_id: row.id,
          error: String(err).slice(0, 300),
        }),
      );
      const fresh = await store.getTxnById(this.prisma, row.id);
      if (fresh) {
        // D-12 (revue T4.7) : kind propre — l'acteur de la trace
        // reflète le créateur (pas un sweep).
        await this.worker.applyRemoteStatus(fresh, 'failed', 'create-fail');
      }
      throw new HttpException('création du paiement impossible', 502);
    }

    // 3) created → pending + provider_ref (transition légale gardée).
    const current = row; // vue figée du flux
    const fin = await this.settleAfterCheckout(current, co, 'race_apply', false);
    return { payment: viewFromRow(fin.fin), redirect_url: fin.redirectUrl, deduped: fin.deduped };
  }

  /**
   * Post-checkout commun (create + resume D-2) : created → pending
   * via la garde atomique de la machine à états. Garde de course
   * (re-revue delta, BLOQUANT) : l'URL du checkout n'est rendue QUE si
   * c'est NOTRE provider_ref qui a gagné — une session PSP perdue
   * n'est jamais référencée en BD ; son URL ne doit JAMAIS atteindre
   * l'app (une session orpheline encaissable = argent non
   * rapprochable). Le perdant reste inoffensif (session jamais citée,
   * expire côté PSP) ; l'app consulte la ligne et l'url du gagnant.
   */
  private async settleAfterCheckout(
    row: store.TxnRow,
    co: { providerRef: string; redirectUrl: string },
    raceEvent: 'race_apply' | 'race_resume',
    dedupedWhenWon: boolean,
  ): Promise<{ fin: store.TxnRow; redirectUrl: string | null; deduped: boolean }> {
    let spent = 0;
    await this.prisma.$transaction(async (tx) => {
      spent = await store.applyStatus(
        tx as unknown as SqlTx,
        row.id,
        'created',
        'pending',
        { providerRef: co.providerRef },
      );
    });
    const fin = (await store.getTxnById(this.prisma, row.id)) ?? row;
    if (spent === 1) {
      return { fin, redirectUrl: co.redirectUrl, deduped: dedupedWhenWon };
    }
    // Course perdue : un flux concurrent a piloté la ligne.
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        component: 'payments-create',
        event: raceEvent,
        payment_id: row.id,
      }),
    );
    const ours = fin.status === 'pending' && fin.provider_ref === co.providerRef;
    return {
      fin,
      redirectUrl: ours ? co.redirectUrl : null,
      deduped: !ours,
    };
  }

  /**
   * D-2 (revue T4.7) : reprise d'un checkout manqué — la ligne
   * idempotente existe en 'created' sans provider_ref : on retente
   * createCheckout puis created → pending. Un re-échec passe en
   * 'failed' (terminal, tracé) : plus d'orphelin figé pour toujours.
   */
  private async resumeCheckout(row: store.TxnRow) {
    let co: Awaited<ReturnType<PaymentProvider['createCheckout']>>;
    try {
      co = await this.worker.provider.createCheckout({
        txnId: row.id,
        app: row.app,
        appRef: row.app_ref,
        amountCents: row.amount,
        currency: row.currency,
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          component: 'payments-create',
          event: 'checkout_resume_failed',
          payment_id: row.id,
          error: String(err).slice(0, 300),
        }),
      );
      await this.worker.applyRemoteStatus(row, 'failed', 'create-fail');
      throw new HttpException('création du paiement impossible', 502);
    }
    const settled = await this.settleAfterCheckout(row, co, 'race_resume', true);
    return {
      payment: viewFromRow(settled.fin),
      redirect_url: settled.redirectUrl,
      deduped: settled.deduped,
    };
  }

  /** GET /payments/:id — app propriétaire OU admin (plan §4). */
  @Get('payments/:id')
  @UseGuards(AuthGuard)
  async getOne(@Req() req: AuthRequest, @Param('id') id: string): Promise<{ payment: PaymentView }> {
    const user = req.user as TokenUser;
    const row = await store.getTxnById(this.prisma, id);
    if (!row) throw new NotFoundException('transaction inconnue');
    if (!(await hasAppAccess(this.prisma, user, row.app))) {
      throw new ForbiddenException("aucun accès à l'app demandée");
    }
    return { payment: viewFromRow(row) };
  }

  /**
   * POST /payments/:id/refund — «admin Core seulement» (porte Q-A,
   * revue D-7) : l'argent ne se rapatrie pas avec un simple grant
   * d'app — seul un admin (realm admin OU grant core-admin) déclenche
   * un remboursement. Plafond (≤ payé − déjà remboursé) +
   * idempotence refund_ref (Q9). Adapter PSP DANS la transaction (V1 :
   * assumé, cf. docs/ops-payments.md §2.1) — échec adapter = rollback
   * complet (état + trace + réclamation n'existent pas alors).
   */
  @Post('payments/:id/refund')
  @UseGuards(AuthGuard, AdminGuard)
  async refund(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const user = req.user as TokenUser;
    const parsed = RefundRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new HttpException('payload invalide (RefundRequest)', 400);
    }
    const ask = parsed.data;
    const existing = await store.getTxnById(this.prisma, id);
    if (!existing) throw new NotFoundException('transaction inconnue');
    // Q-A : plus aucun contrôle d'accès par grant d'app ici —
    // AdminGuard a déjà statué (admin realm OU core-admin) ;
    // existing.app reste utilisé pour la trace d'audit.

    const refund = await this.prisma.$transaction(async (tx) => {
      const locked = await store.lockTxnById(tx as unknown as SqlTx, id);
      if (!locked) throw new NotFoundException('transaction inconnue');

      const priorClaim = await store.getRefund(
        tx as unknown as SqlTx,
        locked.id,
        ask.refund_ref,
      );
      const plan = planRefund(
        {
          txnStatus: locked.status,
          amountCents: locked.amount,
          refundedCents: locked.refunded,
        },
        { refundRef: ask.refund_ref, amountCents: ask.amount },
        priorClaim ? { amountCents: priorClaim.amount } : null,
      );
      if (plan.kind === 'conflict-status') {
        throw new HttpException(
          `remboursement refusé : statut ${plan.status} n'est plus remboursable`,
          409,
        );
      }
      if (plan.kind === 'noop') return { kind: 'noop' as const };
      if (plan.kind === 'conflict-ref') {
        // Même refund_ref, montant différent : réclamation ambiguë —
        // refusée (les apps créent un refund_ref NOUVEAU par demande).
        throw new HttpException(
          'refund_ref déjà consommé avec un montant différent',
          409,
        );
      }
      if (plan.kind === 'over') {
        throw new HttpException(
          'remboursement refusé : montant supérieur au solde restant',
          400,
        );
      }

      // Réclamation atomique de la clé d'idempotence.
      if (!locked.provider_ref) {
        throw new HttpException('transaction sans référence PSP', 409);
      }
      const claim = await store.claimRefund(
        tx as unknown as SqlTx,
        locked.id,
        ask.refund_ref,
        plan.amountCents,
        ask.reason ?? null,
      );
      if (claim === null) {
        // Un flux concurrent a posé la MÊME clé — le convertis honnête
        // en replay no-op (unicité (txn_id, refund_ref) a tranché).
        return { kind: 'noop' as const };
      }

      // Adapter PSP (dev : écriture locale ; chargily : réseau —
      // en transaction, V1 assumé). Un échec avale TOUT le rollback.
      await this.worker.provider.refund(locked.provider_ref, plan.amountCents);

      // Machine à états : paid|partially_refunded → cible stricte.
      transition(locked.status, plan.newStatus);
      const spent = await store.applyStatus(
        tx as unknown as SqlTx,
        locked.id,
        locked.status,
        plan.newStatus,
        { eventUid: `refund:${claim.id}`, close: closesOn(plan.newStatus) },
      );
      if (spent !== 1) throw new Error('refund : transition perdue (race)');

      // Trace refund (règle 6 : payment.refunded — partiel flaggé).
      await auditOutbox(
        this.prisma as unknown as AuditRawClient,
        tx as unknown as AuditRawClient,
        {
          actor: user.sub,
          action: 'payment.refunded',
          target: locked.id,
          details: {
            refund_id: claim.id,
            refund_ref: ask.refund_ref,
            amount: plan.amountCents,
            partial: plan.newStatus === 'partially_refunded',
            app: locked.app,
            via: 'payments',
          },
        },
      );
      return {
        kind: 'applied' as const,
        claimId: claim.id,
        amountCents: plan.amountCents,
        newStatus: plan.newStatus,
      };
    });

    if (refund.kind === 'noop') {
      const rowNow = await store.getTxnById(this.prisma, id);
      return {
        payment: rowNow ? viewFromRow(rowNow) : null,
        refund: { deduped: true },
      };
    }

    // POST-commit : webhook sortant UNIQUEMENT en remboursement TOTAL
    // (statut refunded — contrat de payload ; un partiel reste
    // consultable via GET /payments/:id — cf. docs/ops-payments.md).
    if (refund.newStatus === 'refunded') {
      const committed = await store.getTxnById(this.prisma, id);
      if (committed) {
        await this.worker.enqueueOutbound(id, 'refunded', `refund:${refund.claimId}`);
      }
    }
    this.worker.signalAuditDrainPublic();
    const fin = await store.getTxnById(this.prisma, id);
    return {
      payment: fin ? viewFromRow(fin) : null,
      refund: {
        deduped: false,
        id: refund.claimId,
        amount: refund.amountCents,
        status: refund.newStatus,
      },
    };
  }

  /**
   * POST /payments/webhook — point d'entrée PSP. Machine à états
   * FORMEL, idempotent par event_uid. Signature re-vérifiée pour
   * chargily ; e2e confiné (dev, ALV_ALLOW_E2E=1). AUCUN secret loggé.
   */
  @Post('payments/webhook')
  async webhook(@Req() req: AuthRequest) {
    const providerName = process.env.PAYMENTS_PROVIDER ?? 'dev';
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';

    if (providerName === 'chargily') {
      let ok = false;
      try {
        ok = verifyChargilyWebhook(
          chargilySecretKey(),
          raw,
          req.headers['signature'] as string | undefined,
        );
      } catch {
        ok = false; // secret absent → refuse (jamais de bypass)
      }
      if (!ok) throw new HttpException('signature invalide', 401);
      // Idempotence entrante par event_uid → routage par provider_ref.
    } else if (providerName === 'satim') {
      // R2 : AUCUN webhook côté SATIM — aucun point d'entrée.
      throw new NotFoundException('satim : réconciliation par sweep uniquement');
    } else if (providerName === 'dev') {
      // Simulation PSP locale — uniquement quand ALV_ALLOW_E2E est
      // explicitement posé (garde-mort e2e, pattern packages/auth).
      if (process.env.ALV_ALLOW_E2E !== '1') {
        throw new NotFoundException();
      }
    } else {
      throw new HttpException('provider inconnu', 500);
    }

    const parsed = PaymentWebhookEventSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpException('payload webhook invalide', 400);
    }
    const evt = parsed.data;

    // D-3 (revue T4.7) : une course webhook concurrente peut violer
    // l'unicité event_uid (pg 23505 → Prisma P2002) — 409 structuré,
    // jamais un 500 brut.
    let out: { applied: boolean; status: string; id: string };
    try {
      out = await this.prisma.$transaction(async (tx) => {
      const locked = await store.getTxnByProviderRef(
        tx as unknown as SqlTx,
        evt.provider_ref,
      );
      if (!locked) throw new NotFoundException('transaction inconnue');
      if (locked.event_uid && locked.event_uid !== evt.event_uid) {
        throw new HttpException('event_uid divergent (déjà traité)', 409);
      }
      let decision: ReturnType<typeof transition>;
      try {
        decision = transition(locked.status, evt.status);
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          throw new HttpException(
            `transition illégale ${err.from} → ${err.to}`,
            409,
          );
        }
        throw err;
      }
      if (decision.kind === 'noop') {
        return { applied: false as const, status: locked.status, id: locked.id };
      }

      const spent = await store.applyStatus(
        tx as unknown as SqlTx,
        locked.id,
        locked.status,
        evt.status,
        {
          eventUid: evt.event_uid,
          paidAt: evt.paid_at ?? null,
          feeCents: evt.fee_amount ?? null,
          close: closesOn(evt.status),
        },
      );
      if (spent !== 1) {
        throw new HttpException('concurrent_colision', 409);
      }

      await auditOutbox(
        this.prisma as unknown as AuditRawClient,
        tx as unknown as AuditRawClient,
        {
          actor: `system:${providerName}-webhook`,
          action: `payment.${evt.status}`,
          target: locked.id,
          details: {
            app: locked.app,
            event_uid: evt.event_uid,
            ...(evt.fee_amount ? { fee_amount: evt.fee_amount } : {}),
            via: 'payments',
          },
        },
      );
      return {
        applied: true as const,
        status: evt.status,
        id: locked.id,
        app: locked.app,
      };
      });
    } catch (err) {
      // D-3 (re-revue delta) : le SQL brut ($executeRaw) ne remonte
      // JAMAIS en P2002 mais en P2010 « Raw query failed », code pg
      // dans le message. Seul le conflit d'unicité event_uid sur
      // transactions est doublon PSP → 409 ; les autres erreurs
      // remontent tel quel.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2010' &&
        err.message.includes('23505') &&
        err.message.includes('transactions_event_uid_key')
      ) {
        throw new HttpException('event_uid déjà consommé (doublon PSP)', 409);
      }
      throw err;
    }

    if (out.applied) {
      this.worker.signalAuditDrainPublic();
      const row = await store.getTxnById(this.prisma, out.id);
      if (row) {
        // Livraison sortante (paid/failed/expired) — les refunds sont
        // gérés côté Core, jamais par webhook PSP entrant.
        await this.worker.enqueueOutbound(
          row.id,
          row.status,
          row.event_uid ?? `webhook-unset:${row.id}`,
        );
      }
      return { status: out.status, applied: true, deduped: false };
    }
    return { status: out.status, applied: false, deduped: true };
  }

  /**
   * GET /payments/:id/dev-checkout — page « PSP fictive » de
   * l'adapter dev (redirect_url de createCheckout). DEV exclusif :
   * 404 si ALV_ALLOW_E2E≠1 (garde e2eGate) ou provider ≠ dev — en
   * production cette route est inexistante. Elle n'écrit AUCUN état ;
   * elle lit la transaction pour AFFICHER son statut (la source de
   * vérité reste le serveur, plan §2.2) et n'expose ni secret ni donnée
   * personnelle au-delà du champ de démonstration.
   */
  @Get('payments/:id/dev-checkout')
  async devCheckout(@Param('id') id: string) {
    e2eGate();
    const row = await store.getTxnById(this.prisma, id);
    if (!row) throw new NotFoundException('transaction inconnue');
    return [
      '<!doctype html><html lang="fr"><head><meta charset="utf-8">',
      `<title>Checkout simulé — ${row.app}</title></head><body>`,
      `<h1>Checkout simulé (dev) — ${row.app_ref}</h1>`,
      `<p>Transaction serveur : <code>${row.id}</code> — état : <code>${row.status}</code></p>`,
      '<p>Page sans saisie : aucune donnée ni écriture depuis le client.',
      ' La confirmation passe par le signal PSP simulé (dev-confirm, e2e).</p>',
      `</body></html>`,
    ].join('\n');
  }

  /**
   * POST /payments/:id/dev-confirm — simulateur PSP fictif e2e-only :
   * confirme le paiement côté PSP simulée, puis flux complet (machine
   * à états → trace audit DANS la transaction → webhook sortant signé).
   * AUTHORS' RESTRICTION : e2eGate (ALV_ALLOW_E2E=1 + provider dev).
   */
  @Post('payments/:id/dev-confirm')
  @UseGuards(AuthGuard)
  async devConfirm(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.devResolveRequest(req, id, 'confirm');
  }

  /** POST /payments/:id/dev-fail — même garde, résolution « échec ». */
  @Post('payments/:id/dev-fail')
  @UseGuards(AuthGuard)
  async devFail(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.devResolveRequest(req, id, 'fail');
  }

  /** Implémentation commune dev-confirm/dev-fail. */
  private async devResolveRequest(
    _req: AuthRequest,
    id: string,
    action: 'confirm' | 'fail',
  ): Promise<{ payment: PaymentView | null; applied: boolean }> {
    e2eGate();
    const row = await store.getTxnById(this.prisma, id);
    if (!row) throw new NotFoundException('transaction inconnue');
    const applied = await this.worker.devResolve(row, action);
    const fin = await store.getTxnById(this.prisma, id);
    return { payment: fin ? viewFromRow(fin) : null, applied };
  }

  /** GET /admin/payments — lecture admin filtrée (miroir FR-03.3). */
  @Get('admin/payments')
  @UseGuards(AdminGuard)
  async listAdmin(@Req() req: AuthRequest) {
    const raw = (req.query as Record<string, unknown>) ?? {};
    const app = typeof raw.app === 'string' && raw.app !== '' ? raw.app : undefined;
    const statusRaw = typeof raw.status === 'string' && raw.status !== '' ? raw.status : undefined;
    let status: PaymentStatus | undefined;
    if (statusRaw !== undefined) {
      if (!(PAYMENT_STATUS as readonly string[]).includes(statusRaw)) {
        throw new HttpException('status inconnu (PAYMENT_STATUS)', 400);
      }
      status = statusRaw as PaymentStatus;
    }
    const limitParsed = typeof raw.limit === 'string' ? Number(raw.limit) : undefined;
    const limit =
      limitParsed === undefined || !Number.isInteger(limitParsed) || limitParsed < 1
        ? 50
        : Math.min(limitParsed, 200);
    const rows = await store.listAdmin(this.prisma, { app, status, limit });
    return { items: rows.map(viewFromRow), nextCursor: null };
  }
}

// ---------------------------------------------------------------------

@Module({
  controllers: [HealthController, PaymentsController],
  providers: [PrismaService, PaymentsWorkerService],
})
class AppModule {}

async function bootstrap() {
  console.log(
    `payments : PAYMENTS_PROVIDER=${process.env.PAYMENTS_PROVIDER ?? 'dev'} (fabrique stricte au boot), TTL ${ttlSeconds()}s`,
  );
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Webhook signés : le HMAC est calculé sur le corps BRUT exact —
    // rawBody conservé à côté du JSON parsé (jamais re-serialisé).
    rawBody: true,
  });
  app.enableShutdownHooks();
  const port = Number.parseInt(process.env.PAYMENTS_PORT ?? '4040', 10);
  await app.listen(port, 'localhost');
  console.log(`alveare-payments up : http://localhost:${port}/healthz`);
}
void bootstrap();
