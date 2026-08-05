import React from 'react';
import { getOperatorSession } from '@/lib/auth-utils';
import { redirect } from 'next/navigation';
import { getDatabase } from '@/lib/db';

export default async function AuditPage({ params }: { params: Promise<{ slug: string }> }): Promise<React.ReactNode> {
  const session = await getOperatorSession();
  const { slug } = await params;

  if (!session) {
    redirect(`/admin/${slug}`);
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

  let events: {
    id: string;
    event_type: string;
    actor_id: string | null;
    resource_id: string | null;
    created_at: Date;
    details: unknown;
  }[] = [];
  try {
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (tenant) {
      // Fetch recent audit events
      events = await db
        .selectFrom('platform_audit_log')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
    }
  } catch (err) {
    console.error('Error fetching audit log:', err);
  }

  return (
    <div>
      <h2>Audit Log</h2>
      {events.length === 0 ? (
        <p>No audit events yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #ddd', background: '#f5f5f5' }}>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Event</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Actor</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Resource</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem' }}>{event.event_type}</td>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace' }}>
                  {event.actor_id ? event.actor_id.slice(0, 8) : '—'}
                </td>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace' }}>
                  {event.resource_id ? event.resource_id.slice(0, 12) : '—'}
                </td>
                <td style={{ padding: '0.5rem', color: '#666' }}>
                  {event.created_at
                    ? new Date(event.created_at).toLocaleString()
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
