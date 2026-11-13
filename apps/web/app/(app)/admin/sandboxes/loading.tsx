import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** Sandbox setup. */
export default function AdminSandboxesLoading() {
  return (
    <PageSkeleton label="Loading sandboxes…">
      <SkeletonForm fields={6} />
    </PageSkeleton>
  );
}
