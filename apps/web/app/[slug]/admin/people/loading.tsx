import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** People: a card per person. */
export default function AdminPeopleLoading() {
  return (
    <PageSkeleton label="Loading people…">
      <SkeletonCards count={4} lines={1} chips={2} />
    </PageSkeleton>
  );
}
