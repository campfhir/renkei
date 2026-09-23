import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listChangeRequests, stateOf, type ChangeRequest } from '@/lib/jira-admin/change-requests';
import LocalTime from '@/components/local-time';
import { ChangeStatePill } from './change-status';

/**
 * Your Jira admin change requests: the ones waiting for your review, then
 * the recent history. Per person, like batch jobs — a request is only ever
 * its proposer's to apply.
 */
export default async function JiraAdminChangesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/jira-admin/changes`));
  }

  const dbResult = getDatabase();
  const changes = dbResult.ok
    ? await listChangeRequests(dbResult.val, tenant.id, session.subject, { limit: 50 })
    : [];
  const now = new Date();
  const waiting = changes.filter((change) => stateOf(change, now) === 'pending');
  const history = changes.filter((change) => stateOf(change, now) !== 'pending');

  const row = (change: ChangeRequest) => (
    <li key={change.id}>
      <Link
        href={`/${slug}/jira-admin/changes/${change.id}`}
        className="flex items-start justify-between gap-3 rounded-md border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium break-words">{change.title}</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Proposed <LocalTime at={change.createdAt} />
            {change.agentId ? ' by one of your agents' : ''}
          </span>
        </span>
        <ChangeStatePill state={stateOf(change, now)} />
      </Link>
    </li>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Jira admin changes</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Changes to Jira&apos;s configuration proposed in chat, by an AI app connected to Renkei, or
        by your agents. Nothing reaches Jira until you open one here and apply it — on your own Jira
        Administration connection, with the admin rights you hold.
      </p>

      <h2 className="mb-2 text-sm font-semibold">Waiting for your review</h2>
      {waiting.length === 0 ? (
        <p className="mb-6 rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
          Nothing to review. Ask in chat — for example, “add a Vendor option to the Source field in
          OPS” — and the proposal lands here.
        </p>
      ) : (
        <ul className="mb-6 space-y-2">{waiting.map(row)}</ul>
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
