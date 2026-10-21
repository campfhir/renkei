import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import {
  listChangeRequests,
  stateOf,
  type ChangeRequest,
} from '@/lib/salesforce-admin/change-requests';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import LocalTime from '@/components/local-time';
import { ChangeStatePill, ValidationPill } from './change-status';

/**
 * Your Salesforce admin change requests: those waiting for your review,
 * then the recent history. Per person — a request is only ever its
 * proposer's to apply.
 */
export default async function SalesforceAdminChangesPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl('/salesforce-admin/changes'));
  }

  const dbResult = getDatabase();
  const changes = dbResult.ok
    ? await listChangeRequests(dbResult.val, session.subject, { limit: 50 })
    : [];
  const orgs = new Map(
    (await listSalesforceConnectors(SALESFORCE_ADMIN_KIND)).map((org) => [org.key, org.name])
  );
  const now = new Date();
  const waiting = changes.filter((change) => stateOf(change, now) === 'pending');
  const history = changes.filter((change) => stateOf(change, now) !== 'pending');

  const row = (change: ChangeRequest) => (
    <li key={change.id}>
      <Link
        href={`/salesforce-admin/changes/${change.id}`}
        className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium break-words">{change.title}</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {orgs.get(change.connectorKey) ?? change.connectorKey} · proposed{' '}
            <LocalTime at={change.createdAt} />
            {change.agentId ? ' by one of your agents' : ''}
          </span>
        </span>
        <span className="flex shrink-0 flex-wrap gap-1">
          <ValidationPill validation={change.validation} />
          <ChangeStatePill state={stateOf(change, now)} />
        </span>
      </Link>
    </li>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 min-w-0 truncate text-xl font-bold">Salesforce admin changes</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Changes to your Salesforce orgs&apos; setup proposed in chat, by an AI app connected to
        Renkei, or by your agents. Salesforce validates each with a deploy that changes nothing;
        nothing reaches the org until you open one here and apply it, on your own Salesforce Admin
        connection.
      </p>

      <h2 className="mb-2 text-sm font-semibold">Waiting for your review</h2>
      {waiting.length === 0 ? (
        <p className="mb-6 rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
          Nothing to review. Ask in chat — for example, “add an Outcome picklist to Site Visit in
          UAT” — and the proposal lands here.
        </p>
      ) : (
        <ul data-testid="changes-waiting" className="mb-6 space-y-2">
          {waiting.map(row)}
        </ul>
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
