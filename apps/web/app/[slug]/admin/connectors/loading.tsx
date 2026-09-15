import { PageSkeleton, Skeleton, SkeletonRows } from '@/components/skeleton';

/** Connector setup: the search box, then a divided list per category. */
export default function AdminConnectorsLoading() {
  return (
    <PageSkeleton label="Loading connectors…" width="4xl">
      <Skeleton className="mb-4 h-10 w-full rounded-md" />
      <div aria-hidden="true" className="space-y-6">
        {[4, 3, 3].map((rows, index) => (
          <div key={index}>
            <Skeleton className="mb-2 h-3 w-24" />
            <SkeletonRows count={rows} divided />
          </div>
        ))}
      </div>
    </PageSkeleton>
  );
}
