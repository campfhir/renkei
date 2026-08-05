import { getOperatorSession } from '@/lib/auth-utils';
import { redirect } from 'next/navigation';
import { getDatabase } from '@/lib/db';

export default async function AdminPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getOperatorSession();
  const { slug } = await params;

  if (!session) {
    // Fetch tenant to check for OIDC configuration
    const dbResult = getDatabase();
  if (!dbResult.ok) {
    throw new Error("Database error");
  }
  const db = dbResult.val;
    let oidcConfigured = false;
    try {
      const tenant = await db
        .selectFrom('tenants')
        .select(['id', 'slug'])
        .where('slug', '=', slug)
        .executeTakeFirst();

      if (tenant) {
        const oidc = await db
          .selectFrom('tenant_oidc')
          .select(['id'])
          .where('tenant_id', '=', tenant.id)
          .limit(1)
          .executeTakeFirst();
        oidcConfigured = !!oidc;
      }
    } catch {
      // Database error, show basic sign-in
    }

    const signInUrl = oidcConfigured ? `/admin/${slug}/sign-in` : null;

    return (
      <div style={{ padding: '2rem', maxWidth: '500px' }}>
        <h2>Sign In Required</h2>
        <p>You need to be signed in to access the admin console for {slug}.</p>
        {signInUrl ? (
          <form action={signInUrl} method="GET">
            <button
              type="submit"
              style={{
                padding: '0.75rem 1.5rem',
                background: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontSize: '1rem',
                cursor: 'pointer',
              }}
            >
              Sign In with Your Organization
            </button>
          </form>
        ) : (
          <p style={{ color: '#666' }}>OIDC is not configured for this organization.</p>
        )}
      </div>
    );
  }

  // Redirect to logs page
  redirect(`/admin/${slug}/logs`);
}
