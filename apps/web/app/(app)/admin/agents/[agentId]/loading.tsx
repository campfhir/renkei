import { PageSkeleton, SkeletonCards, SkeletonText } from '@/components/skeleton';

/** One agent, as an operator sees it. */
export default function AdminAgentsAgentidLoading() {
  return (
    <PageSkeleton label="Loading agent…" back actions={1}>
      <SkeletonText lines={2} className="mb-6" />
      <SkeletonCards count={2} lines={2} chips={2} />
    </PageSkeleton>
  );
}
