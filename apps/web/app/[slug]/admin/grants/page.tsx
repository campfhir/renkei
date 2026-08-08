import React from 'react';
import { getDatabase } from '@renkei/db';
import { getOperatorAccess } from '@/lib/operator-access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';

export default async function GrantsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await getOperatorAccess(tenantRef.id))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div style={{ padding: '2rem', maxWidth: '1000px' }}>
        <h2>Error</h2>
        <p>Unable to connect to the database. Please try again later.</p>
      </div>
    );
  }
  const db = dbResult.val;

  // Fetch tenant
  const tenant = await db
    .selectFrom('tenants')
    .select(['id'])
    .where('slug', '=', slug)
    .executeTakeFirst();

  if (!tenant) {
    redirect(`/${slug}/admin`);
  }

  // Fetch grants
  const grants = await db
    .selectFrom('provider_grants')
    .select([
      'provider_account_id',
      'display_name',
      'metadata',
      'expires_at',
      'created_at',
      'subject',
    ])
    .where('tenant_id', '=', tenant.id)
    .where('provider', '=', 'atlassian')
    .orderBy('created_at', 'desc')
    .execute();

  return (
    <div style={{ padding: '2rem', maxWidth: '1000px' }}>
      <h2>Connected Jira Accounts</h2>
      <p style={{ color: 'var(--muted)' }}>Manage Atlassian grants and connected user accounts</p>

      {grants.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            backgroundColor: '#f5f5f5',
            borderRadius: '4px',
            textAlign: 'center',
          }}
        >
          <p>No connected Jira accounts yet</p>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '1rem' }}>Display Name</th>
              <th style={{ textAlign: 'left', padding: '1rem' }}>Account ID</th>
              <th style={{ textAlign: 'left', padding: '1rem' }}>Cloud ID</th>
              <th style={{ textAlign: 'left', padding: '1rem' }}>Expires At</th>
              <th style={{ textAlign: 'left', padding: '1rem' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => {
              const grantKey = grant.provider_account_id;
              const cloudId =
                typeof grant.metadata === 'object' &&
                grant.metadata !== null &&
                'cloudId' in grant.metadata &&
                typeof grant.metadata.cloudId === 'string'
                  ? grant.metadata.cloudId
                  : '';
              const expiresAt = new Date(grant.expires_at);
              const isExpired = expiresAt < new Date();
              const expiresAtStr = expiresAt.toLocaleDateString();

              return (
                <tr key={grantKey} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '1rem' }}>{grant.display_name}</td>
                  <td style={{ padding: '1rem', fontSize: '0.9rem' }}>
                    {grant.provider_account_id}
                  </td>
                  <td style={{ padding: '1rem', fontSize: '0.9rem' }}>{cloudId}</td>
                  <td
                    style={{
                      padding: '1rem',
                      color: isExpired ? '#d32f2f' : '#333',
                    }}
                  >
                    {expiresAtStr}
                    {isExpired && <span style={{ marginLeft: '0.5rem' }}>⚠️</span>}
                  </td>
                  <td style={{ padding: '1rem' }}>
                    <button
                      onClick={() => {
                        // In a real app, this would call the revoke endpoint
                        if (confirm(`Revoke access for ${grant.display_name}?`)) {
                          fetch(`/api/admin/${slug}/grants/${grant.provider_account_id}/revoke`, {
                            method: 'POST',
                          })
                            .then((res) => res.json())
                            .then((data) => {
                              if (data.success) {
                                // Reload page
                                window.location.reload();
                              }
                            })
                            .catch((err) => console.error('Revoke failed:', err));
                        }
                      }}
                      style={{
                        padding: '0.5rem 1rem',
                        backgroundColor: '#d32f2f',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid var(--border)' }}>
        <h3>About Connected Accounts</h3>
        <ul style={{ color: 'var(--muted)' }}>
          <li>Connected accounts allow the MCP gateway to access Jira on behalf of users</li>
          <li>Tokens expire after a period of time and are automatically refreshed</li>
          <li>
            Revoking an account removes the token immediately - the user will need to reconnect
          </li>
          <li>All tokens are encrypted at rest using AES-256-GCM</li>
        </ul>
      </div>
    </div>
  );
}
