import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import ActionableCards from './cards';

/**
 * Where a signed-in user lands: the actionable-item feed, which is the point
 * of the product. Everything else — connectors, logs, admin — hangs off the
 * nav in the layout, surfaced there by role.
 */
export default async function HomePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/home`));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Actionable items</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Suggestions from your connected tools. Approving executes the action as you.
      </p>
      <ActionableCards tenantId={tenant.id} />
    </div>
  );
}
