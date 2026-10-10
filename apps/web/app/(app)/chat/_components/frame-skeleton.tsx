/**
 * The loading shapes for pages inside the chat frame (chat/layout.tsx and
 * code/layout.tsx): the h-12 title bar under the top bar, then a thread,
 * an index of divided lists, or a page of bordered sections.
 *
 * Plain elements only, so each `loading.tsx` that uses these stays a
 * static, prefetchable fallback.
 */

import type { ReactNode } from 'react';
import { LoadingRegion, Skeleton, SkeletonRows, SkeletonText } from '@/components/skeleton';

/** The title bar every framed page opens with: a back chevron, a title, buttons at the right. */
export function FrameHeaderSkeleton({
  back = false,
  actions = 2,
}: {
  back?: boolean;
  actions?: number;
}): ReactNode {
  return (
    <div
      aria-hidden="true"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800"
    >
      {back ? <Skeleton className="h-6 w-6 rounded-md" /> : null}
      <Skeleton className="h-4 w-44 max-w-[50%]" />
      <div className="ml-auto flex gap-2">
        {Array.from({ length: actions }, (_, index) => (
          <Skeleton key={index} className="h-7 w-16 rounded-md" />
        ))}
      </div>
    </div>
  );
}

/**
 * A chat: a few turns — the person's bubble on the right, the
 * assistant's prose on the left — and the composer on the bottom edge.
 */
export function ThreadSkeleton(): ReactNode {
  return (
    <LoadingRegion label="Loading chat…" className="flex h-full min-h-0 flex-col">
      <FrameHeaderSkeleton actions={3} />
      <div aria-hidden="true" className="min-h-0 flex-1 overflow-hidden px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl rounded-br-sm" />
          <SkeletonText lines={4} className="max-w-[90%]" />
          <Skeleton className="ml-auto h-16 w-1/2 rounded-2xl rounded-br-sm" />
          <SkeletonText lines={2} className="max-w-[80%]" />
        </div>
      </div>
      <div aria-hidden="true" className="shrink-0 px-4 pb-4">
        <div className="mx-auto max-w-3xl">
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    </LoadingRegion>
  );
}

/**
 * An index in the frame — Projects, Prompt libraries, Code, Memory: the
 * title bar with its "New …" button, an introductory line, then one or
 * two groups, each an eyebrow over a divided list.
 */
export function FramedIndexSkeleton({
  label = 'Loading…',
  groups = [3, 2],
}: {
  label?: string;
  /** Rows per group. */
  groups?: number[];
}): ReactNode {
  return (
    <LoadingRegion label={label} className="flex h-full min-h-0 flex-col">
      <FrameHeaderSkeleton actions={1} />
      <div aria-hidden="true" className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto max-w-3xl space-y-6 p-4">
          <SkeletonText lines={2} className="max-w-[80%]" />
          {groups.map((rows, index) => (
            <div key={index}>
              <Skeleton className="mb-2 h-3 w-16" />
              <SkeletonRows count={rows} divided />
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

/**
 * A project or a library: the title bar with a back chevron, then a
 * column of bordered sections (About, Files, Memory, Chats…).
 */
export function FramedSectionsSkeleton({
  label = 'Loading…',
  sections = 4,
  actions = 2,
  aside = false,
}: {
  label?: string;
  sections?: number;
  actions?: number;
  /** A file tree on the left, as a code project has. */
  aside?: boolean;
}): ReactNode {
  const column = (
    <div className="space-y-4">
      {Array.from({ length: sections }, (_, index) => (
        <div key={index} className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <Skeleton className="mb-3 h-4 w-28" />
          <SkeletonText lines={index % 2 === 0 ? 3 : 2} />
        </div>
      ))}
    </div>
  );
  return (
    <LoadingRegion label={label} className="flex h-full min-h-0 flex-col">
      <FrameHeaderSkeleton back actions={actions} />
      <div aria-hidden="true" className="min-h-0 flex-1 overflow-hidden">
        {aside ? (
          <div className="mx-auto max-w-6xl p-4 lg:grid lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:items-start lg:gap-4">
            <div className="mb-4 rounded-lg border border-gray-200 p-4 lg:mb-0 dark:border-gray-800">
              <Skeleton className="mb-3 h-4 w-12" />
              <div className="space-y-2">
                {['w-2/3', 'w-1/2', 'w-3/5', 'w-1/2', 'w-2/5', 'w-1/3'].map((width, index) => (
                  <Skeleton key={index} className={`h-3 ${width} ${index > 1 ? 'ml-3' : ''}`} />
                ))}
              </div>
            </div>
            {column}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl p-4">{column}</div>
        )}
      </div>
    </LoadingRegion>
  );
}
