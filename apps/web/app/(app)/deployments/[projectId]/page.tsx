import DeploymentApp from './deployment-app';
import { appProject } from './app-project';

/** One app's deployments: its environments, promoting one to the next by merge, and its history. */
export default async function DeploymentAppPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<React.ReactNode> {
  const { projectId } = await params;
  const app = await appProject(projectId, `/deployments/${projectId}`);
  return <DeploymentApp projectId={app.id} />;
}
