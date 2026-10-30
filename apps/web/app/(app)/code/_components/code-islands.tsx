import { LoadingLine } from '@/components/skeleton';
import type { ProjectRow } from '@/lib/chat/projects';
import {
  loadCodeCheckoutState,
  loadCodeEnvironment,
  loadCodeReadme,
  type CodeProjectCore,
} from '@/lib/code/project-view';
import { CodeRepoStrip, EnvironmentCard } from './code-sections';
import ReadmeSection from './readme-section';

/**
 * The parts of a code project's page that cross the network — the clone
 * as the sandbox worker has it, the environment's names from the same
 * worker, the README from the repository's git host — as server
 * components of their own, each awaited inside its own Suspense
 * boundary (code/[projectId]/page.tsx) so the page paints from the
 * database first and these arrive as they are answered. Each renders
 * the same client component the page always showed, with the data as
 * its props.
 */

export async function CheckoutStrip({
  projectId,
  core,
}: {
  projectId: string;
  core: CodeProjectCore;
}) {
  const checkout = await loadCodeCheckoutState(core.project);
  return (
    <CodeRepoStrip
      projectId={projectId}
      code={{
        ...checkout,
        repoFullName: core.repoFullName,
        repoProvider: core.repoProvider,
        enabled: core.enabled,
      }}
    />
  );
}

/** The strip while the worker answers: the repository's name is known already. */
export function CheckoutStripSkeleton({ repoFullName }: { repoFullName: string }) {
  return (
    <section
      className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-800 dark:bg-gray-900/40"
      data-testid="code-repo-strip"
      aria-busy="true"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold">Repository</h2>
        <span className="font-mono text-sm">{repoFullName}</span>
      </div>
      <LoadingLine size="xs" className="mt-1" label="Checking the checkout…" />
    </section>
  );
}

export async function Environment({
  projectId,
  project,
  enabled,
  canEdit,
  envProblems,
}: {
  projectId: string;
  project: ProjectRow;
  enabled: boolean;
  canEdit: boolean;
  envProblems: string[];
}) {
  const env = await loadCodeEnvironment(project);
  return (
    <EnvironmentCard
      projectId={projectId}
      env={env}
      enabled={enabled}
      canEdit={canEdit}
      envProblems={envProblems}
    />
  );
}

export async function Readme({
  viewerSubject,
  project,
}: {
  viewerSubject: string;
  project: ProjectRow;
}) {
  const readme = await loadCodeReadme(viewerSubject, project);
  return <ReadmeSection readme={readme} />;
}
