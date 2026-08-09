import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';

/**
 * The admin console's front door. Operators are forwarded to the logs; a
 * signed-in user without the operator role is told so rather than being
 * offered a sign-in that would change nothing; a signed-out visitor is sent
 * into the tenant's OIDC flow and comes back here.
 */
export default async function AdminPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();

  // Connectors is the console's center of gravity; logs live on the shared
  // Activity page, where an operator already sees the whole tenant.
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (access) {
    redirect(`/${slug}/admin/connectors`);
  }

  const session = await getSessionFromCookies(tenantRef.id);
  if (session) {
    return (
      <div className="mx-auto max-w-lg">
        <h2 className="mb-2 text-lg font-semibold">Operator access required</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          You are signed in, but your account does not carry the operator role for {slug}. Roles
          come from your identity provider&apos;s claim mapping — an existing operator can check it
          under Settings.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-2 text-lg font-semibold">Sign in required</h2>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        You need to be signed in to access the admin console for {slug}.
      </p>
      <a
        href={signInUrl(tenantRef.id, `/${slug}/admin`)}
        className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Sign in with your organization
      </a>
    </div>
  );
}
