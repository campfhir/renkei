import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** One Mirth instance's management page: its connection form. */
export default function MirthInstanceLoading() {
  return (
    <PageSkeleton label="Loading Mirth instance…">
      <SkeletonForm fields={5} />
    </PageSkeleton>
  );
}
