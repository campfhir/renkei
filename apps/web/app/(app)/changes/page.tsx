import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { ROLE_OPERATOR } from '@/lib/access';
import { getIdentityDisplay } from '@/lib/identity';
import {
  CHANGE_SOURCES,
  isChangeSource,
  listChangeRows,
  type ChangeRow,
} from '@/lib/admin-changes/sources';
import LocalTime from '@/components/local-time';
import {
  ChangeStatePill as SalesforceStatePill,
  ValidationPill,
} from '../salesforce-admin/changes/change-status';
import { ChangeStatePill as JiraStatePill } from '../jira-admin/changes/change-status';
import { RefreshWhileRunning } from '../jira-admin/changes/[changeId]/change-actions';

/**
 * Every admin connector's change requests in one place — Salesforce's and
 * Jira's today, and whichever connector queues changes next
 * (lib/admin-changes/sources.ts). An operator sees everyone's: those
 * waiting for approval, those running now, then the recent history, each
 * with where it changes and who asked. Anyone else sees their own. Each
 * row opens the connector's own review page, where it is approved.
 */
export default async function ChangesPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl('/changes'));
  }

  const { source: requested } = await searchParams;
  const source = isChangeSource(requested) ? requested : undefined;
  const operator = session.roles.includes(ROLE_OPERATOR);
  const now = new Date();
  const rows = await listChangeRows({ subject: session.subject, operator, source, now });

  const people = new Map<string, string>();
  if (operator) {
    const others = [...new Set(rows.map((row) => row.subject))].filter(
      (subject) => subject !== session.subject
    );
    const identities = await Promise.all(others.map((subject) => getIdentityDisplay(subject)));
    others.forEach((subject, i) => {
      const identity = identities[i];
      people.set(subject, identity?.displayName ?? identity?.email ?? subject);
    });
  }

  const waiting = rows.filter((row) => row.state === 'pending');
  const running = rows.filter((row) => row.state === 'queued' || row.state === 'applying');
  const history = rows.filter((row) => !['pending', 'queued', 'applying'].includes(row.state));

  const item = (row: ChangeRow) => (
    <li key={`${row.source}:${row.id}`}>
      <Link
        href={row.href}
        className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
      >
        {/* A real basis, not flex-1's zero: below it the pills wrap under
            the title instead of squeezing it to a column on a phone. */}
        <span className="min-w-0 flex-[1_1_16rem]">
          <span className="flex min-w-0 items-start gap-2">
            <span
              data-testid="change-source"
              className="mt-0.5 shrink-0 rounded border border-gray-300 px-1.5 text-[11px] font-medium text-gray-600 dark:border-gray-700 dark:text-gray-300"
            >
              {row.sourceLabel}
            </span>
            <span
              data-testid="change-row-title"
              className="min-w-0 text-sm font-medium break-words"
            >
              {row.title}
            </span>
          </span>
          <span className="mt-0.5 block text-xs break-words text-gray-500 dark:text-gray-400">
            {row.where ? `${row.where} · ` : ''}
            {row.kind === 'request' ? 'requested' : 'proposed'} <LocalTime at={row.createdAt} />
            {operator && row.subject !== session.subject
              ? ` by ${people.get(row.subject) ?? row.subject}`
              : ''}
            {row.agentId ? ' through an agent' : ''}
          </span>
          {(row.state === 'queued' || row.state === 'applying') && row.step ? (
            <span className="block text-xs text-blue-700 dark:text-blue-300">{row.step}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-wrap gap-1">
          {row.source === 'salesforce-admin' ? (
            <>
              {row.kind === 'proposal' ? <ValidationPill validation={row.validation} /> : null}
              <SalesforceStatePill state={row.state} />
            </>
          ) : (
            <JiraStatePill state={row.state} />
          )}
        </span>
      </Link>
    </li>
  );

  const filters = [{ key: undefined, label: 'All' }, ...CHANGE_SOURCES];

  return (
    <div className="mx-auto max-w-3xl">
      <RefreshWhileRunning running={running.length > 0} />
      <h1 className="mb-1 min-w-0 truncate text-xl font-bold">Changes</h1>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        {operator
          ? 'Changes to your connected systems’ setup — Salesforce orgs and Jira — proposed in chat, by an AI app connected to Renkei, by agents, or asked for in words by people who cannot approve them. Nothing reaches a system until an operator approves it on its review page.'
          : 'Changes to your connected systems’ setup that you asked for. An operator reviews each one and, if they approve it, applies it; you are notified when it is decided and when it finishes.'}
      </p>

      <nav aria-label="Filter by connector" className="mb-6 flex flex-wrap gap-2">
        {filters.map((filter) => {
          const active = filter.key === source;
          return (
            <Link
              key={filter.label}
              href={filter.key ? `/changes?source=${filter.key}` : '/changes'}
              aria-current={active ? 'page' : undefined}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                active
                  ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
              }`}
            >
              {filter.label}
            </Link>
          );
        })}
      </nav>

      <h2 className="mb-2 text-sm font-semibold">
        {operator ? 'Waiting for approval' : 'Waiting for an operator'}
      </h2>
      {waiting.length === 0 ? (
        <p
          data-testid="changes-empty"
          className="mb-6 rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400"
        >
          Nothing to review. Ask in chat — for example, “add an Outcome picklist to Site Visit in
          UAT” or “add a Vendor option to the Source field in OPS” — and the{' '}
          {operator ? 'proposal' : 'request'} lands here.
        </p>
      ) : (
        <ul data-testid="changes-waiting" className="mb-6 space-y-2">
          {waiting.map(item)}
        </ul>
      )}

      {running.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold">Running now</h2>
          <ul data-testid="changes-running" className="mb-6 space-y-2">
            {running.map(item)}
          </ul>
        </>
      )}

      {history.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold">Recent</h2>
          <ul data-testid="changes-recent" className="space-y-2">
            {history.map(item)}
          </ul>
        </>
      )}
    </div>
  );
}
