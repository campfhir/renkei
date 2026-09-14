import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listChatModels } from '@/lib/chat/models';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import ChatThread from '../_components/chat-thread';
import { sandboxWorkspacesEnabled, sbWorkspaceGet } from '@/lib/sandbox/service-client';

/**
 * A new chat: the composer with no thread yet. The first Send creates the
 * chat (optionally inside the project named by `?project=`) and moves the
 * browser to its address. `?workspace=` opens it with a code workspace in
 * mind: the box starts with a message naming the checkout, so the model's
 * first move is in the right repository.
 */
export default async function NewChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ project?: string; workspace?: string }>;
}) {
  const { slug } = await params;
  const { project: projectId, workspace: workspaceId } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/chat/new`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;

  let project: { id: string; name: string } | null = null;
  if (projectId) {
    const access = await resolveResourceAccess(
      db,
      tenant.id,
      session.subject,
      'chat_project',
      projectId
    );
    const row = access ? await getProjectRow(db, tenant.id, projectId) : null;
    if (row) project = { id: row.id, name: row.name };
  }
  // The workspace must be this person's own (the worker scopes the lookup);
  // anything else, or a workspace that no longer exists, is simply ignored.
  let initialDraft: string | null = null;
  if (workspaceId && sandboxWorkspacesEnabled()) {
    const workspace = await sbWorkspaceGet(
      { tenantId: tenant.id, subject: session.subject },
      workspaceId
    );
    if (workspace.ok) {
      initialDraft =
        `Work in my code workspace ${workspace.val.id} (${workspace.val.repoFullName}, branch ${workspace.val.branch}). ` +
        'Start by getting familiar with the project layout, then: ';
    }
  }
  const [models, uploadsEnabled] = await Promise.all([
    listChatModels(db, tenant.id),
    tenantBlobStoreConfigured(tenant.id),
  ]);
  return (
    <ChatThread
      slug={slug}
      tenantId={tenant.id}
      subject={session.subject}
      initialChat={null}
      initialMessages={[]}
      models={models}
      uploadsEnabled={uploadsEnabled}
      newChatProject={project}
      initialDraft={initialDraft}
    />
  );
}
