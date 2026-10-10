import { PageSkeleton, SkeletonPills, SkeletonRows, SkeletonText } from '@/components/skeleton';

/** One batch job: its summary panel, the item status pills, then its items. */
export default function BatchJobLoading() {
  return (
    <PageSkeleton label="Loading batch job…" back subtitle={false}>
      <div
        aria-hidden="true"
        className="mb-6 rounded-md border border-gray-200 p-3 dark:border-gray-800"
      >
        <SkeletonText lines={5} />
      </div>
      <SkeletonPills count={6} />
      <SkeletonRows count={6} />
    </PageSkeleton>
  );
}
