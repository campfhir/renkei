import { redirect } from 'next/navigation';

/**
 * A code project's pipelines, runs and variables are on its Environments
 * page, by branch. Old links land there.
 */
export default async function MovedToEnvironments({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<never> {
  const { projectId } = await params;
  redirect(`/code/${projectId}/environments`);
}
