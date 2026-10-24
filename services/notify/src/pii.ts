/**
 * @alveare/notify — minimisation des destinataires (zone Red).
 * L'adresse (email ou téléphone E.164) n'est JAMAIS stockée ni
 * loguée en clair :
 *  - recipientHash : HMAC-SHA256(NOTIFY_DATA_KEY, adresse normalisée),
 *    tronqué à 16 octets (32 hex) — indexation sans identifiante.
 *  - recipientCipher : JWE dir A256GCM (même agrément de famille que
 *    la session web-admin) — seule clé capable de reconstituer
 *    l'adresse pour l'envoi réel.
 * Normalisation en V1 volontairement minimale (trim + lowercase) :
 * pas d'heuristique de fusion d'alias (gmail dots, +tags) — deux
 * adresses distinctes écrites distinctement restent distinctes.
 */

import { EncryptJWT, jwtDecrypt } from 'jose';
import { createHmac } from 'node:crypto';

function dataKey(): Uint8Array {
  const hex = process.env.NOTIFY_DATA_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('NOTIFY_DATA_KEY invalide (attendu : hex 64)');
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Normalisation avant hash/chiffrement (deterministe, sans surprise). */
export function normalizeRecipient(raw: string): string {
  const norm = raw.trim().toLowerCase();
  if (norm.length === 0) throw new Error('destinataire vide');
  return norm;
}

/** Hash d'indexation (hex 32) — irréversible par construction. */
export function hashRecipient(raw: string): string {
  return createHmac('sha256', dataKey())
    .update(normalizeRecipient(raw))
    .digest('hex')
    .slice(0, 32);
}

/** Chiffre l'adresse en JWE (dir + A256GCM). */
export async function sealRecipient(raw: string): Promise<string> {
  return new EncryptJWT({ to: normalizeRecipient(raw) })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .encrypt(dataKey());
}

/** Déchiffre ; null si falsifié/clé changée (jamais d'exception). */
export async function openRecipient(cipher: string): Promise<string | null> {
  try {
    const { payload } = await jwtDecrypt(cipher, dataKey());
    return typeof payload.to === 'string' ? payload.to : null;
  } catch {
    return null;
  }
}
