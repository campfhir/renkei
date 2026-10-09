import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** Sites. */
export default function AdminSitesLoading() {
  return (
    <PageSkeleton label="Loading sites…">
      <SkeletonCards count={3} lines={1} chips={1} />
    </PageSkeleton>
  );
}
