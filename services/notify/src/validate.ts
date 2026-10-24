/**
 * @alveare/notify — validation d'entrée POST /send (zone Red).
 * Fonction PUR (hors Nest) → testable directement ; le contrôleur
 * mappe les statuts. Tout message d'erreur est générique (sans PII).
 */

export const CHANNELS = ['email', 'sms'] as const;
export const TEMPLATES = ['verify-email', 'password-reset', 'document-shared', 'test'] as const;
export const LANGS = ['fr', 'ar', 'en'] as const;

export type Channel = (typeof CHANNELS)[number];
export type Template = (typeof TEMPLATES)[number];
export type Lang = (typeof LANGS)[number];

export type SendInput = {
  channel: Channel;
  template: Template;
  lang: Lang;
  /** email ou téléphone E.164, selon channel */
  to: string;
  /** variables de substitution (scalaires uniquement) */
  params?: Record<string, string>;
  /** app émettrice — tracée à l'audit (B §2.4) */
  via: string;
  /** idempotence : un envoi par clé (contrainte unique BD) */
  dedupKey?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;

type Result = { ok: true; input: SendInput } | { ok: false; status: 400; error: string };

export function parseSendInput(body: unknown): Result {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, error: 'corps JSON attendu' };
  }
  const b = body as Record<string, unknown>;

  const channel = b.channel;
  if (typeof channel !== 'string' || !CHANNELS.includes(channel as Channel)) {
    return { ok: false, status: 400, error: 'channel invalide (email|sms)' };
  }

  const template = b.template;
  if (typeof template !== 'string' || !TEMPLATES.includes(template as Template)) {
    return { ok: false, status: 400, error: 'template inconnu' };
  }

  const lang = b.lang;
  if (typeof lang !== 'string' || !LANGS.includes(lang as Lang)) {
    return { ok: false, status: 400, error: 'lang invalide (fr|ar|en)' };
  }

  const to = b.to;
  if (typeof to !== 'string' || to.length === 0 || to.length > 320) {
    return { ok: false, status: 400, error: 'destinataire manquant ou trop long' };
  }
  if (channel === 'email' && !EMAIL_RE.test(to)) {
    return { ok: false, status: 400, error: 'email invalide' };
  }
  if (channel === 'sms' && !E164_RE.test(to)) {
    return { ok: false, status: 400, error: 'téléphone invalide (E.164 attendu, ex. +33…)' };
  }

  const via = b.via;
  if (typeof via !== 'string' || via.length < 1 || via.length > 60) {
    return { ok: false, status: 400, error: 'via manquant (app émettrice)' };
  }

  let params: Record<string, string> | undefined;
  if (b.params !== undefined) {
    if (typeof b.params !== 'object' || b.params === null) {
      return { ok: false, status: 400, error: 'params invalide' };
    }
    params = {};
    const src = b.params as Record<string, unknown>;
    let count = 0;
    for (const [k, v] of Object.entries(src)) {
      if (++count > 10) {
        return { ok: false, status: 400, error: 'trop de params (max 10)' };
      }
      if (k.length > 30) {
        return { ok: false, status: 400, error: 'clé params trop longue' };
      }
      if (typeof v !== 'string' || v.length > 200) {
        return { ok: false, status: 400, error: 'params : valeurs chaîne ≤ 200 car' };
      }
      params[k] = v;
    }
  }

  let dedupKey: string | undefined;
  if (b.dedupKey !== undefined) {
    if (typeof b.dedupKey !== 'string' || b.dedupKey.length < 1 || b.dedupKey.length > 120) {
      return { ok: false, status: 400, error: 'dedupKey invalide (1-120 car)' };
    }
    dedupKey = b.dedupKey;
  }

  return {
    ok: true,
    input: {
      channel: channel as Channel,
      template: template as Template,
      lang: lang as Lang,
      to,
      params,
      via,
      dedupKey,
    },
  };
}
