/**
 * web-admin — helpers purs de lecture admin paiements (coupe
 * ADMIN-UI, lecture seule). Aucune action sur l'argent ici : les
 * fonctions formatent les montants, sécurisent les query params et
 * mappent les erreurs. Le guard AdminGuard reste AU SERVICE
 * (:4040) — jamais recopié ni simulé côté front.
 * Zone Green (affichage uniquement) : revue standard.
 */

import { PAYMENT_STATUS } from '@alveare/contracts';

export type AdminPayment = {
  id: string;
  app: string;
  app_ref: string;
  status: (typeof PAYMENT_STATUS)[number];
  amount: string;
  currency: string;
  rail: string;
  provider: string;
  refunded_amount: string;
  fee_amount: string;
  created_at: string;
  paid_at: string | null;
};

export type PaymentsQuery = { items: AdminPayment[] };

/** Format d'affichage d'un montant en unités mineures (string de
 * digits uniquement). Aucune conversion flottante — la garde du
 * montant reste celle du service (15 chiffres, D-9). */
export function fmtMinor(s: string): string {
  if (!/^\d{1,15}$/.test(s)) return '—';
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Libellé + teinte par statut — la liste DOIT couvrir PAYMENT_STATUS
 * (test de couverture sur le contrat). */
export const STATUT_META: Record<
  (typeof PAYMENT_STATUS)[number],
  { label: string; color: string }
> = {
  created: { label: 'créé', color: '#8fa3ff' },
  pending: { label: 'en attente', color: '#e3b341' },
  paid: { label: 'payé', color: '#7ee787' },
  failed: { label: 'échoué', color: '#ff7b7b' },
  expired: { label: 'expiré', color: '#d2a8ff' },
  partially_refunded: { label: 'remb. partiel', color: '#ffa657' },
  refunded: { label: 'remboursé', color: '#79c0ff' },
};

/** Whitelist STRICTE des searchParams avant re-copie vers l'URL
 * upstream : jamais d'injection de query dans l'appel serveur. Un
 * paramètre présent mais invalide figure dans `invalid` — la page
 * refuse alors d'appeler l'upstream au lieu de filtrer
 * silencieusement (pas de contradiction visible). */
export function sanitizeParams(
  sp: Record<string, string | string[] | undefined>,
): {
  app?: string;
  status?: string;
  limit?: string;
  invalid?: string[];
} {
  const one = (v: string | string[] | undefined): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined;
  const rawApp = one(sp.app);
  const rawStatus = one(sp.status);
  const rawLimit = one(sp.limit);
  const invalid: string[] = [];
  let app: string | undefined;
  if (rawApp !== undefined) {
    if (/^[A-Za-z0-9-]{1,32}$/.test(rawApp)) app = rawApp;
    else invalid.push('app');
  }
  let status: string | undefined;
  if (rawStatus !== undefined) {
    if ((PAYMENT_STATUS as readonly string[]).includes(rawStatus)) status = rawStatus;
    else invalid.push('status');
  }
  let limit: string | undefined;
  if (rawLimit !== undefined) {
    if (/^\d{1,3}$/.test(rawLimit) && Number(rawLimit) >= 1 && Number(rawLimit) <= 200) {
      limit = rawLimit;
    } else invalid.push('limit');
  }
  return {
    app,
    status,
    limit,
    invalid: invalid.length > 0 ? invalid : undefined,
  };
}

/** Libellé générique par statut upstream — jamais la réponse
 * verbatim (miroir du proxy documents F-6). */
export function mapUpstreamError(status: number): string {
  switch (status) {
    case 401:
      return 'session expirée, reconnectez-vous';
    case 403:
      return 'accès refusé (réservé aux admins Core)';
    case 400:
      return 'requête invalide (filtre inconnu)';
    default:
      return 'service paiements : opération refusée';
  }
}
