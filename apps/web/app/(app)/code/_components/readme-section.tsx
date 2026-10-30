'use client';

/**
 * A code project's README, in place of a typed description — the
 * repository describes itself. Folded to a preview with "Read more", in
 * a `<details>` that can be closed altogether. The text comes from the
 * repository's git host, so the page streams this section in behind a
 * Suspense boundary: `loading` is what the fallback shows while it is on
 * its way, and `readme` null afterwards means the repository has none.
 */

import { useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { LoadingLine } from '@/components/skeleton';
import Markdown from '../../chat/_components/markdown';

const sectionClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';

export default function ReadmeSection({
  readme,
  loading = false,
}: {
  readme: { path: string; text: string } | null;
  loading?: boolean;
}) {
  const [readmeOpen, setReadmeOpen] = useState(false);
  return (
    <section className={sectionClass} aria-busy={loading || undefined}>
      <details open className="group">
        <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
          <Icon
            path={ICONS.chevron}
            className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-90"
          />
          <span className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">README</h2>
            <p className="text-xs text-gray-500">
              {readme
                ? `${readme.path} on the project’s branch, as its host has it.`
                : 'The repository’s README, when it has one.'}
            </p>
          </span>
        </summary>
        <div className="mt-3">
          {loading ? (
            <LoadingLine size="xs" label="Reading the README…" />
          ) : readme ? (
            <>
              <div
                className={
                  readmeOpen
                    ? undefined
                    : 'relative max-h-40 overflow-hidden after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-12 after:bg-gradient-to-t after:from-white after:to-transparent dark:after:from-gray-950'
                }
                data-testid="project-readme-body"
                data-expanded={readmeOpen ? 'true' : undefined}
              >
                <Markdown text={readme.text} />
              </div>
              <button
                type="button"
                onClick={() => setReadmeOpen((value) => !value)}
                aria-expanded={readmeOpen}
                className="mt-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                {readmeOpen ? 'Show less' : 'Read more'}
              </button>
            </>
          ) : (
            <p className="text-sm text-gray-500">No README was found in the repository.</p>
          )}
        </div>
      </details>
    </section>
  );
}
