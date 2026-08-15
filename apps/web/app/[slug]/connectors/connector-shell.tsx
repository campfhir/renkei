'use client';

import type { ReactNode } from 'react';

/**
 * The box a connector card draws itself in — top level, or nested inside a
 * suite card.
 *
 * It exists so "is this a card or a panel?" is one decision in one place
 * rather than a styling ternary copied into every connector. Both Microsoft
 * and Atlassian group several products under one heading, and the products
 * have to look subordinate to it without each component inventing its own
 * idea of subordinate.
 *
 * Nested panels sit on a tinted ground rather than the card's white, which is
 * what makes the grouping legible at a glance: the suite is the white card,
 * and everything inset belongs to it.
 */
export function ConnectorShell({
  nested = false,
  children,
}: {
  nested?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        nested
          ? 'rounded-lg border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-800 dark:bg-gray-900/40'
          : 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950'
      }
    >
      {children}
    </div>
  );
}

/**
 * The heading inside a shell. A nested panel steps down a level — smaller,
 * and an <h3> — so the document outline matches what the nesting looks like
 * rather than presenting every product as a peer of the suite containing it.
 */
export function ConnectorHeading({
  nested = false,
  children,
}: {
  nested?: boolean;
  children: ReactNode;
}) {
  const className = `flex items-center gap-2 font-semibold${nested ? ' text-sm' : ''}`;
  return nested ? (
    <h3 className={className}>{children}</h3>
  ) : (
    <h2 className={className}>{children}</h2>
  );
}
