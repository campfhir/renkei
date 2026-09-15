import { PageSkeleton, Skeleton, SkeletonForm } from '@/components/skeleton';

/** The agent builder, before its skills and models arrive. */
export default function AgentsNewLoading() {
  return (
    <PageSkeleton label="Loading…" actions={0}>
      <SkeletonForm fields={2} />
      <Skeleton className="mt-6 h-64 w-full rounded-xl" />
    </PageSkeleton>
  );
}
