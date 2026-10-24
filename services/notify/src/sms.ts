/**
 * @alveare/notify — adaptateur SMS (FR-05.1, §7 PRD : interface
 * configurable ; opérateur local). V1 : SMS_PROVIDER=dev uniquement.
 * Le vrai branchera l'interface opérateur local sans changer
 * l'interface de ce module.
 * Zone Red : aucune erreur brute du transport n'est renvoyée.
 */

import { appendOutbox } from './outbox';
import type { MailResult } from './email';

export interface SmsProvider {
  send(to: string, text: string): Promise<MailResult>;
}

const GENERIC = 'envoi impossible';

export function makeSmsProvider(): SmsProvider {
  const provider = process.env.SMS_PROVIDER ?? 'dev';
  if (provider === 'dev') {
    return {
      async send(to, text) {
        appendOutbox({
          ts: new Date().toISOString(),
          channel: 'sms',
          to,
          text,
        });
        return { ok: true };
      },
    };
  }
  throw new Error(`SMS_PROVIDER inconnu en V1 (${provider}) — démarrage refusé`);
}
