import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { ROLE_OPERATOR } from '@/lib/access';
import { getIdentityDisplay } from '@/lib/identity';
import {
  listAllChangeRequests,
  listChangeRequests,
  REQUEST_KIND,
  stateOf,
  type ChangeRequest,
} from '@/lib/jira-admin/change-requests';
import LocalTime from '@/components/local-time';
import { ChangeStatePill } from './change-status';
import { RefreshWhileRunning } from './[changeId]/change-actions';
import { noteLogUser } from '@/lib/log-context';

/**
 * Jira admin change requests. An operator sees everyone's — those waiting
 * for approval, those running now, then the recent history — and is the
 * only one who approves. Anyone else sees the ones they asked for, and
 * where each stands.
 */
export default async function JiraAdminChangesPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (session) noteLogUser(session.subject);
  if (!session) {
    redirect(signInUrl(`/jira-admin/changes`));
  }

  const operator = session.roles.includes(ROLE_OPERATOR);
  const dbResult = getDatabase();
  const changes = !dbResult.ok
    ? []
    : operator
      ? await listAllChangeRequests(dbResult.val, { limit: 100 })
      : await listChangeRequests(dbResult.val, session.subject, { limit: 50 });
  const people = new Map<string, string>();
  if (operator) {
    for (const subject of new Set(changes.map((change) => change.subject))) {
      if (subject === session.subject) continue;
      const identity = await getIdentityDisplay(subject);
      people.set(subject, identity?.displayName ?? identity?.email ?? subject);
    }
  }
  const now = new Date();
  const waiting = changes.filter((change) => stateOf(change, now) === 'pending');
  const running = changes.filter((change) => ['queued', 'applying'].includes(stateOf(change, now)));
  const history = changes.filter(
    (change) => !['pending', 'queued', 'applying'].includes(stateOf(change, now))
  );

  const row = (change: ChangeRequest) => (
    <li key={change.id}>
      <Link
        href={`/jira-admin/changes/${change.id}`}
        className="flex items-start justify-between gap-3 rounded-md border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium break-words">{change.title}</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {change.kind === REQUEST_KIND ? 'Requested' : 'Proposed'}{' '}
            <LocalTime at={change.createdAt} />
            {operator && change.subject !== session.subject
              ? ` by ${people.get(change.subject) ?? change.subject}`
              : ''}
            {change.agentId ? ' through an agent' : ''}
          </span>
          {(change.status === 'queued' || change.status === 'applying') && change.step ? (
            <span className="block text-xs text-blue-700 dark:text-blue-300">{change.step}</span>
          ) : null}
        </span>
        <ChangeStatePill state={stateOf(change, now)} />
      </Link>
    </li>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <RefreshWhileRunning running={running.length > 0} />
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-xl font-bold">Jira admin changes</h1>
        <Link
          href={`/jira-admin/templates`}
          className="shrink-0 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Space templates
        </Link>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {operator
          ? 'Changes to Jira’s configuration proposed in chat, by an AI app connected to Renkei, by agents, or asked for in words by people who cannot approve them. Nothing reaches Jira until an operator approves it here, on their own Jira Administration connection. Approved changes apply in the background, so you can leave and come back.'
          : 'Changes to Jira’s configuration that you asked for. An operator reviews each one and, if they approve it, applies it; you are notified when it is decided and when it finishes.'}
      </p>

      <h2 className="mb-2 text-sm font-semibold">
        {operator ? 'Waiting for approval' : 'Waiting for an operator'}
      </h2>
      {waiting.length === 0 ? (
        <p
          data-testid="changes-empty"
          className="mb-6 rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400"
        >
          Nothing to review. Ask in chat — for example, “add a Vendor option to the Source field in
          OPS” — and the {operator ? 'proposal' : 'request'} lands here.
        </p>
      ) : (
        <ul data-testid="changes-waiting" className="mb-6 space-y-2">
          {waiting.map(row)}
        </ul>
      )}

      {running.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold">Running now</h2>
          <ul data-testid="changes-running" className="mb-6 space-y-2">
            {running.map(row)}
          </ul>
        </>
      )}

      {history.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold">Recent</h2>
          <ul className="space-y-2">{history.map(row)}</ul>
        </>
      )}
    </div>
  );
}
