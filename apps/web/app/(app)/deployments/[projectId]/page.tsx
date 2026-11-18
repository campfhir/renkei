import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import DeploymentApp from './deployment-app';

/** One app's deployments: its environments, promoting one to the next by merge, and its history. */
export default async function DeploymentAppPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<React.ReactNode> {
  const { projectId } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/deployments/${projectId}`));
  return <DeploymentApp projectId={projectId} />;
}
