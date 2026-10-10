import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { codeProjectProviderAccess } from '@/lib/code/access';
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
export default async function NewCodeProjectPage() {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/code/new`));
  if (!(await sandboxWorkspacesEnabled())) redirect(`/code`);
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const access = await codeProjectProviderAccess(dbResult.val, session.subject);
  const bitbucketConnected = access[ATLASSIAN_BITBUCKET]!.ok;
  const githubConnected = access[GITHUB]!.ok;
  if (!bitbucketConnected && !githubConnected) redirect(`/code`);
  return (
    <NewCodeProject
      bitbucketConnected={bitbucketConnected}
      githubConnected={githubConnected}
    />
  );
}
