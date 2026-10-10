import { PageSkeleton, SkeletonRows } from '@/components/skeleton';

/** The organization's ADManager Plus instances: a row per instance. */
export default function AdManagerInstancesLoading() {
  return (
    <PageSkeleton label="Loading ADManager Plus instances…">
      <SkeletonRows count={3} pill={false} />
    </PageSkeleton>
  );
}
