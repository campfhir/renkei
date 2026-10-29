import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listAccessibleLibraries } from '@/lib/chat/prompts';
import LibrariesIndex from '../_components/libraries-index';

/** Prompt libraries: mine, and the ones shared with me. */
export default async function PromptLibrariesPage() {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/prompts`));
  const libraries = await listAccessibleLibraries(session.subject);
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
