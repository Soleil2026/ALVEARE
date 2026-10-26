/**
 * web-admin — page /paiements : lecture admin (lecture SEULE) des
 * transactions via le service paiements :4040 (GET /admin/payments,
 * garde AdminGuard au service). Le token ne quitte jamais le serveur
 * : fetch server-side avec la session JWE, miroir page /.
 * Coupe ADMIN-UI plan 348b045 — zone Green (aucun bouton d'action).
 */

import { cookies } from 'next/headers';
import { SESSION_COOKIE, decodeSession } from '../../lib/session';
import {
  STATUT_META,
  fmtMinor,
  mapUpstreamError,
  sanitizeParams,
  type AdminPayment,
  type PaymentsQuery,
} from '../../lib/payments-admin';

export const dynamic = 'force-dynamic';

const styles = {
  page: {
    minHeight: '100vh',
    background: '#0b1020',
    color: '#e7eaf3',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 18,
    padding: 24,
  },
  badge: {
    fontSize: 13,
    letterSpacing: 3,
    textTransform: 'uppercase' as const,
    color: '#8fa3ff',
    marginTop: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    margin: 0,
  },
  card: {
    background: '#121a33',
    border: '1px solid #232f5c',
    borderRadius: 14,
    padding: '18px 22px',
    width: 'min(980px, 100%)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  row: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    fontSize: 14,
    color: '#9aa5c0',
    flexWrap: 'wrap' as const,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 14,
  },
  th: {
    textAlign: 'left' as const,
    color: '#8fa3ff',
    borderBottom: '1px solid #232f5c',
    padding: '6px 8px',
    fontWeight: 600,
  },
  td: {
    borderBottom: '1px solid #1b2446',
    padding: '6px 8px',
    color: '#c9d1e6',
  },
  select: {
    background: '#0b1020',
    color: '#e7eaf3',
    border: '1px solid #2b3a8f',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 14,
  },
  input: {
    background: '#0b1020',
    color: '#e7eaf3',
    border: '1px solid #2b3a8f',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 14,
    width: 160,
  },
  button: {
    background: '#2b3a8f',
    color: 'white',
    border: 'none',
    borderRadius: 10,
    padding: '10px 18px',
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'none',
    fontSize: 15,
  },
  error: {
    color: '#ff7b7b',
    fontSize: 15,
  },
  legend: {
    fontSize: 12,
    color: '#6d7aa0',
  },
} as const;

// options dérivées du libellé STATUT (jamais une liste locale divergente)
const STATUS_OPTIONS = Object.keys(STATUT_META) as Array<
  keyof typeof STATUT_META
>;

async function fetchPayments(
  q: { app?: string; status?: string; limit?: string },
  at: string,
): Promise<
  | { kind: 'ok'; data: PaymentsQuery }
  | { kind: 'error'; message: string }
