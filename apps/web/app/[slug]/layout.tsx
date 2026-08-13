import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { ROLE_OPERATOR } from '@/lib/access';
import { getIdentityDisplay } from '@/lib/identity';
import { signInUrl } from '@/lib/sign-in-url';
import AppNav from './nav';

/**
 * The shell every tenant page shares: top bar, slide-in menu, sign-out.
 *
 * Resolves the slug once and passes ids down through the nav; pages resolve it
 * again for their own data — cheap, and it keeps each page correct when
 * rendered in isolation. No auth redirect happens here: the admin sign-in
 * flow lives under this layout and must be reachable signed-out, so each page
 * guards itself and the nav simply renders for whoever is present.
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  const isOperator = session?.roles.includes(ROLE_OPERATOR) ?? false;

  // The nav shows a person, not an OIDC subject: the identity spine has the
  // display name and email recorded at sign-in. The subject is the fallback
  // for a session recorded before the spine existed.
  const identity = session ? await getIdentityDisplay(tenant.id, session.subject) : null;
  const userName = identity?.displayName ?? identity?.email ?? session?.subject ?? null;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-black dark:text-gray-100">
      <AppNav
        slug={tenant.slug}
        tenantId={tenant.id}
        userName={userName}
        userEmail={identity?.email ?? null}
        isOperator={isOperator}
        signInHref={signInUrl(tenant.id, `/${tenant.slug}`)}
      />
      {/* Wide enough for the log and grant tables; narrow pages center a
          max-w-3xl block of their own inside it. */}
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">{children}</main>
      <p className="pb-8 text-center text-sm text-gray-500">Renkei — Jira work item gateway</p>
    </div>
  );
}
