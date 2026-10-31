import { PageSkeleton, SkeletonPills, SkeletonRows } from '@/components/skeleton';

/** Changes: the connector filter, then a row per change. */
export default function ChangesLoading() {
  return (
    <PageSkeleton label="Loading changes…">
      <SkeletonPills count={3} />
      <SkeletonRows count={6} />
    </PageSkeleton>
  );
}
