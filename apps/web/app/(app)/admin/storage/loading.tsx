import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** Storage settings. */
export default function AdminStorageLoading() {
  return (
    <PageSkeleton label="Loading storage…">
      <SkeletonForm fields={4} />
    </PageSkeleton>
  );
}
