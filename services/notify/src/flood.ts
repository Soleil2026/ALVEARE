/**
 * @alveare/notify — anti-flood (zone Red périmètre anti-abus).
 * Cap : MAX_PER_WINDOW messages par destinataire (hash) et par minute.
 * En mémoire : V1 est mono-instance ; le passage multi-instance
 * branchera Redis (déjà up côté infra) avec la même interface.
 */

export const WINDOW_MS = 60_000;
export const MAX_PER_WINDOW = 5;

const hits = new Map<string, number[]>();

export type FloodVerdict = { ok: boolean; remaining: number };

/** À appeler UNIQUEMENT sur une demande acceptée (après validation) :
 * l'horodatage fait partie de la décision. */
export function floodScore(recipientHash: string, now = Date.now()): FloodVerdict {
  const list = (hits.get(recipientHash) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) {
    hits.set(recipientHash, list);
    return { ok: false, remaining: 0 };
  }
  list.push(now);
  hits.set(recipientHash, list);
  return { ok: true, remaining: MAX_PER_WINDOW - list.length };
}

/** Harnais de test : purge de l'état. */
export function resetFlood(): void {
  hits.clear();
}
