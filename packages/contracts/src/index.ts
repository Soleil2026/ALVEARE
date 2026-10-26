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

/**
 * Paiements (E6, plan §2.6) — Zone Red (argent) : revue indépendante
 * obligatoire. Conventions du fichier : datetime ISO 8601 UTC, montants
 * en centimes BIGINT transportés en chaîne de chiffres (représentation
 * exacte, jamais via un number JS) ; pattern d'app miroir de
 * services/identity/src/grants.ts (§2.4) — posé ici car consommé par
 * plusieurs services.
 */
export const APP_ID_PATTERN = /^(core-admin|app-(0[1-9]|1[0-2]))$/;

/**
 * Montant en centimes : chaîne de chiffres NON signée (ou entier JS
 * accepté en entrée, normalisé en chaîne) — représentation exacte du
 * BIGINT côté BD.
 */
export const MoneyAmountSchema = z.union([
  z.string().regex(/^\d+$/, 'montant : chiffres attendus'),
  z.number().int().nonnegative(),
]).transform((v) => String(v));

/**
 * Création de paiement (POST /payments) — Q1/Q8 : rail + currency +
 * justificatif de change dès V1 ; amount centimes >= 100 (B cahier des
 * charges : min 100 DA).
 */
export const PaymentCreateSchema = z
  .strictObject({
    app: z.string().regex(APP_ID_PATTERN, 'app invalide (core-admin | app-01..app-12)'),
    app_ref: z.string().min(1).max(120),
    /** centimes >= 100 (min cahier des charges / rail SATIM). */
    amount: MoneyAmountSchema.refine((v) => Number(v) >= 100, {
      message: 'amount : centimes >= 100 attendus',
    }).refine((v) => /^\d{1,15}$/.test(v), {
      // D-9 (revue T4.7) : précision 2^53 — au-delà de 15 chiffres, un
      // Number() côté adapter perdrait la précision avant l'appel PSP.
      message: 'amount : au-delà de la précision PSP (15 chiffres max)',
    }),
    currency: z.string().regex(/^[A-Z]{3}$/).default('DZD'),
    /** Q8 : rail de transparence réglementaire — dzd (national) | fx. */
    rail: z.enum(['dzd', 'fx']).default('dzd'),
    /** Q8 : référence du justificatif de change, requise au fil V2. */
    just_ref: z.string().min(1).max(200).nullish(),
  })
  .refine(
    (v) => (
      v.rail === 'dzd'
        ? v.currency === 'DZD'
        : v.currency === 'DZD' ? v.just_ref !== undefined && v.just_ref !== null : true
    ),
    { path: ['currency'], message: 'rail dzd imposé DZD ; rail fx = justificatif requis' },
  );

export type PaymentCreateInput = z.input<typeof PaymentCreateSchema>;
export type PaymentCreate = z.infer<typeof PaymentCreateSchema>;

/**
 * États d'une transaction (plan §2.3) — constante VERSIONNÉE (B l.472
 * : nom stable) : toutes les transitions visibles s'appuient ici.
 */
export const PAYMENT_STATUS = [
  'created',
  'pending',
  'paid',
  'failed',
  'expired',
  'partially_refunded',
  'refunded',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

/** Fournisseurs de paiement (fabrique @alveare/payments — boot refusé
 * si valeur inconnue, pattern services/notify/src/sms.ts). */
export const PAYMENT_PROVIDERS = ['dev', 'chargily', 'satim'] as const;

export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

/** Vue de transaction (GET /payments/:id, réponses create/refund). */
export const PaymentViewSchema = z.strictObject({
  id: z.string().min(1),
  app: z.string().regex(APP_ID_PATTERN),
  app_ref: z.string().min(1).max(120),
  status: z.enum(PAYMENT_STATUS),
  /** centimes, chaîne de chiffres (BIGINT) */
  amount: z.string().regex(/^\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  rail: z.enum(['dzd', 'fx']),
  provider: z.enum(PAYMENT_PROVIDERS),
  provider_ref: z.string().min(1).nullish(),
  receipt_ref: z.string().min(1).nullish(),
  /** frais tracés (R5), centimes */
  fee_amount: z.string().regex(/^\d+$/).nullish(),
  /** déjà remboursé (cumul des refunds), centimes */
  refunded_amount: z.string().regex(/^\d+$/),
  created_at: z.iso.datetime(),
  paid_at: z.iso.datetime().nullish(),
  closed_at: z.iso.datetime().nullish(),
});

export type PaymentView = z.infer<typeof PaymentViewSchema>;

/**
 * Demande de remboursement (POST /payments/:id/refund) — Q9 : partiel
 * ou total idempotent (refund_ref = clé métier de l'app) ; amount
 * facultatif = solde restant par défaut ; reason = piste métier.
 */
export const RefundRequestSchema = z.strictObject({
  refund_ref: z.string().min(1).max(120),
  amount: MoneyAmountSchema
    .transform((v) => String(v))
    .refine((v) => Number(v) >= 1, { message: 'amount : centimes >= 1 attendus' })
    .refine((v) => /^\d{1,15}$/.test(v), {
      // D-9 (revue T4.7) : même garde de précision que la création.
      message: 'amount : au-delà de la précision PSP (15 chiffres max)',
    })
    .optional(),
  reason: z.string().min(1).max(500).nullish(),
});

export type RefundRequestInput = z.input<typeof RefundRequestSchema>;
export type RefundRequest = z.infer<typeof RefundRequestSchema>;

/**
 * Webhook ENTRANT depuis la PSP (POST /payments/webhook) — le corps
 * brut doit correspondre au HMAC du secret PSP (chargily) ; event_uid
 * en clé d'idempotence (transactions.event_uid UNIQUE).
 * SATIM (V2) n'envoie AUCUN webhook (R2) : schéma prêt pour un futur
 * proxy, mais le rail satim reste hors du V1.
 */
export const PaymentWebhookEventSchema = z.strictObject({
  event_uid: z.string().min(1).max(160),
  provider: z.enum(PAYMENT_PROVIDERS),
  provider_ref: z.string().min(1).max(160),
  status: z.enum(['pending', 'paid', 'failed', 'expired']),
  paid_at: z.iso.datetime().nullish(),
  fee_amount: MoneyAmountSchema.nullish(),
});

export type PaymentWebhookEvent = z.infer<typeof PaymentWebhookEventSchema>;

/**
 * Webhook SORTANT (ALVEARE -> app propriétaire) — Q4 : POST signé
 * `X-ALVEARE-Signature: t=<ts>, v1=<hmac>` (paquet @alveare/payments) ;
 * livraison BullMQ (retries) : event_uid sert d'id dédoublonnable
 * côté app (une livraison rejouée ne doit rien déclencher deux fois).
 */
export const PaymentWebhookPayloadSchema = z.strictObject({
  event_uid: z.string().min(1).max(80),
  event: z.enum(['payment.paid', 'payment.failed', 'payment.expired', 'payment.refunded']),
  payment_id: z.string().min(1),
  app: z.string().regex(APP_ID_PATTERN),
  app_ref: z.string().min(1).max(120),
  status: z.enum(['paid', 'failed', 'expired', 'refunded']),
  amount: z.string().regex(/^\d+$/),
  refunded_amount: z.string().regex(/^\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  ts: z.iso.datetime(),
}).superRefine((v, ctx) => {
  if (v.event !== `payment.${v.status}`) {
    ctx.addIssue({
      code: 'custom',
      path: ['event'],
      message: `event doit valoir payment.${v.status}`,
    });
  }
});

export type PaymentWebhookPayload = z.infer<typeof PaymentWebhookPayloadSchema>;
