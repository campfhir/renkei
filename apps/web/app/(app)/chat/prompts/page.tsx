import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listAccessibleLibraries } from '@/lib/chat/prompts';
import LibrariesIndex from '../_components/libraries-index';
import { noteLogUser } from '@/lib/log-context';

/** Prompt libraries: mine, and the ones shared with me. */
export default async function PromptLibrariesPage() {
  const session = await getSessionFromCookies();
  if (session) noteLogUser(session.subject);
  if (!session) redirect(signInUrl(`/chat/prompts`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const libraries = await listAccessibleLibraries(dbResult.val, session.subject);
  return (
    <LibrariesIndex
      libraries={libraries.map(({ library, role }) => ({
        id: library.id,
        name: library.name,
        description: library.description,
        role,
      }))}
    />
  );
}
