import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveProjectAccess } from '@/lib/chat/access';
import { loadCodeProjectView } from '@/lib/code/project-view';
import ProjectView from '../../chat/_components/project-view';
import { CodeRail, CodeRepoStrip } from '../_components/code-sections';
import { DEFAULT_CODE_INSTRUCTIONS } from '@/lib/code/default-instructions';

/**
 * One code project, laid out by how often each part is touched: the
 * repository's checkout as a strip under the header, the chats first
 * (what the page is opened for), a rail of pulls, commits, CI, services
 * and the environment beside them on a wide screen and below them on a
 * narrow one, then everything a chat project's page has — README,
 * instructions, memory, sharing. Editors change it; viewers read it and
 * start their own chats in it.
 */
export default async function CodeProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ envProblems?: string }>;
}) {
  const { projectId } = await params;
  const { envProblems } = await searchParams;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/code/${projectId}`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  const access = await resolveProjectAccess(db, session.subject, projectId);
  if (!access) notFound();
  const view = await loadCodeProjectView(db, session.subject, projectId, access);
  if (!view) notFound();
  // The two elements handed to the client view carry keys: React checks
  // server-made elements it finds among siblings on the client the way it
  // checks a list, and a key is what satisfies it.
  return (
    <ProjectView
      key={projectId}
      initial={view}
      variant="code"
      defaultInstructions={DEFAULT_CODE_INSTRUCTIONS}
      readme={view.code.readme}
      usage={view.code.usage}
      strip={
        <CodeRepoStrip key="strip" projectId={projectId} code={view.code} />
      }
      rail={
        <CodeRail
          key="rail"
          projectId={projectId}
          code={view.code}
          canEdit={view.role !== 'viewer'}
          envProblems={envProblems ? envProblems.split('\n').filter(Boolean) : []}
        />
      }
    />
  );
}
