import { PageSkeleton, SkeletonPills, SkeletonRows } from '@/components/skeleton';

/** An agent's runs: the status pills, then a row per run. */
export default function AgentRunsLoading() {
  return (
    <PageSkeleton label="Loading runs…" back subtitle={false}>
      <SkeletonPills count={7} />
      <SkeletonRows count={8} />
    </PageSkeleton>
  );
}
