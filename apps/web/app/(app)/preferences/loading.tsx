import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** Preferences: one card per group of settings. */
export default function PreferencesLoading() {
  return (
    <PageSkeleton label="Loading preferences…" width="5xl">
      <div aria-hidden="true" className="space-y-6">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950"
          >
            <SkeletonForm fields={2} />
          </div>
        ))}
      </div>
    </PageSkeleton>
  );
}
