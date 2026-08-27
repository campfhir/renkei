import React from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getDatabase } from '@renkei/db';
import { getShare } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import ShareConfigForm from './share-config-form';

/**
 * One share's management page: connection details, nothing else. There is
 * deliberately no access management here — every person connects the share
 * with their own credentials on the connectors page, and the file server
 * decides what that account may do.
 */
export default async function AdminFileSharePage({
  params,
}: {
  params: Promise<{ slug: string; shareId: string }>;
}): Promise<React.ReactNode> {
  const { slug, shareId } = await params;
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

  const share = await getShare(dbResult.val, tenantRef.id, shareId);
  if (!share.ok || !share.val) notFound();

  const summary = share.val.summary;
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <Link
          href={`/${slug}/admin/file-shares`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          ← File shares
        </Link>
        <h1 className="mb-1 mt-2 text-xl font-bold">{summary.name}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {summary.protocol === 'smb'
            ? `SMB · \\\\${summary.host}\\${summary.shareName ?? ''}`
            : `SFTP · ${summary.host}`}
          {summary.rootPath !== '/' ? ` · root ${summary.rootPath}` : ''}
        </p>
      </div>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Connection</h2>
        <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
          Where the share lives. Who can use it is not decided here: everyone connects it with
          their own credentials from the Connectors page, and the file server judges each account.
        </p>
        <ShareConfigForm slug={slug} shareId={shareId} />
      </section>
    </div>
  );
}
