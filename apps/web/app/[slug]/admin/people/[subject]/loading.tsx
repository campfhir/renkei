import { PageSkeleton, Skeleton, SkeletonRows, SkeletonStats } from '@/components/skeleton';

/** One person: their groups, connectors, agents, then their usage. */
export default function PersonLoading() {
  return (
    <PageSkeleton label="Loading person…" back>
      <div aria-hidden="true" className="space-y-6">
        <div>
          <Skeleton className="mb-2 h-3 w-24" />
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-6 w-24 rounded-full" />
            ))}
          </div>
        </div>
        <div>
          <Skeleton className="mb-2 h-3 w-24" />
          <SkeletonRows count={2} />
        </div>
        <div>
          <Skeleton className="mb-2 h-3 w-16" />
          <SkeletonRows count={3} divided />
        </div>
        <div>
          <Skeleton className="mb-2 h-3 w-16" />
          <SkeletonStats count={4} className="mb-4" />
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <Skeleton className="mb-3 h-4 w-32" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      </div>
    </PageSkeleton>
  );
}
