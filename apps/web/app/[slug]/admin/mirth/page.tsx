import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import InstanceList from './instance-list';

/**
 * Mirth Connect instances — the registry. Each row is one Mirth server
 * (dev, test, prod, one per site…): a name, an environment label and how
 * to reach its REST API. Who may use an instance is not decided here:
 * everyone connects it with their own Mirth account from the Connectors
 * page, and the Mirth server's roles judge each account.
 */
export default async function AdminMirthPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Mirth Connect</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        The Mirth Connect (NextGen Connect 4.5) servers your organization runs. Register where each
        one is; people connect it with their own Mirth account from the Connectors page, and the
        server&apos;s own roles decide what that account may do.
      </p>
      <InstanceList slug={slug} />
    </div>
  );
}
