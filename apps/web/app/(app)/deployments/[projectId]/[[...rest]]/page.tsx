import { redirect } from 'next/navigation';

/**
 * A project's page under Deployments (and its Pipeline and Runs &
 * variables tabs) moved to the code project's Environments page. Old
 * links land there.
 */
export default async function MovedToEnvironments({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<never> {
  const { projectId } = await params;
  redirect(`/code/${projectId}/environments`);
}
