import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** One connector's settings form. */
export default function AdminConnectorsConfigkeyLoading() {
  return (
    <PageSkeleton label="Loading connector…" back>
      <div
        aria-hidden="true"
        className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
      >
        <SkeletonForm fields={4} />
      </div>
    </PageSkeleton>
  );
}
