import { PageSkeleton, SkeletonPills, SkeletonRows } from '@/components/skeleton';

/** Batch jobs: the status pills, then a row per job. */
export default function BatchJobsLoading() {
  return (
    <PageSkeleton label="Loading batch jobs…" actions={2}>
      <SkeletonPills count={5} />
      <SkeletonRows count={6} />
    </PageSkeleton>
  );
}
