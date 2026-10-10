import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** Organization settings. */
export default function AdminSettingsLoading() {
  return (
    <PageSkeleton label="Loading settings…">
      <SkeletonForm fields={4} />
    </PageSkeleton>
  );
}
