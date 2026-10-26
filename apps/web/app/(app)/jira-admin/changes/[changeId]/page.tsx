import React from 'react';
import Link from 'next/link';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { ROLE_OPERATOR } from '@/lib/access';
import { getIdentityDisplay } from '@/lib/identity';
import {
  getChangeRequestById,
  mayView,
  REQUEST_KIND,
  requestDescription,
  stateOf,
  type OperationResult,
} from '@/lib/jira-admin/change-requests';
import { describeChange } from '@/lib/jira-admin/describe';
import { applyGate } from '@/lib/jira-admin/apply';
import LocalTime from '@/components/local-time';
import { ChangeStatePill } from '../change-status';
import ChangeActions, { RefreshWhileRunning } from './change-actions';
import { noteLogUser } from '@/lib/log-context';

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
 * One change request, for an operator to review and approve (and for the
 * person who asked to follow): every operation
 * in plain words, where it lands (with a global context called out, since
 * that reaches every space without its own), why it was proposed, and —
 * once applied — what each operation returned.
 */
export default async function JiraAdminChangePage({
  params,
}: {
  params: Promise<{ changeId: string }>;
}): Promise<React.ReactNode> {
  const { changeId } = await params;

  const session = await getSessionFromCookies();
  if (session) noteLogUser(session.subject);
  if (!session) {
    redirect(signInUrl(`/jira-admin/changes/${changeId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  // The requester sees their own and an operator sees everyone's; to anyone
  // else a request reads as not found.
  const operator = session.roles.includes(ROLE_OPERATOR);
  const change = await getChangeRequestById(db, changeId);
  if (!change || !mayView(change, { subject: session.subject, operator })) notFound();
  const isOwner = change.subject === session.subject;
  const isRequest = change.kind === REQUEST_KIND;
  const [requester, approver] = await Promise.all([
    getIdentityDisplay(change.subject),
    change.approvedBy ? getIdentityDisplay(change.approvedBy) : Promise.resolve(null),
  ]);
  const requesterName = isOwner
    ? 'you'
    : (requester?.displayName ?? requester?.email ?? change.subject);
  const approverName = change.approvedBy
    ? change.approvedBy === session.subject
      ? 'you'
      : (approver?.displayName ?? approver?.email ?? change.approvedBy)
    : null;

  const agent = change.agentId
    ? await db
        .selectFrom('agents')
        .select('name')
        .where('id', '=', change.agentId)
        .executeTakeFirst()
    : undefined;

  const state = stateOf(change);
  const { operations, reach, siteWide, applyNote } = isRequest
    ? { operations: [], reach: null, siteWide: false, applyNote: null }
    : describeChange(change);
  const inProgress = state === 'queued' || state === 'applying';
  const results = change.results;
  // The apply route asks this again on the click; asking now says why
  // Apply is off before anyone presses it.
  const gate =
    state === 'pending' && operator && !isRequest
      ? await applyGate(db, session.subject, session.roles, change)
      : null;

  return (
    <div className="mx-auto max-w-3xl">
      <RefreshWhileRunning running={inProgress} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href={`/jira-admin/changes`} label="Jira admin changes" />
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
        <p className="text-gray-600 dark:text-gray-400" data-testid="change-requester">
          {isRequest ? 'Requested' : 'Proposed'} <LocalTime at={change.createdAt} /> by{' '}
          {requesterName}
          {change.agentId
            ? agent
              ? `, through ${isOwner ? 'your' : 'their'} agent “${agent.name}”`
              : `, through ${isOwner ? 'one of your agents' : 'an agent'}`
            : ''}
          {change.siteUrl ? ` for ${change.siteUrl}` : ''}.
        </p>
        {approverName && (
          <p className="text-gray-600 dark:text-gray-400" data-testid="change-approver">
            Approved <LocalTime at={change.approvedAt ?? change.createdAt} /> by {approverName}.
          </p>
        )}
        {change.resolution && (
          <p className="break-words" data-testid="change-resolution">
            <span className="font-medium">Note:</span> {change.resolution}
          </p>
        )}
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

      {inProgress && (
        <section
          data-testid="change-progress"
          role="status"
          className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
        >
          <p className="flex items-center gap-2 font-semibold">
            <span
              aria-hidden
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
            {state === 'queued' ? 'Approved — waiting to start' : 'Applying'}
          </p>
          <p className="mt-1 break-words" data-testid="change-step">
            {change.step ?? 'Working…'}
          </p>
          <p className="mt-2 text-xs">
            This runs on the server. You can leave this page and come back, and you will be notified
            when it finishes.{' '}
            <Link href="/jira-admin/changes" className="font-medium underline">
              See all change requests
            </Link>
          </p>
        </section>
      )}

      {isRequest && (
        <section
          data-testid="change-request-text"
          className="mb-4 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
        >
          <h2 className="mb-1 font-semibold">What was asked for</h2>
          <p className="break-words whitespace-pre-line">{requestDescription(change.payload)}</p>
          {state === 'pending' && operator && (
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Nothing here can be approved yet: it is a request in words. In chat, ask Renkei to
              build it as a proposal (it can read this request by its id); or decline it with a
              reason.
            </p>
          )}
        </section>
      )}

      {!isRequest && (
        <h2 className="mb-2 text-sm font-semibold">
          {results ? 'What happened' : 'What applying it will do'}
        </h2>
      )}
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
                className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words">{operation.text}</span>
                  {operation.access && (
                    <span
                      title="Changes who can see or do what in Jira"
                      className="shrink-0 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-950 dark:text-purple-300"
                    >
                      Access
                    </span>
                  )}
                </div>
                {operation.details.length > 0 && (
                  <ul
                    data-testid="operation-details"
                    className="mt-2 space-y-0.5 text-gray-600 dark:text-gray-400"
                  >
                    {operation.details.map((detail) => (
                      <li key={detail} className="break-words">
                        {detail}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
      </ol>

      {state === 'pending' && (
        <>
          {operator && !isRequest && (
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
              Approving runs these on your own Jira Administration connection, in this order, and
              Jira checks your admin rights on each. It runs in the background, so you do not need
              to stay on this page.{applyNote ? ` ${applyNote}` : ''}
            </p>
          )}
          <ChangeActions
            changeId={change.id}
            count={operations.length}
            applyBlocked={gate && !gate.ok ? gate.reason : null}
            canApprove={operator}
            isRequest={isRequest}
            isOwner={isOwner}
          />
        </>
      )}
      {state === 'interrupted' && (
        <p className="mt-4 text-sm text-amber-800 dark:text-amber-300">
          Applying this was cut off before it finished, so some of it may have reached Jira. Check
          Jira before asking for it again.
        </p>
      )}
    </div>
  );
}
