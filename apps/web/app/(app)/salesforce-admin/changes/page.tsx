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
} from '@/lib/salesforce-admin/change-requests';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import LocalTime from '@/components/local-time';
import { ChangeStatePill, ValidationPill } from './change-status';
import { RefreshWhileRunning } from './[changeId]/change-actions';

/**
 * Salesforce admin change requests. An operator sees everyone's — those
 * waiting for approval, those running now, then the recent history — and
 * is the only one who approves. Anyone else sees the ones they asked for,
 * and where each stands.
 */
export default async function SalesforceAdminChangesPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl('/salesforce-admin/changes'));
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
  const orgs = new Map(
    (await listSalesforceConnectors(SALESFORCE_ADMIN_KIND)).map((org) => [org.key, org.name])
  );
  const now = new Date();
  const waiting = changes.filter((change) => stateOf(change, now) === 'pending');
  const running = changes.filter((change) => ['queued', 'applying'].includes(stateOf(change, now)));
  const history = changes.filter(
    (change) => !['pending', 'queued', 'applying'].includes(stateOf(change, now))
  );

  const row = (change: ChangeRequest) => (
    <li key={change.id}>
      <Link
        href={`/salesforce-admin/changes/${change.id}`}
        className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium break-words">{change.title}</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {orgs.get(change.connectorKey) ?? change.connectorKey} ·{' '}
            {change.kind === REQUEST_KIND ? 'requested' : 'proposed'}{' '}
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
        <span className="flex shrink-0 flex-wrap gap-1">
          {change.kind === REQUEST_KIND ? null : <ValidationPill validation={change.validation} />}
          <ChangeStatePill state={stateOf(change, now)} />
        </span>
      </Link>
    </li>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <RefreshWhileRunning running={running.length > 0} />
      <h1 className="mb-1 min-w-0 truncate text-xl font-bold">Salesforce admin changes</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {operator
          ? 'Changes to your Salesforce orgs’ setup, proposed in chat, by an AI app connected to Renkei, by agents, or asked for in words by people who cannot approve them. Salesforce validates each proposal with a deploy that changes nothing; nothing reaches the org until an operator approves it here. Approved changes deploy in the background, so you can leave and come back.'
          : 'Changes to your Salesforce orgs’ setup that you asked for. An operator reviews each one and, if they approve it, deploys it; you are notified when it is decided and when it finishes.'}
      </p>

      <h2 className="mb-2 text-sm font-semibold">
        {operator ? 'Waiting for approval' : 'Waiting for an operator'}
      </h2>
      {waiting.length === 0 ? (
        <p className="mb-6 rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
          Nothing to review. Ask in chat — for example, “add an Outcome picklist to Site Visit in
          UAT” — and the {operator ? 'proposal' : 'request'} lands here.
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
          <ul data-testid="changes-recent" className="space-y-2">
            {history.map(row)}
          </ul>
        </>
      )}
    </div>
  );
}
