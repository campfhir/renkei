import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** One schedule's form. */
export default function BatchJobsSchedulesScheduleidLoading() {
  return (
    <PageSkeleton label="Loading schedule…" back subtitle={false}>
      <SkeletonForm fields={5} />
    </PageSkeleton>
  );
}
