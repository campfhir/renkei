import { notFound, redirect } from 'next/navigation';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import EnvironmentsPage from '../../_components/environments-page';
import { readTab } from '../../_components/environments-page.model';
import type { VariableAsk } from '../../_components/variables-editor';

/**
 * A code project's Environments: the environments it deploys to, the
 * branches assigned to each, and — for the branch picked — its pipeline
 * built from blocks, its runs on the host, and the variables they get.
 * Editors change them; viewers read. Only a repository on Bitbucket or
 * GitHub has pipelines.
 *
 * The address carries what is picked: `?env=NAME&branch=BRANCH&tab=…`.
 * `&set=NAME&scope=environment|repository&secret=1` (the pipeline
 * builder's "Set it") opens the Variables tab on that variable's row,
 * ready for its value.
 */
export default async function CodeProjectEnvironmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const one = (key: string) => {
    const value = query[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/code/${projectId}/environments`));
  const access = await resolveResourceAccess(session.subject, 'chat_project', projectId);
  if (!access) notFound();
  const project = await getProjectRow(projectId);
  if (!project || project.kind !== 'code' || !project.repo) notFound();
  const host =
    project.repo.provider === GITHUB
      ? 'github'
      : project.repo.provider === ATLASSIAN_BITBUCKET
        ? 'bitbucket'
        : null;
  if (!host) notFound();
  const operator = (await checkAccess([ROLE_OPERATOR])) !== null;
  const set = one('set');
  const ask: VariableAsk | null =
    set && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(set)
      ? {
          name: set,
          scope: one('scope') === 'repository' ? 'repository' : 'environment',
          secured: one('secret') === '1',
        }
      : null;
  const initial = {
    environment: one('env'),
    branch: one('branch'),
    tab: ask ? ('variables' as const) : readTab(one('tab')),
  };
  return (
    <EnvironmentsPage
      // A link that picks something else (the builder's "Set it") starts the page over on it.
      key={JSON.stringify([initial, ask])}
      projectId={project.id}
      projectName={project.name}
      repoFullName={project.repo.fullName}
      host={host}
      canEdit={access.role !== 'viewer'}
      operator={operator}
      initial={initial}
      ask={ask}
    />
  );
}
