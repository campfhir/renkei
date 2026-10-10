import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** Agent oversight: every agent in the organization as a card. */
export default function AdminAgentsLoading() {
  return (
    <PageSkeleton label="Loading agent oversight…" width="4xl">
      <SkeletonCards count={4} lines={1} chips={3} />
    </PageSkeleton>
  );
}
