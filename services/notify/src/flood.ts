/**
 * @alveare/notify — anti-flood (zone Red périmètre anti-abus).
 * Cap : MAX_PER_WINDOW messages par destinataire (hash) et par minute.
 * En mémoire : V1 est mono-instance ; le passage multi-instance
 * branchera Redis (déjà up côté infra) avec la même interface.
 */

export const WINDOW_MS = 60_000;
export const MAX_PER_WINDOW = 5;
/** Revue N5-3 : plafond parallèle PAR ÉMETTEUR (user authentifié) —
 * limite la capacité de n'importe quel compte authentifié à inonder. */
export const MAX_EMITTER_PER_WINDOW = 20;

const hits = new Map<string, number[]>();

export type FloodVerdict = { ok: boolean; remaining: number };

/** À appeler UNIQUEMENT sur une demande acceptée (après validation) :
 * l'horodatage fait partie de la décision. `key` est opaque : hash du
 * destinataire OU préfixe émetteur (`usr:<sub>`). */
export function floodScore(key: string, now = Date.now(), max = MAX_PER_WINDOW): FloodVerdict {
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  // Purge des entrées devenues vides (revue N5-9 : pas de fuite mémoire).
  if (list.length === 0) {
    hits.delete(key);
  } else {
    hits.set(key, list);
  }
  if (list.length >= max) {
    return { ok: false, remaining: 0 };
  }
  list.push(now);
  hits.set(key, list);
  return { ok: true, remaining: max - list.length };
}

/** Harnais de test : purge de l'état. */
export function resetFlood(): void {
  hits.clear();
}
