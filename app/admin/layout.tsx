import type { ReactNode } from 'react';
import { getOperatorSession } from '@/lib/auth-utils';

export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params?: Promise<{ slug: string }>;
}) {
  const session = await getOperatorSession();
  const slug = params ? (await params).slug : null;

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
        {slug && (
          <nav style={navStyle as React.CSSProperties}>
            <a href={`/admin/${slug}/sites`} style={linkStyle as React.CSSProperties}>
              Sites
            </a>
            <a href={`/admin/${slug}/people`} style={linkStyle as React.CSSProperties}>
              People
            </a>
            <a href={`/admin/${slug}/grants`} style={linkStyle as React.CSSProperties}>
              Grants
            </a>
            <a href={`/admin/${slug}/logs`} style={linkStyle as React.CSSProperties}>
              Logs
            </a>
            <a href={`/admin/${slug}/audit`} style={linkStyle as React.CSSProperties}>
              Audit
            </a>
            <a href={`/admin/${slug}/settings`} style={linkStyle as React.CSSProperties}>
              Settings
            </a>
          </nav>
        )}
      </header>
      <main style={{ flex: 1, padding: '2rem' }}>{children}</main>
    </div>
  );
}
