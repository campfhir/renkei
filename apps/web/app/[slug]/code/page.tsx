import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { codeProjectProviderAccess, codeProjectAccessMessage } from '@/lib/code/access';
import CodeIndex from './_components/code-index';

/**
 * Code projects: mine, and the ones shared with me or published to the
 * org. Each is a repository a chat can work in. The page is there for
 * everyone — the feature stays discoverable — but making a project waits
 * on a Bitbucket OR GitHub connection that carries what one runs on
 * (lib/code/access.ts); until then the page says what to connect.
 */
export default async function CodePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/code`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const [sidebar, access] = await Promise.all([
    loadChatSidebar(dbResult.val, tenant.id, session.subject),
    codeProjectProviderAccess(dbResult.val, tenant.id, session.subject),
  ]);
  const bitbucketAccess = access[ATLASSIAN_BITBUCKET]!;
  const githubAccess = access[GITHUB]!;
  const canCreate = bitbucketAccess.ok || githubAccess.ok;
  // Neither host is ready: point at whichever is further along (already
  // connected but missing a capability beats "connect it at all").
  const accessNotice = canCreate
    ? null
    : (bitbucketAccess.connected
        ? codeProjectAccessMessage(bitbucketAccess, ATLASSIAN_BITBUCKET)
        : null) ??
      (githubAccess.connected ? codeProjectAccessMessage(githubAccess, GITHUB) : null) ??
      `${codeProjectAccessMessage(bitbucketAccess, ATLASSIAN_BITBUCKET)} Or connect GitHub instead.`;
  return (
    <CodeIndex
      slug={slug}
      projects={sidebar.code.projects}
      enabled={sandboxWorkspacesEnabled()}
      canCreate={canCreate}
      accessNotice={accessNotice}
    />
  );
}
