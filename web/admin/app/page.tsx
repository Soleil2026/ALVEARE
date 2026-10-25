/**
 * web-admin — page / : première boucle complète de la plateforme.
 * Non connecté → bouton login (Keycloak). Connecté → profil +
 * rôles EFFECTIFS par app (identity /me) + documents (proxy → :4010).
 * Zone Red (session visible) : revue indépendante obligatoire.
 */

import { cookies } from 'next/headers';
import UploadForm from './upload-form';
import { SESSION_COOKIE, decodeSession } from '../lib/session';

const styles = {
  page: {
    minHeight: '100vh',
    background: '#0b1020',
    color: '#e7eaf3',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    padding: 24,
  },
  badge: {
    fontSize: 13,
    letterSpacing: 3,
    textTransform: 'uppercase' as const,
    color: '#8fa3ff',
  },
  title: {
    fontSize: 40,
    fontWeight: 700,
    margin: 0,
  },
  card: {
    background: '#121a33',
    border: '1px solid #232f5c',
    borderRadius: 14,
    padding: '18px 22px',
    width: 'min(680px, 100%)',
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
  },
  chip: {
    background: '#1b2650',
    border: '1px solid #2b3a8f',
    color: '#c7d2ff',
    borderRadius: 99,
    padding: '3px 12px',
    fontSize: 13,
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
  doc: {
    fontSize: 15,
    color: '#9aa5c0',
  },
} as const;

type Me = {
  sub: string;
  email?: string;
  realmRoles: string[];
  appRoles: Array<{ app: string; role: string }>;
};

type Doc = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

async function getState() {
  const store = await cookies();
  const session = await decodeSession(store.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { kind: 'anonymous' as const };
  }
  try {
    const me = (await (
      await fetch(`${process.env.IDENTITY_URL ?? 'http://localhost:4000'}/me`, {
        headers: { Authorization: `Bearer ${session.at}` },
        cache: 'no-store',
      })
    ).json()) as Me;
    if (!me.sub) throw new Error('sub absent');
    const docs = (await (
      await fetch(`${process.env.DOCUMENTS_URL ?? 'http://localhost:4010'}/documents`, {
        headers: { Authorization: `Bearer ${session.at}` },
        cache: 'no-store',
      })
    ).json()) as Doc[];
    return { kind: 'authed' as const, me, docs };
  } catch {
    return { kind: 'expired' as const };
  }
}

export default async function Page() {
  const state = await getState();

  return (
    <main style={styles.page}>
      <div style={styles.badge}>ALVEARE · SOCLE</div>
      <h1 style={styles.title}>Backoffice</h1>

      {state.kind === 'anonymous' && (
        <>
          <p style={styles.doc}>
            Connexion via Keycloak (realm <code>alveare</code>) — Authorization Code + PKCE.
          </p>
          <a href="/login" style={styles.button}>
            Se connecter
          </a>
        </>
      )}

      {state.kind === 'expired' && (
        <>
          <p style={{ ...styles.doc, color: '#ff7b7b' }}>Session expirée.</p>
          <a href="/login" style={styles.button}>
            Se reconnecter
          </a>
        </>
      )}

      {state.kind === 'authed' && (
        <>
          <section style={styles.card}>
            <div style={styles.row}>
              <strong style={{ color: '#e7eaf3' }}>{state.me.email ?? state.me.sub}</strong>
              {state.me.realmRoles.map((r) => (
                <span key={r} style={styles.chip}>
                  realm:{r}
                </span>
              ))}
            </div>
            <div style={styles.row}>
              {state.me.appRoles.length === 0 ? (
                <span style={styles.doc}>aucun rôle par application (compte global ≠ accès automatique)</span>
              ) : (
                state.me.appRoles.map((g) => (
                  <span key={g.app} style={styles.chip}>
                    {g.app} · {g.role}
                  </span>
                ))
              )}
            </div>
          </section>

          <section style={styles.card}>
            <div style={styles.row}>
              <strong style={{ color: '#e7eaf3' }}>Mes documents</strong>
              <span>{state.docs.length}</span>
            </div>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Fichier</th>
                  <th style={styles.th}>Type</th>
                  <th style={styles.th}>Taille</th>
                  <th style={styles.th}>Déposé le</th>
                </tr>
              </thead>
              <tbody>
                {state.docs.map((d) => (
                  <tr key={d.id}>
                    <td style={styles.td}>{d.fileName}</td>
                    <td style={styles.td}>{d.mimeType}</td>
                    <td style={styles.td}>{d.sizeBytes} o</td>
                    <td style={styles.td}>{new Date(d.createdAt).toLocaleString('fr-FR')}</td>
                  </tr>
                ))}
                {state.docs.length === 0 && (
                  <tr>
                    <td style={styles.td} colSpan={4}>
                      aucun document
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <UploadForm />
          </section>

          <form action="/logout" method="post">
            <button type="submit" style={{ ...styles.button, background: '#3a2450' }}>
              Déconnexion
            </button>
          </form>
        </>
      )}
    </main>
  );
}
