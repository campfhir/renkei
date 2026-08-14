'use client';

/**
 * Rendering a chunk's text with its structure visible.
 *
 * Some connectors now write markdown — a Jira issue arrives as a heading, a
 * description, a field list and its comments. Rendered as flat text that reads
 * `## Fields` with the hashes showing, which is worse than the prose it
 * replaced. The parsing rules, and why they are as narrow as they are, live in
 * `content-blocks.ts`.
 */

import React from 'react';
import { parseBlocks, withoutEchoedTitle } from './content-blocks';

/** Heading level → how it should look. Level 1 is the document's own title. */
const HEADING_CLASS: Record<number, string> = {
  1: 'mt-3 text-sm font-semibold',
  2: 'mt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400',
  3: 'mt-2 text-sm font-medium',
};

export default function StructuredContent({
  text,
  title,
  renderText,
}: {
  text: string;
  /** The card's heading, so the body does not repeat it. */
  title: string;
  /** How to render a run of plain text — the search-term highlighter. */
  renderText: (value: string) => React.ReactNode;
}) {
  const blocks = withoutEchoedTitle(parseBlocks(text), title);

  return (
    <div className="mt-1 text-sm text-gray-700 dark:text-gray-300">
      {blocks.map((block, index) =>
        block.kind === 'heading' ? (
          <p
            key={index}
            className={`${HEADING_CLASS[block.level] ?? HEADING_CLASS[3]} break-words first:mt-0`}
          >
            {renderText(block.text)}
          </p>
        ) : (
          <p key={index} className="mt-1 whitespace-pre-wrap break-words first:mt-0">
            {renderText(block.text)}
          </p>
        )
      )}
    </div>
  );
}
