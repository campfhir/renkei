import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getOperatorAccess } from '@/lib/operator-access';
import { tenantForSlug } from '@/lib/tenant-slug';
import ConnectorForms from './connector-forms';

/**
 * Org-admin provisioning of connectors (RENKEI.md Decision #13): the
 * Atlassian OAuth app, the WebEx bot, the embedding provider. This page is
 * the UI over the /api/admin/[slug]/connectors routes that already existed —
 * until now the only way to register an app was a hand-written PUT from a
 * devtools console, which is what docs/ui-shell-brief.md was written about.
 */
export default async function AdminConnectorsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await getOperatorAccess(tenantRef.id))) {
    redirect(`/${slug}/admin`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Connector setup</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        What your organization runs, with what credentials. Secrets are sealed with the deployment
        key and never shown again after saving.
      </p>
      <ConnectorForms slug={slug} />
    </div>
  );
}
