import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import ShareList from './share-list';

/**
 * Org file shares (SMB/SFTP) — the registry. Each share is a host plus a
 * service credential plus a per-user ACL, and each row here links to its
 * own management page (origin, credentials, who may see it, path rules).
 * Renkei is the ACL authority for these: nobody sees a share without a
 * grant, whatever the file server itself would allow.
 */
export default async function AdminFileSharesPage({
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
      <h1 className="mb-1 text-xl font-bold">File shares</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Network file shares reachable over SMB or SFTP with a service credential you manage here.
        Access is granted per person inside Renkei — someone without a grant cannot even see that a
        share exists — and can be narrowed to specific folders on each share&apos;s page.
      </p>
      <ShareList slug={slug} />
    </div>
  );
}
