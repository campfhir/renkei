import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** The agents list. */
export default function AgentsLoading() {
  return (
    <PageSkeleton label="Loading agents…" actions={2}>
      <SkeletonCards count={3} lines={2} chips={3} />
    </PageSkeleton>
  );
}
