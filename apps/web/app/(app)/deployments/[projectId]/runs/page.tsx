import ActionsPage from '../../_components/actions-page';
import PipelinesPage from '../../_components/pipelines-page';
import { appProject } from '../app-project';

/**
 * The app's runs and variables on its host: Bitbucket Pipelines or GitHub
 * Actions — the recent runs, the switch, the pipeline file, and the
 * variables runs get. Editors change the setup; viewers read it.
 */
export default async function AppRunsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const app = await appProject(projectId, `/deployments/${projectId}/runs`);
  const props = {
    projectId: app.id,
    repoFullName: app.repo,
    branch: app.branch,
    canEdit: app.canEdit,
  };
  return app.host === 'github' ? <ActionsPage {...props} /> : <PipelinesPage {...props} />;
}
