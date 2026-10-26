/**
 * @alveare/payments — signature HMAC des webhooks SORTANTS (E6, Q4).
 * Zone Red : revue indépendante obligatoire.
 *
 * Format livré aux apps : `X-ALVEARE-Signature: t=<unix seconds>, v1=<hex>`
 * où v1 = HMAC-SHA256(secret, `${t}.${body}`) — secret PAR APP issu de
 * payments.app_endpoints.secret (jamais dans le code source, jamais
 * loggé, jamais committé).
 *
 * Vérification : comparaison à temps constant + garde anti-replay sur
 * l'écart d'horloge (PAYMENTS_WEBHOOK_MAX_SKEW, défaut 300 s).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Parse PAYMENTS_WEBHOOK_MAX_SKEW : entier > 0 requis, sinon défaut 300. */
export function webHookMaxSkewSeconds(): number {
  const raw = process.env.PAYMENTS_WEBHOOK_MAX_SKEW;
  const parsed =
    raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 300;
}

export function signOutbound(
  secret: string,
  body: string,
  tsSeconds: number,
): string {
  if (!Number.isInteger(tsSeconds) || tsSeconds < 0) {
    throw new Error('signOutbound : ts attendu en secondes entières >= 0');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(
      'signOutbound : secret webhook manquant (payments.app_endpoints.secret)',
    );
  }
  const v1 = createHmac('sha256', secret).update(`${tsSeconds}.${body}`).digest('hex');
  return `t=${tsSeconds}, v1=${v1}`;
}

/** Comparaison hex avec temps constant (anti fuite par timing). */
export function constantTimeHexEqual(
  a: string,
  b: string,
): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) {
    return false;
  }
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || bb.length === 0 || ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export interface VerifyOutboundOptions {
  now?: number; // séparée pour les tests (secondes), sinon Date.now()/1000
  skew?: number; // remplace webHookMaxSkewSeconds() pour les tests
}

/**
 * Vérifie un en-tête X-ALVEARE-Signature sur le corps brut exact.
 * Renvoie FALSE (jamais d'exception) sur : entête mal formé, HMAC
 * différent, replay au-delà du skwen, secret vide.
 */
export function verifyOutbound(
  secret: string,
  body: string,
  header: string | undefined,
  opts: VerifyOutboundOptions = {},
): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const parts = header.split(',').map((p) => p.trim());
  let tsStr: string | undefined;
  let v1: string | undefined;
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    const val = rest.join('=');
    if (k === 't') tsStr = val;
    if (k === 'v1') v1 = val;
  }
  if (!tsStr || !v1 || !/^\d+$/.test(tsStr) || !/^[0-9a-f]{64}$/i.test(v1)) {
    return false;
  }
  const ts = Number(tsStr);
  const now = Number.isInteger(opts.now) ? (opts.now as number) : Math.floor(Date.now() / 1000);
  const skew = Number.isInteger(opts.skew) ? (opts.skew as number) : webHookMaxSkewSeconds();
  if (Math.abs(now - ts) > skew) return false; // replay
  const expected = createHmac('sha256', secret)
    .update(`${tsStr}.${body}`)
    .digest('hex');
  return constantTimeHexEqual(expected, v1);
}
