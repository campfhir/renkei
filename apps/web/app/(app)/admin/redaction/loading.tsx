import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** Sensitive data settings. */
export default function AdminRedactionLoading() {
  return (
    <PageSkeleton label="Loading…">
      <SkeletonForm fields={4} />
    </PageSkeleton>
  );
}
