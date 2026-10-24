/**
 * web-admin — store serveur des flux PKCE (remédiation revue F-7).
 * Les secrets du flow (verifier, nonce, association state↔nonce)
 * ne transitent plus par cookie : ils sont mémorisés côté serveur,
 * indexés par `state` (paramètre d'URL du callback).
 * « Single-use » : l'entrée est détruite AVANT validation — pas de
 * rejeu possible, même dans la fenêtre du TTL.
 * Doc B §4.3/§4.6 : aucune donnée sensible de sécurité côté client.
 * Mono-instance V1 ; Redis/Postgres dès multi-pods (roadmap revue).
 * Capacité bornée : /login est public — pas de DoS mémoire.
 */

const TTL_MS = 5 * 60 * 1000;
const MAX_FLOWS = 10_000;

export type Flow = { verifier: string; nonce: string; exp: number };

/** globalThis : le store survit au rechargement de modules (HMR dev). */
const g = globalThis as { __alvflowstore?: Map<string, Flow> };
const flows: Map<string, Flow> = g.__alvflowstore ?? (g.__alvflowstore = new Map());

/** Enregistre un flow ; FIFO simple au-delà de la capacité. */
export function putFlow(state: string, verifier: string, nonce: string): void {
  if (flows.size >= MAX_FLOWS) {
    const oldest = flows.keys().next().value;
    if (oldest !== undefined) flows.delete(oldest);
  }
  flows.set(state, { verifier, nonce, exp: Date.now() + TTL_MS });
}

/**
 * Lit ET consomme (single-use) : delete avant tout usage.
 * flux inconnu / expiré / déjà consommé → undefined.
 */
export function takeFlow(state: string): Flow | undefined {
  const flow = flows.get(state);
  flows.delete(state);
  if (!flow || flow.exp < Date.now()) return undefined;
  return flow;
}
