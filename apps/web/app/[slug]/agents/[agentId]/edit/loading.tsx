import { PageSkeleton, Skeleton, SkeletonForm } from '@/components/skeleton';

/** The agent builder with an existing agent in it. */
export default function AgentsAgentidEditLoading() {
  return (
    <PageSkeleton label="Loading agent…" actions={1}>
      <SkeletonForm fields={2} />
      <Skeleton className="mt-6 h-64 w-full rounded-xl" />
    </PageSkeleton>
  );
}
