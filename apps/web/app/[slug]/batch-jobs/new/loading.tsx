import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** The new batch job form. */
export default function BatchJobsNewLoading() {
  return (
    <PageSkeleton label="Loading…" back subtitle={false}>
      <SkeletonForm fields={5} />
    </PageSkeleton>
  );
}
