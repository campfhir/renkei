import React from 'react';
import { getOperatorSession } from '@/lib/auth-utils';
import { redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';

export default async function AdminPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const session = await getOperatorSession();
  const { slug } = await params;

  if (!session) {
    // Fetch tenant to check for OIDC configuration
    const dbResult = getDatabase();
    if (!dbResult.ok) {
      return (
        <div style={{ padding: '2rem', maxWidth: '500px' }}>
          <h2>Error</h2>
          <p>Unable to connect to the database. Please try again later.</p>
        </div>
      );
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

    const signInUrl = oidcConfigured ? `/${slug}/admin/sign-in` : null;

    return (
      <div className="mx-auto max-w-lg">
        <h2 className="mb-2 text-lg font-semibold">Sign in required</h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          You need to be signed in to access the admin console for {slug}.
        </p>
        {signInUrl ? (
          <form action={signInUrl} method="GET">
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Sign in with your organization
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            OIDC is not configured for this organization.
          </p>
        )}
      </div>
    );
  }

  // Redirect to logs page
  redirect(`/${slug}/admin/logs`);
}
