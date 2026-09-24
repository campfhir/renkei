import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import InstanceList from './instance-list';

/**
 * ADManager Plus instances — the registry. Each row is one ManageEngine
 * ADManager Plus server (per domain, per site, or a separate test
 * instance…): a name, an environment label and how to reach its REST
 * API. Who may use an instance is not decided here: everyone connects it
 * with their own ADManager Plus authtoken from the Connectors page, and
 * ADManager Plus's own token scope and the technician's delegated rights
 * judge each account.
 */
export default async function AdminAdManagerPage({
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
      <h1 className="mb-1 text-xl font-bold">ADManager Plus</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        The ManageEngine ADManager Plus servers your organization runs. Register where each one
        is; people connect it with their own ADManager Plus authtoken from the Connectors page, and
        the server&apos;s own token scope and the technician&apos;s delegated rights decide what
        that account may do.
      </p>
      <InstanceList slug={slug} />
    </div>
  );
}
