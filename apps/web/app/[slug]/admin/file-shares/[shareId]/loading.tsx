import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** One file share's connection settings. */
export default function AdminFileSharesShareidLoading() {
  return (
    <PageSkeleton label="Loading file share…" back>
      <SkeletonForm fields={5} />
    </PageSkeleton>
  );
}
