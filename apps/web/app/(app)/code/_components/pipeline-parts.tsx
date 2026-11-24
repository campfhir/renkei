'use client';

/**
 * The pieces the Bitbucket Pipelines panel (pipelines-page.tsx), the
 * GitHub Actions panel (actions-page.tsx), the pipeline builder and the
 * variables editor draw alike, so a person who learned one has learned
 * the others and a change to a card lands in all of them: the card, input
 * and button looks, and the run-state and on/off pills.
 */

import type { ReactNode } from 'react';
import ExternalLink from '@/components/external-link';
import Pill from '@/app/(app)/code/_components/pill';
import { runStatePill } from './pipelines-page.model';

export const cardClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
export const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
export const linkButtonClass =
  'text-xs font-medium whitespace-nowrap text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400';
export const secondaryButtonClass =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900';
export const primaryButtonClass =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';

/** A run's state as a pill: green when it passed, red when it failed, blue while it runs. */
export function RunStatePill({ state }: { state: string }) {
  const { tone, label } = runStatePill(state);
  return <Pill tone={tone}>{label}</Pill>;
}

/** On, Off, or nothing when the switch could not be read. */
export function StatusPill({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) return null;
  return enabled ? <Pill tone="green">On</Pill> : <Pill tone="gray">Off</Pill>;
}

/** A link to the host, for a note under a card. */
export function HostLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return null;
  return (
    <ExternalLink href={href} className="underline">
      {children}
    </ExternalLink>
  );
}
