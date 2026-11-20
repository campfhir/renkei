import ActionsPage from '../../_components/actions-page';
import PipelinesPage from '../../_components/pipelines-page';
import { readVariableAsk } from '../../_components/pipelines-page.model';
import { appProject } from '../app-project';

/**
 * The app's runs and variables on its host: Bitbucket Pipelines or GitHub
 * Actions — the recent runs, the switch, the pipeline file, and the
 * variables runs get. Editors change the setup; viewers read it.
 *
 * `?set=NAME&in=ENVIRONMENT&secret=1` (the pipeline builder's "Set it")
 * opens that set's box on the variable's line, ready for its value.
 */
export default async function AppRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const ask = readVariableAsk({
    get: (key) => {
      const value = query[key];
      return typeof value === 'string' ? value : null;
    },
  });
  const app = await appProject(projectId, `/deployments/${projectId}/runs`);
  const props = {
    projectId: app.id,
    repoFullName: app.repo,
    branch: app.branch,
    canEdit: app.canEdit,
    ask,
  };
  return app.host === 'github' ? <ActionsPage {...props} /> : <PipelinesPage {...props} />;
}
