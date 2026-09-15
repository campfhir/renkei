import { PageSkeleton, SkeletonRows } from '@/components/skeleton';

/** The organization's file shares: a row per share. */
export default function FileSharesLoading() {
  return (
    <PageSkeleton label="Loading file shares…">
      <SkeletonRows count={3} pill={false} />
    </PageSkeleton>
  );
}
