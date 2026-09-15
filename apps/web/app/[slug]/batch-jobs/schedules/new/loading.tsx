import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** The new schedule form. */
export default function BatchJobsSchedulesNewLoading() {
  return (
    <PageSkeleton label="Loading…" back subtitle={false}>
      <SkeletonForm fields={5} />
    </PageSkeleton>
  );
}
