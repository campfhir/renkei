import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { codeProjectProviderAccess } from '@/lib/code/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import NewCodeProject from '../_components/new-code-project';

/**
 * A new code project: a name, a repository from the person's own
 * Bitbucket or GitHub, a branch, the `.env` its commands run with, and
 * the instructions every chat in it should know. Creating it starts the
 * clone; the project page follows it. Without a connection on at least
 * one host that carries what a project runs on (lib/code/access.ts) the
 * person is sent back to the Code page, which says what to connect.
 */
export default async function NewCodeProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/code/new`));
  if (!sandboxWorkspacesEnabled()) redirect(`/${slug}/code`);
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const access = await codeProjectProviderAccess(dbResult.val, tenant.id, session.subject);
  const bitbucketConnected = access[ATLASSIAN_BITBUCKET]!.ok;
  const githubConnected = access[GITHUB]!.ok;
  if (!bitbucketConnected && !githubConnected) redirect(`/${slug}/code`);
  return (
    <NewCodeProject
      slug={slug}
      tenantId={tenant.id}
      bitbucketConnected={bitbucketConnected}
      githubConnected={githubConnected}
    />
  );
}
