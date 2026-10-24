'use client';

/**
 * web-admin — formulaire d'upload (client) : envoie le fichier au
 * proxy /api/documents avec le cookie de session (httpOnly, jamais
 * exposé en JS). Recharge la table via router.refresh().
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function UploadForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const form = new FormData(e.currentTarget);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setError('choisissez un fichier');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/documents', { method: 'POST', body: form });
      const body = (await res.json()) as { error?: string; fileName?: string };
      if (res.ok) {
        setMessage(`déposé : ${body.fileName ?? 'fichier'}`);
        e.currentTarget.reset();
        router.refresh();
      } else {
        setError(body.error ?? `échec (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        type="file"
        name="file"
        required
        accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx"
        style={{ color: '#9aa5c0' }}
      />
      <button
        type="submit"
        disabled={busy}
        style={{
          background: '#2b3a8f',
          color: 'white',
          border: 'none',
          borderRadius: 10,
          padding: '10px 18px',
          fontWeight: 600,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? 'envoi…' : 'Déposer'}
      </button>
      {message && <span style={{ color: '#3ddc97', fontSize: 14 }}>{message}</span>}
      {error && <span style={{ color: '#ff7b7b', fontSize: 14 }}>{error}</span>}
    </form>
  );
}
