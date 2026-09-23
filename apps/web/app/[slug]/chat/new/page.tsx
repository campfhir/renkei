import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { isUuid } from '@/lib/uuid';
import { resolveResourceAccess } from '@/lib/chat/access';
import { createChat } from '@/lib/chat/store';
import { createChatInProject } from '@/lib/code/active-chat';
import { getProjectRow } from '@/lib/chat/projects';

/**
 * "+ New": an empty chat is created here and now (optionally inside the
 * project named by `?project=`) and the browser goes straight to its
 * address. The first Send is then an ordinary turn on a chat that already
 * exists — the thread never has to change address or reload under the
 * person mid-reply. An empty chat stays out of the menu until its first
 * message, and one nobody ever wrote in is swept after a day.
 *
 * In a code project the new chat becomes the project's active chat and
 * the previous one history (lib/code/active-chat.ts). While that previous
 * chat is still replying no new one may start, and this page — a
 * redirect, with nowhere to say so — sends the person to the chat that
 * is busy, where the reply can be stopped; the buttons that call the API
 * directly say why instead.
 */
export default async function NewChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { slug } = await params;
  const { project: requestedProjectId } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    const query = requestedProjectId ? `?project=${encodeURIComponent(requestedProjectId)}` : '';
    redirect(signInUrl(tenant.id, `/${slug}/chat/new${query}`));
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;

  // A project the person cannot see is silently left out, as before: the
  // chat starts on its own rather than failing.
  let projectId: string | null = null;
  if (requestedProjectId && isUuid(requestedProjectId)) {
    const access = await resolveResourceAccess(
      db,
      tenant.id,
      session.subject,
      'chat_project',
      requestedProjectId
    );
    if (access) projectId = requestedProjectId;
  }
  const input = {
    tenantId: tenant.id,
    ownerSubject: session.subject,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
  };
  if (!projectId) {
    const chatId = await createChat(db, { ...input, projectId: null });
    redirect(`/${slug}/chat/${chatId}`);
  }
  const created = await createChatInProject(db, { ...input, projectId });
  if (created.ok) redirect(`/${slug}/chat/${created.val}`);
  const project = await getProjectRow(db, tenant.id, projectId);
  redirect(
    project?.activeChatId ? `/${slug}/chat/${project.activeChatId}` : `/${slug}/code/${projectId}`
  );
}
