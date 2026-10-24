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
    fontSize: 44,
    fontWeight: 700,
    margin: 0,
  },
  subtitle: {
    fontSize: 17,
    color: '#9aa5c0',
    margin: 0,
    textAlign: 'center' as const,
    maxWidth: 560,
  },
  status: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    background: '#121a33',
    border: '1px solid #232f5c',
    borderRadius: 10,
    padding: '10px 18px',
    fontSize: 14,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 99,
    background: '#3ddc97',
  },
  links: {
    display: 'flex',
    gap: 16,
    fontSize: 14,
    color: '#8fa3ff',
  },
};

export default function Home() {
  return (
    <main style={styles.page}>
      <div style={styles.badge}>Socle ALVEARE — écosystème VISA VOYAGE</div>
      <h1 style={styles.title}>ALVEARE Core</h1>
      <p style={styles.subtitle}>
        Le socle transversal des 12 applications métier : identité, documents,
        notifications, paiements — construit dans le dépôt{' '}
        <code>ALVEARE</code>, documenté dans le wiki <code>ALVEARETOP</code>.
      </p>
      <div style={styles.status}>
        <span style={styles.dot} />
        Backoffice admin · chantier E1 démarré · E2 Identité à venir
      </div>
      <div style={styles.links}>
        <a href="http://localhost:4000/healthz" style={{ color: '#8fa3ff' }}>
          Service Identité → /healthz
        </a>
        <span style={{ color: '#3a4470' }}>·</span>
        <span style={{ color: '#5f6a95' }}>Keycloak : à venir (E2)</span>
      </div>
    </main>
  );
}
