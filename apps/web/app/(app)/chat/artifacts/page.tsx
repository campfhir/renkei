import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listLibrary } from '@/lib/chat/artifact-library';
import { listAccessibleProjectIds } from '@/lib/chat/access';
import ArtifactsIndex from '../_components/artifacts-index';

/**
 * Artifacts: the files this person uploaded and the files their chats
 * generated, with where each is used; and the ones shared with them
 * (docs/artifacts-design.md). `?artifact=<id>` opens one — the link a
 * notification carries.
 */
export default async function ArtifactsPage({
  searchParams,
}: {
  searchParams: Promise<{ artifact?: string }>;
}) {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/artifacts`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  const { artifact } = await searchParams;
  const [artifacts, uploads, projectIds] = await Promise.all([
    listLibrary(db, session.subject),
    tenantBlobStoreConfigured(),
    listAccessibleProjectIds(db, session.subject),
  ]);
  const projects =
    projectIds.length > 0
      ? await db
          .selectFrom('chat_projects')
          .select(['id', 'name', 'kind'])
          .where('id', 'in', projectIds)
          .orderBy('name', 'asc')
          .execute()
      : [];
  return (
    <ArtifactsIndex
      initial={artifacts}
      uploads={uploads}
      projects={projects}
      selectedId={artifact ?? null}
    />
  );
}
