import { redirect } from 'next/navigation';

/**
 * A code project's Actions (GitHub) moved to the project's page under Deployments,
 * where its pipeline, runs, variables and deployments are together. Old
 * links land there.
 */
export default async function MovedToRuns({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<never> {
  const { projectId } = await params;
  redirect(`/deployments/${projectId}/runs`);
}
