import {
  LoadingRegion,
  Skeleton,
  SkeletonCard,
  SkeletonHeading,
  SkeletonRows,
  SkeletonText,
} from '@/components/skeleton';

/**
 * One agent: the title band, its description, then the two columns — the
 * steps on the left, the runs card and the collapsible panels on the right.
 */
export default function AgentLoading() {
  return (
    <LoadingRegion label="Loading agent…" className="mx-auto max-w-5xl">
      <SkeletonHeading back actions={2} subtitle={false} className="mb-4" />
      <div aria-hidden="true" className="mb-6 rounded-md bg-gray-50 p-3 dark:bg-gray-900">
        <SkeletonText lines={2} />
      </div>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
        <aside aria-hidden="true" className="mb-6 lg:col-start-2 lg:row-start-1 lg:mb-0">
          <SkeletonCard lines={1} chips={2} className="mb-3" />
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
              >
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
          </div>
        </aside>
        <div aria-hidden="true" className="lg:col-start-1 lg:row-start-1">
          <Skeleton className="mb-2 h-4 w-16" />
          <SkeletonRows count={5} pill={false} />
        </div>
      </div>
    </LoadingRegion>
  );
}
