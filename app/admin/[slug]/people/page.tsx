import { getOperatorSession } from '@/lib/auth-utils';
import { redirect } from 'next/navigation';
import { getDatabase } from '@/lib/db';

interface User {
  account_id: string;
  last_used_at: Date;
}

export default async function PeoplePage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getOperatorSession();
  const { slug } = await params;

  if (!session) {
    redirect(`/admin/${slug}`);
  }

  const db = getDatabase();

  let users: User[] = [];
  try {
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (tenant) {
      // Query users who have connected Jira sessions in this tenant
      const sessions = await db
        .selectFrom('jira_sessions')
        .select(['account_id', 'last_used_at'])
        .where('tenant_id', '=', tenant.id)
        .orderBy('last_used_at', 'desc')
        .execute();

      // Get unique users with their most recent session
      const userMap = new Map<string, User>();
      for (const session of sessions) {
        if (!userMap.has(session.account_id)) {
          userMap.set(session.account_id, {
            account_id: session.account_id,
            last_used_at: session.last_used_at,
          });
        }
      }
      users = Array.from(userMap.values());
    }
  } catch (err) {
    console.error('Error fetching people:', err);
  }

  return (
    <div>
      <h2>People</h2>
      {users.length === 0 ? (
        <p>No users have connected yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #ddd' }}>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Account ID</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Last Active</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.account_id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.9em' }}>
                  {user.account_id}
                </td>
                <td style={{ padding: '0.5rem' }}>
                  {new Date(user.last_used_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
