import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** The fallback for every tenant page without a loading.tsx of its own,
 * and the shape of the home page (actionable items) in particular: a
 * title, a line under it, and a stack of cards. */
export default function TenantLoading() {
  return (
    <PageSkeleton label="Loading…" actions={1}>
      <SkeletonCards count={3} lines={2} chips={2} />
    </PageSkeleton>
  );
}
