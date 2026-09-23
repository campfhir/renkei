import React from 'react';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getChangeRequest, stateOf, type OperationResult } from '@/lib/jira-admin/change-requests';
import { describeChange } from '@/lib/jira-admin/describe';
import { applyGate } from '@/lib/jira-admin/apply';
import LocalTime from '@/components/local-time';
import { ChangeStatePill } from '../change-status';
import ChangeActions from './change-actions';

const OUTCOME_LABELS: Record<OperationResult['outcome'], string> = {
  done: 'Done',
  failed: 'Failed',
  not_run: 'Not run',
};

const OUTCOME_TONES: Record<OperationResult['outcome'], string> = {
  done: 'text-green-700 dark:text-green-400',
  failed: 'text-red-700 dark:text-red-400',
  not_run: 'text-gray-500 dark:text-gray-400',
};

/**
 * One change request, for its owner to review and apply: every operation
 * in plain words, where it lands (with a global context called out, since
 * that reaches every space without its own), why it was proposed, and —
 * once applied — what each operation returned.
 */
export default async function JiraAdminChangePage({
  params,
}: {
  params: Promise<{ slug: string; changeId: string }>;
}): Promise<React.ReactNode> {
  const { slug, changeId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/jira-admin/changes/${changeId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  // Owner-scoped: someone else's request reads as not found.
  const change = await getChangeRequest(db, tenant.id, session.subject, changeId);
  if (!change) notFound();

  const agent = change.agentId
    ? await db
        .selectFrom('agents')
        .select('name')
        .where('id', '=', change.agentId)
        .where('tenant_id', '=', tenant.id)
        .executeTakeFirst()
    : undefined;

  const state = stateOf(change);
  const { operations, reach, siteWide } = describeChange(change);
  const results = change.results;
  // The apply route asks this again on the click; asking now says why
  // Apply is off before anyone presses it.
  const gate =
    state === 'pending'
      ? await applyGate(db, tenant.id, session.subject, session.roles, change.kind)
      : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href={`/${slug}/jira-admin/changes`} label="Jira admin changes" />
        <h1 className="min-w-0 truncate text-xl font-bold">Review a Jira admin change</h1>
        <ChangeStatePill state={state} />
      </div>

      <div className="mb-4 space-y-2 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
        <p className="font-medium break-words" data-testid="change-title">
          {change.title}
        </p>
        {reach && (
          <p
            data-testid="change-reach"
            className={
              siteWide
                ? 'rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
                : 'text-gray-700 dark:text-gray-300'
            }
          >
            <span className="font-medium">Where:</span> {reach}
          </p>
        )}
        {change.reason && (
          <p className="break-words">
            <span className="font-medium">Why:</span> {change.reason}
          </p>
        )}
        <p className="text-gray-600 dark:text-gray-400">
          Proposed <LocalTime at={change.createdAt} />{' '}
          {change.agentId
            ? agent
              ? `by your agent “${agent.name}”`
              : 'by one of your agents'
            : 'from your chat or an AI app'}
          {change.siteUrl ? ` for ${change.siteUrl}` : ''}.
        </p>
        {state === 'pending' && (
          <p className="text-gray-600 dark:text-gray-400">
            Expires <LocalTime at={change.expiresAt} />.
          </p>
        )}
        {change.appliedAt && (
          <p className="text-gray-600 dark:text-gray-400">
            Applied <LocalTime at={change.appliedAt} />.
          </p>
        )}
      </div>

      <h2 className="mb-2 text-sm font-semibold">
        {results ? 'What happened' : 'What applying it will do'}
      </h2>
      <ol className="space-y-2" data-testid="change-operations">
        {results
          ? results.map((result, index) => (
              <li
                key={index}
                className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words">{result.label}</span>
                  <span className={`shrink-0 font-medium ${OUTCOME_TONES[result.outcome]}`}>
                    {OUTCOME_LABELS[result.outcome]}
                  </span>
                </div>
                {result.detail && (
                  <p className="mt-1 break-words text-gray-600 dark:text-gray-400">
                    {result.detail}
                  </p>
                )}
              </li>
            ))
          : operations.map((operation, index) => (
              <li
                key={index}
                className="rounded-md border border-gray-200 p-3 text-sm break-words dark:border-gray-800"
              >
                {operation}
              </li>
            ))}
      </ol>

      {state === 'pending' && (
        <>
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            Applying runs these on your own Jira Administration connection, in this order, and Jira
            checks your admin rights on each. Renkei reads the field again first and stops at
            anything that has changed since this was proposed. Nothing is deleted.
          </p>
          <ChangeActions
            tenantId={tenant.id}
            changeId={change.id}
            count={operations.length}
            applyBlocked={gate && !gate.ok ? gate.reason : null}
          />
        </>
      )}
      {state === 'interrupted' && (
        <p className="mt-4 text-sm text-amber-800 dark:text-amber-300">
          Applying this was cut off before it finished, so some of it may have reached Jira. Check
          the field in Jira before asking for it again.
        </p>
      )}
    </div>
  );
}