> {
  const base = process.env.PAYMENTS_URL ?? 'http://localhost:4040';
  const usp = new URLSearchParams();
  if (q.app) usp.set('app', q.app);
  if (q.status) usp.set('status', q.status);
  if (q.limit) usp.set('limit', q.limit);
  try {
    const res = await fetch(`${base}/admin/payments?${usp.toString()}`, {
      headers: { Authorization: `Bearer ${at}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { kind: 'error', message: mapUpstreamError(res.status) };
    const data = (await res.json()) as PaymentsQuery;
    if (!Array.isArray(data.items)) {
      return { kind: 'error', message: 'service paiements : réponse invalide' };
    }
    return { kind: 'ok', data };
  } catch {
    return { kind: 'error', message: 'service paiements injoignable' };
  }
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Whitelist app/status/limit ; tout param PRESENT mais invalide est
  // signalé via q.invalid — la page refuse d'appeler l'upstream
  // (jamais un rendu qui contredit la fenêtre de filtre demandée).
  const q = sanitizeParams(sp);
  const badNames = (q.invalid ?? []).join(', ');
  const store = await cookies();
  const session = await decodeSession(store.get(SESSION_COOKIE)?.value);

  return (
    <main style={styles.page}>
      <div style={styles.badge}>ALVEARE · SOCLE</div>
      <h1 style={styles.title}>Paiements (lecture seule)</h1>

      {!session && (
        <>
          <p style={styles.error}>Session absente ou expirée.</p>
          <a href="/login" style={styles.button}>
            Se connecter
          </a>
        </>
      )}

      {session && (
        <>
          <section style={styles.card}>
            <div style={styles.row}>
              {/* formulaire GET pur : filtres rendus serveur, zéro client
                  JS, aucune action d'écriture possible depuis l'écran */}
              <form action="/paiements" method="get" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  name="app"
                  placeholder="app (ex. app-01)"
                  defaultValue={q.app ?? ''}
                  style={styles.input}
                  maxLength={32}
                />
                <select name="status" defaultValue={q.status ?? ''} style={styles.select}>
                  <option value="">tous les statuts</option>
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {STATUT_META[s].label}
                    </option>
                  ))}
                </select>
                <input
                  name="limit"
                  placeholder="limit (max 200)"
                  defaultValue={q.limit ?? ''}
                  style={{ ...styles.input, width: 110 }}
                  maxLength={3}
                />
                <button type="submit" style={{ ...styles.button, padding: '7px 14px' }}>
                  Filtrer
                </button>
              </form>
            </div>

            {session && badNames.length > 0 ? (
              <p style={styles.error}>
                filtre invalide : {badNames} — corrigez ou videz le
                champ concerné.
              </p>
            ) : (
              <ListBlock q={q} at={session.at} />
            )}

            <p style={styles.legend}>
              Montants en unités mineures (centimes). Lecture seule :
              toute action (refund) reste réservée à l&apos;API admin —
              jamais depuis cet écran.
            </p>
          </section>

          <a href="/" style={{ color: '#8fa3ff', fontSize: 14 }}>
            ← retour au backoffice
          </a>
        </>
      )}
    </main>
  );
}

/** Bloc liste : UNE fetch par rendu, erreurs mappées génériques. */
async function ListBlock({
  q,
  at,
}: {
  q: { app?: string; status?: string; limit?: string };
  at: string;
}) {
  const r = await fetchPayments(q, at);
  if (r.kind === 'error') {
    return <p style={styles.error}>{r.message}</p>;
  }
  const items = r.data.items;
  if (items.length === 0) {
    return <p style={styles.row}>aucune transaction pour ces filtres</p>;
  }
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>réf</th>
          <th style={styles.th}>app</th>
          <th style={styles.th}>statut</th>
          <th style={styles.th}>montant</th>
          <th style={styles.th}>remb.</th>
          <th style={styles.th}>devise</th>
          <th style={styles.th}>rail</th>
          <th style={styles.th}>provider</th>
          <th style={styles.th}>créé le</th>
          <th style={styles.th}>payé le</th>
        </tr>
      </thead>
      <tbody>
        {items.map((p: AdminPayment) => {
          const meta = STATUT_META[p.status];
          return (
            <tr key={p.id}>
              <td style={styles.td}>{p.app_ref}</td>
              <td style={styles.td}>{p.app}</td>
              <td style={styles.td}>
                <span style={{ color: meta?.color ?? '#c9d1e6' }}>
                  {meta?.label ?? p.status}
                </span>
              </td>
              <td style={styles.td}>{fmtMinor(p.amount)}</td>
              <td style={styles.td}>{fmtMinor(p.refunded_amount)}</td>
              <td style={styles.td}>{p.currency}</td>
              <td style={styles.td}>{p.rail}</td>
              <td style={styles.td}>{p.provider}</td>
              <td style={styles.td}>
                {new Date(p.created_at).toLocaleString('fr-FR')}
              </td>
              <td style={styles.td}>
                {p.paid_at ? new Date(p.paid_at).toLocaleString('fr-FR') : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
