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
 *     tout signal perdu — une error d'enfilage est donc avalée ici (la
 *     fonction ne lève JAMAIS), et l'appelant ne doit pas cadencer son
 *     commit sur son succès ;
 *   * s'appelle APRÈS le commit (jamais à l'intérieur d'une transaction) ;
 *   * les jobs signal sont coalescés : un seul signal en attente suffit
 *     (jobId fixe + removeOnComplete — la queue joue le rôle de
 *     « drapeau → au moins un drain à venir »).
 *
 * Les émetteurs métier (identity / documents / notify) brancheront ce
 * helper dans un commit SUIVANT (consigne T3.4) — aucun émetteur n'est
 * modifié ici.
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
 * Enfile un job signal, coalescé (`jobId: 'signal'`, removeOnComplete).
 *
 * @param queueConnection options de connexion Redis (REDIS_URL du
 *        compose existant — aucun conteneur nouveau, plan E3 §4).
 * @returns true si un job a été enfilé (ou un job identique est déjà en
 *          attente), false si l'enfilage a échoué (rattrapage par le
 *          sweep 30 s — jamais d'exception).
 */
export async function signalDrain(
  queueConnection: ConnectionOptions,
  opts: SignalDrainOptions = {},
): Promise<boolean> {
  let queue: Queue | undefined;
  try {
    queue = new Queue(opts.queueName ?? AUDIT_DRAIN_QUEUE, {
      connection: queueConnection,
    });
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
  } catch {
    // Le sweep périodique (30 s) rattrape : perte assumée par design.
    return false;
  } finally {
    // Queue éphémère : on referme la connexion dédiée à ce signal.
    await queue?.close();
  }
}
