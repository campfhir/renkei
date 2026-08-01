import { getOperatorSession } from '@/lib/auth-utils';
import { redirect } from 'next/navigation';
import { getDatabase } from '@/lib/db';

export default async function PeoplePage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getOperatorSession();
  const { slug } = await params;

  if (!session) {
    redirect(`/admin/${slug}`);
  }

  const db = getDatabase();

  let users: any[] = [];
  try {
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (tenant) {
      // TODO: Fetch users from database
      // Query users who have connected to any site in this tenant
      users = await db
        .selectFrom('user_sessions')
        .select(['account_id', 'display_name', 'email'])
        .distinct()
        .where('tenant_id', '=', tenant.id)
        .execute();
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
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Display Name</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Email</th>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Account ID</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.account_id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem' }}>{user.display_name || '—'}</td>
                <td style={{ padding: '0.5rem' }}>{user.email || '—'}</td>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.9em' }}>
                  {user.account_id}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
