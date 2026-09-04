import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listChatModels } from '@/lib/chat/models';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import ChatThread from './_components/chat-thread';

/**
 * A new chat: the composer with no thread yet. The first Send creates the
 * chat (optionally inside the project named by `?project=`) and moves the
 * browser to its address.
 */
export default async function NewChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { slug } = await params;
  const { project: projectId } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/chat`));
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
  const models = await listChatModels(db, tenant.id);
  return (
    <ChatThread
      slug={slug}
      tenantId={tenant.id}
      subject={session.subject}
      initialChat={null}
      initialMessages={[]}
      models={models}
      newChatProject={project}
    />
  );
}
