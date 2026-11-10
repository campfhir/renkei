import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { codeProjectProviderAccess, codeProjectAccessMessage } from '@/lib/code/access';
import { describeProjectsFromReadme } from '@/lib/code/describe-projects';
import CodeIndex from './_components/code-index';

/**
 * Code projects: mine, and the ones shared with me or published to the
 * org. Each is a repository a chat can work in. The page is there for
 * everyone — the feature stays discoverable — but making a project waits
 * on a Bitbucket OR GitHub connection that carries what one runs on
 * (lib/code/access.ts); until then the page says what to connect.
 */
export default async function CodePage() {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/code`));
  const [sidebar, access] = await Promise.all([
    loadChatSidebar(session.subject),
    codeProjectProviderAccess(session.subject),
  ]);
  const bitbucketAccess = access[ATLASSIAN_BITBUCKET]!;
  const githubAccess = access[GITHUB]!;
  const canCreate = bitbucketAccess.ok || githubAccess.ok;
  // Neither host is ready: point at whichever is further along (already
  // connected but missing a capability beats "connect it at all").
  const accessNotice = canCreate
    ? null
    : ((bitbucketAccess.connected
        ? codeProjectAccessMessage(bitbucketAccess, ATLASSIAN_BITBUCKET)
        : null) ??
      (githubAccess.connected ? codeProjectAccessMessage(githubAccess, GITHUB) : null) ??
      `${codeProjectAccessMessage(bitbucketAccess, ATLASSIAN_BITBUCKET)} Or connect GitHub instead.`);
  // Projects of mine with no description get one from their README, after
  // the response: it shows from the next visit.
  const undescribed = sidebar.code.projects.filter(
    (project) => project.role === 'owner' && !project.description && project.repoFullName
  );
  if (undescribed.length > 0) {
    const subject = session.subject;
    after(async () => {
      await describeProjectsFromReadme(subject, undescribed);
    });
  }
  return (
    <CodeIndex
      projects={sidebar.code.projects}
      enabled={await sandboxWorkspacesEnabled()}
      canCreate={canCreate}
      accessNotice={accessNotice}
    />
  );
}
