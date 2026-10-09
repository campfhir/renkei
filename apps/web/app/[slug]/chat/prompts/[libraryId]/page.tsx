import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getLibrary, listPrompts } from '@/lib/chat/prompts';
import LibraryView from '../../_components/library-view';

/** One prompt library: its prompts, editable by editors, shareable by the owner. */
export default async function PromptLibraryPage({
  params,
}: {
  params: Promise<{ slug: string; libraryId: string }>;
}) {
  const { slug, libraryId } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/prompts/${libraryId}`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  const access = await resolveResourceAccess(
    db,
    session.subject,
    'prompt_library',
    libraryId
  );
  const library = access ? await getLibrary(db, libraryId) : null;
  if (!access || !library) notFound();
  const prompts = await listPrompts(db, libraryId);
  return (
    <LibraryView
      key={libraryId}
      slug={slug}
      library={{
        id: library.id,
        name: library.name,
        description: library.description,
        role: access.role,
      }}
      prompts={prompts.map((prompt) => ({
        id: prompt.id,
        title: prompt.title,
        body: prompt.body,
        updatedAt: prompt.updatedAt.toISOString(),
      }))}
    />
  );
}
