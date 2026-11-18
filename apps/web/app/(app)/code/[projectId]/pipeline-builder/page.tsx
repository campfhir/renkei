import { redirect } from 'next/navigation';

/**
 * A code project's pipeline builder moved to the project's page under Deployments,
 * where its pipeline, runs, variables and deployments are together. Old
 * links land there.
 */
export default async function MovedToPipeline({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<never> {
  const { projectId } = await params;
  redirect(`/deployments/${projectId}/pipeline`);
}
