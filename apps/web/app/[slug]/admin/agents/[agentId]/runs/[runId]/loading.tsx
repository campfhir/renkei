import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** One run, as an operator sees it. */
export default function AdminAgentsAgentidRunsRunidLoading() {
  return (
    <PageSkeleton label="Loading run…" back>
      <SkeletonCards count={3} lines={3} chips={0} />
    </PageSkeleton>
  );
}
