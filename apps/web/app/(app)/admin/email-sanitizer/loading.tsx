import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** The email sanitizer: rules, then cleaner scripts. */
export default function AdminEmailSanitizerLoading() {
  return (
    <PageSkeleton label="Loading email sanitizer…">
      <SkeletonCards count={3} lines={2} chips={1} />
    </PageSkeleton>
  );
}
