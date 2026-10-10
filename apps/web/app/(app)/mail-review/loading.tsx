import { PageSkeleton, Skeleton, SkeletonCards } from '@/components/skeleton';

/** Mail classification: the category tabs, then the messages. */
export default function MailReviewLoading() {
  return (
    <PageSkeleton label="Loading mail review…">
      <div aria-hidden="true" className="mb-4 flex flex-wrap gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-7 w-24 rounded-full" />
        ))}
      </div>
      <SkeletonCards count={3} lines={1} chips={1} />
    </PageSkeleton>
  );
}
