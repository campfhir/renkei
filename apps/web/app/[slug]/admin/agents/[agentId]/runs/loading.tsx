import { PageSkeleton, SkeletonPills, SkeletonRows } from '@/components/skeleton';

/** An agent's runs, as an operator sees them. */
export default function AdminAgentRunsLoading() {
  return (
    <PageSkeleton label="Loading runs…" back subtitle={false}>
      <SkeletonPills count={7} />
      <SkeletonRows count={8} />
    </PageSkeleton>
  );
}
