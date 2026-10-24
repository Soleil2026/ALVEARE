/**
 * @alveare/notify — adaptateur EMAIL (FR-05.1).
 * SMTP_URL fournie → transport SMTP réel (nodemailer).
 * Sinon → adaptateur dev : append JSONL dans l'outbox de dev.
 * Zone Red : aucune erreur brute du transport n'est renvoyée
 * (un message SMTP peut refléter l'adresse) — 'envoi impossible'.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { appendOutbox } from './outbox';

export type MailResult = { ok: boolean; error?: string };

export interface EmailAdapter {
  send(to: string, subject: string, text: string, html: string): Promise<MailResult>;
}

const GENERIC = 'envoi impossible';

export function makeEmailAdapter(): EmailAdapter {
  const url = process.env.SMTP_URL;
  if (url) {
    let transport: Transporter;
    try {
      transport = nodemailer.createTransport(url);
    } catch {
      throw new Error('SMTP_URL invalide — démarrage refusé');
    }
    return {
      async send(to, subject, text, html) {
        try {
          await transport.sendMail({
            from: process.env.SMTP_FROM ?? 'notify@alveare.local',
            to,
            subject,
            text,
            html,
          });
          return { ok: true };
        } catch {
          return { ok: false, error: GENERIC };
        }
      },
    };
  }

  // Fallback dev — trace JSONL (adresse incluse), jamais en prod (SMTP_URL requis hors dev).
  return {
    async send(to, subject, text, html) {
      appendOutbox({
        ts: new Date().toISOString(),
        channel: 'email',
        to,
        subject,
        text,
        html,
      });
      return { ok: true };
    },
  };
}
