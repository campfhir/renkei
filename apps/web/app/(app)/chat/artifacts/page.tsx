import { notFound, redirect } from 'next/navigation';
import { after } from 'next/server';
import { getDatabase } from '@renkei/db';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { getOrgSettings } from '@renkei/settings';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { parseLibraryQuery } from '@/lib/chat/artifact-library-params';
import { queryLibrary } from '@/lib/chat/artifact-library-query';
import { digestPendingArtifacts } from '@/lib/chat/artifact-digest';
import { getAttachments } from '@/lib/chat/attachments';
import { listAccessibleProjectIds } from '@/lib/chat/access';
import ArtifactsIndex from '../_components/artifacts-index';

/**
 * Artifacts: the files this person uploaded and the files their chats
 * generated, with where each is used; and the ones shared with them
 * (docs/artifacts-design.md). One page at a time, chosen in the
 * database by what the URL asks for (artifact-library-params.ts):
 * `?q=` searches names and digests, `show`, `project` and `page` narrow
 * and turn; `?artifact=<id>` opens one — the link a notification
 * carries — on the page it sits on. With the organization's digest
 * switch on, rows on the page still waiting for their digest are asked
 * for after the response, a few at a time.
 */
export default async function ArtifactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/artifacts`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  const query = parseLibraryQuery(await searchParams);
  const [page, uploads, projectIds, settings] = await Promise.all([
    queryLibrary(db, session.subject, query),
    tenantBlobStoreConfigured(),
    listAccessibleProjectIds(db, session.subject),
    getOrgSettings(),
  ]);
  const digests = settings.ok && settings.val.artifactDigestEnabled;
  const projects =
    projectIds.length > 0
      ? await db
          .selectFrom('chat_projects')
          .select(['id', 'name', 'kind'])
          .where('id', 'in', projectIds)
          .orderBy('name', 'asc')
          .execute()
      : [];
  const undigested = page.artifacts
    .filter((item) => item.digestStatus === 'pending' || item.digestStatus === 'running')
    .map((item) => item.id);
  if (digests && undigested.length > 0) {
    const subject = session.subject;
    after(async () => {
      await digestPendingArtifacts(db, subject, await getAttachments(db, undigested));
    });
  }
  return (
    <ArtifactsIndex
      page={page}
      query={query}
      uploads={uploads}
      digests={digests}
      projects={projects}
      selectedId={query.focus}
    />
  );
}
