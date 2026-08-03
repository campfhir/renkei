import type { ReactNode } from 'react';
import { getOperatorSession } from '@/lib/auth-utils';

export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params?: Promise<Record<string, never>>;
}) {
  const session = await getOperatorSession();
  const slug = null;

  if (!session) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <header style={{ padding: '1rem', borderBottom: '1px solid #ddd' }}>
          <h1>Renkei Admin Console</h1>
          <p>Not signed in</p>
        </header>
        <main style={{ flex: 1, padding: '2rem' }}>{children}</main>
      </div>
    );
  }

  const navStyle = {
    display: 'flex',
    gap: '1.5rem',
    padding: '0.5rem 0',
    fontSize: '0.95rem',
  };

  const linkStyle = {
    color: '#0066cc',
    textDecoration: 'none',
    cursor: 'pointer',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <header style={{ padding: '1rem', borderBottom: '1px solid #ddd' }}>
        <h1>Renkei Admin Console</h1>
        <p style={{ margin: '0.5rem 0 1rem 0' }}>Signed in as {session.operator}</p>
      </header>
      <main style={{ flex: 1, padding: '2rem' }}>{children}</main>
    </div>
  );
}
