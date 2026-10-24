/**
 * @alveare/notify — outbox de dev (fallback sans SMTP / adaptateur
 * SMS dev). Développeur uniquement : le fichier cible porte les
 * adresses en clair VOLONTAIREMENT (c'est la preuve d'envoi locale) ;
 * il vit sous /tmp, ignoré par git, jamais utilisé en prod.
 */

import { appendFileSync } from 'node:fs';

export function outboxFile(): string {
  return process.env.NOTIFY_DEV_OUTBOX ?? '/tmp/alv-notify-outbox.jsonl';
}

export function appendOutbox(row: Record<string, unknown>): string {
  const file = outboxFile();
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return file;
}
