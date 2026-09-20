import { PageSkeleton, Skeleton, SkeletonTable } from '@/components/skeleton';

/** The tutorials report: the per-tour totals, then the people. */
export default function AdminTutorialsLoading() {
  return (
    <PageSkeleton label="Loading tutorials report…" width="full">
      <div aria-hidden="true" className="space-y-8">
        <div>
          <Skeleton className="mb-3 h-3.5 w-16" />
          <SkeletonTable rows={5} columns={6} />
        </div>
        <div>
          <Skeleton className="mb-3 h-3.5 w-20" />
          <SkeletonTable rows={4} columns={7} />
        </div>
      </div>
    </PageSkeleton>
  );
}
