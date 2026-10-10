import { PageSkeleton, SkeletonRows } from '@/components/skeleton';

/** Code services: a row per image rule. */
export default function CodeServicesLoading() {
  return (
    <PageSkeleton label="Loading image rules…">
      <SkeletonRows count={6} pill={false} />
    </PageSkeleton>
  );
}
