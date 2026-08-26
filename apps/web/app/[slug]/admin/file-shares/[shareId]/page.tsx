import React from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getDatabase } from '@renkei/db';
import { getShare } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import ShareConfigForm from './share-config-form';
import GrantManager from './grant-manager';
import RulesEditor from './rules-editor';

/**
 * One share's management page: origin and credentials, who may see it,
 * and the two-layer path rules. The people picker is fed server-side from
 * the same identities union the People page renders, so the grant form
 * offers everyone the org knows about without a second directory API.
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

  const identities = await dbResult.val
    .selectFrom('identities')
    .select(['subject', 'display_name', 'email'])
    .where('tenant_id', '=', tenantRef.id)
    .orderBy('display_name')
    .execute();
  const people = identities.map((identity) => ({
    subject: identity.subject,
    label: identity.display_name || identity.email || identity.subject,
  }));

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
        <h2 className="mb-2 text-lg font-semibold">Connection</h2>
        <ShareConfigForm slug={slug} shareId={shareId} />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Access</h2>
        <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
          Only people granted here can see or use this share — from the files page, from models over
          MCP, anywhere. A grant&apos;s default applies from the share root; path rules below narrow
          it further. Removing a grant also removes that person&apos;s path rules.
        </p>
        <GrantManager slug={slug} shareId={shareId} people={people} />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Path rules</h2>
        <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
          Two layers: share-wide rules apply to everyone granted; per-person rules narrow further
          (they can never widen what the share-wide layer allows). Within a layer the longest
          matching path wins, so a deeper rule overrides a shallower one — allow and deny alike.
          Rules can name folders that do not exist yet.
        </p>
        <RulesEditor slug={slug} shareId={shareId} people={people} />
      </section>
    </div>
  );
}
