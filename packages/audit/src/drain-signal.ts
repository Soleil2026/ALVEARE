/**
 * @alveare/audit — signal de drain (E3 T3.4, plan §2.b). Zone Red :
 * revue indépendante obligatoire (AGENTS.md / revue-criticite).
 *
 * Rôle : après COMMIT d'une transaction métier qui a inséré dans
 * audit.outbox, enfiler un job « signal » sur la queue BullMQ
 * `audit-drain` du service audit :4030 pour minimiser la latence.
 *
 * Sémantique FIRE-AND-FORGET stricte (plan E3 §2) :
 *   * le signal est une OPTIMISATION de latence, jamais une garantie :
 *     le balayage périodique (sweep 30 s, idempotent) du worker rattrape
 *     tout signal perdu — une erreur d'enfilage est donc avalée ici (la
 *     fonction ne lève JAMAIS) mais n'est JAMAIS muette non plus
 *     (console.warn avec la raison, revue T3.8 R-1) ;
 *   * s'appelle APRÈS le commit (jamais à l'intérieur d'une transaction) ;
 *   * les jobs signal sont coalescés : un seul signal en attente suffit
 *     (jobId fixe + removeOnComplete — la queue joue le rôle de
 *     « drapeau → au moins un drain à venir »).
 *
 * La queue est PARTAGÉE au niveau module (revue T3.8 R-1) : créée
 * paresseusement à la première utilisation puis réutilisée — un
 * signal n'ouvre plus une connexion Redis éphémère à chaque appel.
 */

import { Queue, type ConnectionOptions } from 'bullmq';

/** Nom de la queue consommée par le worker du service audit :4030. */
export const AUDIT_DRAIN_QUEUE = 'audit-drain';

export interface SignalDrainOptions {
  /** Nom de queue, par défaut `audit-drain` (contrat du service audit). */
  queueName?: string;
  /** Étiquette d'audit du créateur (diagnostic BullMQ uniquement). */
  source?: string;
}

/**
 * Queues partagées, par nom (un émetteur utilise toujours le même nom
 * → une seule queue par processus). La première création fixe les
 * options de connexion — les appels suivants avec le même nom la
 * réutilisent. JAMAIS refermée : c'est la ressource du processus.
 */
const sharedQueues = new Map<string, Queue>();

function getSharedQueue(queueName: string, connection: ConnectionOptions): Queue {
  let queue = sharedQueues.get(queueName);
  if (!queue) {
    queue = new Queue(queueName, { connection });
    sharedQueues.set(queueName, queue);
  }
  return queue;
}

/**
 * Enfile un job signal, coalescé (`jobId: 'signal'`, removeOnComplete).
 *
 * @param queueConnection options de connexion Redis (REDIS_URL du
 *        compose existant — aucun conteneur nouveau, plan E3 §4).
 * @returns true si un job a été enfilé (ou un job identique est déjà en
 *          attente), false si l'enfilage a échoué (rattrapage par le
 *          sweep 30 s — jamais d'exception, mais un console.warn avec
 *          la raison en cas d'échec).
 */
export async function signalDrain(
  queueConnection: ConnectionOptions,
  opts: SignalDrainOptions = {},
): Promise<boolean> {
  try {
    const queue = getSharedQueue(
      opts.queueName ?? AUDIT_DRAIN_QUEUE,
      queueConnection,
    );
    await queue.add(
      'signal',
      { source: opts.source ?? 'emitter' },
      {
        // Coalescence : un signal en attente suffit pour déclencher le
        // drain ; removeOnComplete libère l'id au prochain passage.
        jobId: 'signal',
        removeOnComplete: { age: 300, count: 50 },
        removeOnFail: { age: 3600 },
      },
    );
    return true;
  } catch (err) {
    // Perte SANS conséquence (garantie outbox transactionnelle : le
    // sweep 30 s rattrape tout signal), mais JAMAIS muet : la raison
    // est tracée (revue T3.8 R-1) en avertissement.
    console.warn(
      `signalDrain : enfilage raté (rattrapage par le sweep 30s) : ${String(err)}`,
    );
    return false;
  }
}
