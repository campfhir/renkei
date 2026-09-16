import { PageSkeleton, SkeletonRows } from '@/components/skeleton';

/** The organization's Mirth instances: a row per instance. */
export default function MirthInstancesLoading() {
  return (
    <PageSkeleton label="Loading Mirth instances…">
      <SkeletonRows count={3} pill={false} />
    </PageSkeleton>
  );
}
