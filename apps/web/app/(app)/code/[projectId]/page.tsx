import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveProjectAccess } from '@/lib/chat/access';
import { loadCodeProjectCore } from '@/lib/code/project-view';
import ProjectView from '../../chat/_components/project-view';
import { CodeRail, EnvironmentCardSkeleton } from '../_components/code-sections';
import { CheckoutStrip, CheckoutStripSkeleton, Environment, Readme } from '../_components/code-islands';
import ReadmeSection from '../_components/readme-section';
import { DEFAULT_CODE_INSTRUCTIONS } from '@/lib/code/default-instructions';

/**
 * One code project, laid out by how often each part is touched: the
 * repository's checkout as a strip under the header, the chats first
 * (what the page is opened for), a rail of pulls, commits, CI, services
 * and the environment beside them on a wide screen and below them on a
 * narrow one, then everything a chat project's page has — README,
 * instructions, memory, sharing. Editors change it; viewers read it and
 * start their own chats in it.
 *
 * The page paints as soon as the database has answered — the project,
 * its chats, its spend — and streams in the three parts that cross the
 * network behind Suspense boundaries of their own: the checkout's state
 * and the environment's names from the sandbox worker, the README from
 * the git host (code-islands.tsx). The rail's other cards read their own
 * data in the browser already. A slow worker or host no longer holds the
 * whole page.
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
  const access = await resolveProjectAccess(session.subject, projectId);
  if (!access) notFound();
  const core = await loadCodeProjectCore(session.subject, projectId, access);
  if (!core) notFound();
  const canEdit = core.view.role !== 'viewer';
  // The elements handed to the client view carry keys: React checks
  // server-made elements it finds among siblings on the client the way it
  // checks a list, and a key is what satisfies it.
  return (
    <ProjectView
      key={projectId}
      initial={core.view}
      variant="code"
      defaultInstructions={DEFAULT_CODE_INSTRUCTIONS}
      readme={
        <Suspense key="readme" fallback={<ReadmeSection readme={null} loading />}>
          <Readme viewerSubject={session.subject} project={core.project} />
        </Suspense>
      }
      usage={core.usage}
      download={{ repoFullName: core.repoFullName }}
      strip={
        <Suspense key="strip" fallback={<CheckoutStripSkeleton repoFullName={core.repoFullName} />}>
          <CheckoutStrip projectId={projectId} core={core} />
        </Suspense>
      }
      rail={
        <CodeRail
          key="rail"
          projectId={projectId}
          code={{ repoProvider: core.repoProvider, branch: core.branch, enabled: core.enabled }}
          environment={
            <Suspense fallback={<EnvironmentCardSkeleton />}>
              <Environment
                projectId={projectId}
                project={core.project}
                enabled={core.enabled}
                canEdit={canEdit}
                envProblems={envProblems ? envProblems.split('\n').filter(Boolean) : []}
              />
            </Suspense>
          }
        />
      }
    />
  );
}
