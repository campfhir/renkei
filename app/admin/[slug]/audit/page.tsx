import { getOperatorSession } from '@/lib/auth-utils';
import { redirect } from 'next/navigation';
import { getDatabase } from '@/lib/db';

export default async function AuditPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getOperatorSession();
  const { slug } = await params;

  if (!session) {
    redirect(`/admin/${slug}`);
  }

  const db = getDatabase();

  let events: any[] = [];
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
        .select(['event_id', 'event_type', 'actor_id', 'resource_id', 'created_at', 'details'])
        .where('tenant_id', '=', tenant.id)
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
              <tr key={event.event_id} style={{ borderBottom: '1px solid #eee' }}>
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
