import PipelineBuilder from '../../_components/pipeline-builder';
import { appProject } from '../app-project';

/** The app's pipeline, built from the organization's blocks; editors change it, viewers read it. */
export default async function AppPipelinePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const app = await appProject(projectId, `/deployments/${projectId}/pipeline`);
  return <PipelineBuilder projectId={app.id} host={app.host} />;
}
