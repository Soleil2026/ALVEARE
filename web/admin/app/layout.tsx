import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ALVEARE · Backoffice',
  description: 'Backoffice admin du socle ALVEARE Core',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
