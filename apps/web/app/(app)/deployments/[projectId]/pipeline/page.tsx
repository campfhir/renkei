import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import PipelineBuilder from '../../_components/pipeline-builder';
import { appProject } from '../app-project';

/**
 * The app's pipeline, built from the organization's blocks and the
 * project's own; editors change it — by hand or with the assistant —
 * viewers read it. Operators can have the assistant make a project's
 * block a building block for every project.
 */
export default async function AppPipelinePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const app = await appProject(projectId, `/deployments/${projectId}/pipeline`);
  const operator = (await checkAccess([ROLE_OPERATOR])) !== null;
  return <PipelineBuilder projectId={app.id} host={app.host} operator={operator} />;
}
