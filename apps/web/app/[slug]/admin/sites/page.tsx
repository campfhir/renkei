import React from 'react';
import { getOperatorSession } from '@/lib/auth-utils';
import { redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';

interface JiraSite {
  site_id: string;
  cloud_id: string;
  jira_url: string;
  enabled: boolean;
  claimed_at: Date | null;
}

export default async function SitesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const session = await getOperatorSession();
  const { slug } = await params;

  if (!session) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div>
        <h2>Error</h2>
        <p>Unable to connect to the database. Please try again later.</p>
      </div>
    );
  }
  const db = dbResult.val;

  // Fetch sites for this tenant
  let sites: JiraSite[] = [];
  try {
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (tenant) {
      sites = await db
        .selectFrom('tenant_jira_sites')
        .select(['site_id', 'cloud_id', 'jira_url', 'enabled', 'claimed_at'])
        .where('tenant_id', '=', tenant.id)
        .execute();
    }
  } catch (err) {
    console.error('Error fetching sites:', err);
  }

  return (
    <div>
      <h2>Connected Sites</h2>
      {sites.length === 0 ? (
        <p>No Jira sites connected yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Jira URL</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Cloud ID</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Status</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Claimed</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.site_id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '0.5rem' }}>{site.jira_url}</td>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.9em' }}>
                  {site.cloud_id}
                </td>
                <td style={{ padding: '0.5rem' }}>{site.enabled ? '✓ Enabled' : 'Disabled'}</td>
                <td style={{ padding: '0.5rem', fontSize: '0.9em', color: 'var(--muted)' }}>
                  {site.claimed_at ? new Date(site.claimed_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
