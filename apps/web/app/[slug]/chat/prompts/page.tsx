import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listAccessibleLibraries } from '@/lib/chat/prompts';
import LibrariesIndex from '../_components/libraries-index';

/** Prompt libraries: mine, and the ones shared with me. */
export default async function PromptLibrariesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/prompts`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const libraries = await listAccessibleLibraries(dbResult.val, session.subject);
  return (
    <LibrariesIndex
      slug={slug}
      libraries={libraries.map(({ library, role }) => ({
        id: library.id,
        name: library.name,
        description: library.description,
        role,
      }))}
    />
  );
}
