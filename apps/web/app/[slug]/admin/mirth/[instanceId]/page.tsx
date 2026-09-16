import React from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getDatabase } from '@renkei/db';
import { getInstance } from '@renkei/connector-mirth';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import InstanceConfigForm from './instance-config-form';

/**
 * One Mirth instance's management page: connection details, nothing else.
 * There is deliberately no access management here — every person connects
 * the instance with their own Mirth account on the connectors page, and
 * the Mirth server decides what that account may do.
 */
export default async function AdminMirthInstancePage({
  params,
}: {
  params: Promise<{ slug: string; instanceId: string }>;
}): Promise<React.ReactNode> {
  const { slug, instanceId } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="text-sm text-gray-600 dark:text-gray-400">Database unavailable.</p>
      </div>
    );
  }

  const instance = await getInstance(dbResult.val, tenantRef.id, instanceId);
  if (!instance.ok || !instance.val) notFound();

  const summary = instance.val.summary;
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <Link
          href={`/${slug}/admin/mirth`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          ← Mirth Connect
        </Link>
        <h1 className="mb-1 mt-2 text-xl font-bold">{summary.name}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {summary.environment} · {summary.baseUrl}
        </p>
      </div>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Connection</h2>
        <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
          Where the server lives and how its certificate is trusted. Who can use it is not decided
          here: everyone connects it with their own Mirth account from the Connectors page, and the
          server judges each account.
        </p>
        <InstanceConfigForm slug={slug} instanceId={instanceId} />
      </section>
    </div>
  );
}
