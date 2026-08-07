import type { ReactNode } from 'react';
import { getOperatorSession } from '@/lib/auth-utils';

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getOperatorSession();

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
