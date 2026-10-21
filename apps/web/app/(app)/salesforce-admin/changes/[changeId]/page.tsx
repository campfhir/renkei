import React from 'react';
import BackLink from '@/components/back-link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import {
  getChangeRequest,
  stateOf,
  type ChangeRequest,
  type OperationResult,
} from '@/lib/salesforce-admin/change-requests';
import { deploys, readMetadataPayload, stepLabel } from '@/lib/salesforce-admin/plan';
import {
  accessForChange,
  applyGate,
  refreshApplying,
  refreshValidation,
} from '@/lib/salesforce-admin/apply';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import LocalTime from '@/components/local-time';
import { ChangeStatePill, ValidationPill, validationState } from '../change-status';
import ChangeActions, { RefreshWhileRunning } from './change-actions';

/** A component's Metadata API type, as the review page names it. */
const TYPE_LABELS: Record<string, string> = {
  CustomField: 'field',
  ValidationRule: 'validation rule',
  Layout: 'page layout',
  CustomObject: 'object',
  CustomTab: 'tab',
  PermissionSet: 'permission set',
};

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

/** Finish a validation or a deploy that was still running, so the page says how it ended. */
async function catchUp(
  db: Parameters<typeof refreshApplying>[0],
  subject: string,
  change: ChangeRequest
): Promise<ChangeRequest> {
  const running =
    (change.status === 'applying' && change.results?.deployId) ||
    (change.validation && 'deployId' in change.validation && !change.validation.done);
  if (!running) return change;
  const context = { subject, db };
  const access = await accessForChange(context, change);
  if (typeof access === 'string') return change;
  const moved =
    (await refreshValidation(db, context, access, change)) ||
    (await refreshApplying(db, context, access, change));
  return moved ? ((await getChangeRequest(db, subject, change.id)) ?? change) : change;
}

/**
 * One Salesforce admin change request, for its owner to review and apply:
 * every component it deploys (a new field's whole definition, a changed
 * rule's old against new), what Salesforce's validation said, what runs
 * after the deploy, what is re-checked before it, and — once applied —
 * what each step did.
 */
export default async function SalesforceAdminChangePage({
  params,
}: {
  params: Promise<{ changeId: string }>;
}): Promise<React.ReactNode> {
  const { changeId } = await params;

  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/salesforce-admin/changes/${changeId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  // Owner-scoped: someone else's request reads as not found.
  const stored = await getChangeRequest(db, session.subject, changeId);
  if (!stored) notFound();
  const change = await catchUp(db, session.subject, stored);

  const agent = change.agentId
    ? await db
        .selectFrom('agents')
        .select('name')
        .where('id', '=', change.agentId)
        .executeTakeFirst()
    : undefined;
  const connector = (await listSalesforceConnectors(SALESFORCE_ADMIN_KIND)).find(
    (org) => org.key === change.connectorKey
  );
  const orgName = connector?.name ?? change.connectorKey;

  const state = stateOf(change);
  const payload = readMetadataPayload(change.payload);
  const validation = change.validation;
  const results = change.results;
  // The apply route asks this again on the click; asking now says why
  // Apply is off before anyone presses it.
  const gate =
    state === 'pending' ? await applyGate(db, session.subject, session.roles, change) : null;
  const running = state === 'applying' || validationState(validation) === 'running';

  return (
    <div className="mx-auto max-w-3xl">
      <RefreshWhileRunning running={running} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href="/salesforce-admin/changes" label="Salesforce admin changes" />
        <h1 className="min-w-0 truncate text-xl font-bold">Review a Salesforce change</h1>
        <ChangeStatePill state={state} />
        <ValidationPill validation={validation} />
      </div>

      <div className="mb-4 space-y-2 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
        <p className="font-medium break-words" data-testid="change-title">
          {change.title}
        </p>
        <p
          data-testid="change-org"
          className={
            connector && !connector.sandbox
              ? 'rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
              : 'text-gray-700 dark:text-gray-300'
          }
        >
          <span className="font-medium">Where:</span> {orgName}
          {connector ? (connector.sandbox ? ' (sandbox)' : ' — production') : ''},{' '}
          <span className="font-mono text-xs break-words">{change.instanceUrl}</span>
        </p>
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
          .
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

      {validation && (
        <section
          data-testid="change-validation"
          className="mb-4 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
        >
          <h2 className="mb-1 font-semibold">
            {validationState(validation) === 'checked' ? 'Checks' : 'Salesforce’s validation'}
          </h2>
          {'error' in validation ? (
            <p className="text-red-700 dark:text-red-400">{validation.error}</p>
          ) : !validation.done ? (
            <p className="text-gray-600 dark:text-gray-400">
              Salesforce is running a check-only deploy of this change. This page updates when it is
              done.
            </p>
          ) : validation.success && !validation.deployId ? (
            <p className="text-gray-700 dark:text-gray-300">
              Nothing in this change deploys, so there is no dry run for Salesforce to do. Every
              permission set, user and object it names was checked against {orgName} when it was
              proposed; each step reads the live row again when it runs.
            </p>
          ) : validation.success ? (
            <p className="text-gray-700 dark:text-gray-300">
              A check-only deploy passed: Salesforce compiled it and checked every reference, and
              changed nothing.
            </p>
          ) : (
            <>
              <p className="mb-1 text-red-700 dark:text-red-400">
                The check-only deploy failed, so this cannot be applied. Ask for it again once these
                are fixed:
              </p>
              <ul className="space-y-1">
                {validation.failures.map((failure, index) => (
                  <li key={index} className="break-words">
                    <span className="font-mono text-xs">{failure.name}</span>: {failure.problem}
                    {failure.line ? ` (line ${failure.line})` : ''}
                  </li>
                ))}
                {validation.errorMessage && (
                  <li className="break-words">{validation.errorMessage}</li>
                )}
              </ul>
            </>
          )}
        </section>
      )}

      {results ? (
        <>
          <h2 className="mb-2 text-sm font-semibold">What happened</h2>
          <ol className="space-y-2" data-testid="change-results">
            {results.operations.map((result, index) => (
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
                  <p className="mt-1 break-words whitespace-pre-line text-gray-600 dark:text-gray-400">
                    {result.detail}
                  </p>
                )}
              </li>
            ))}
            {state === 'applying' && (
              <li className="rounded-md border border-dashed border-gray-300 p-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
                Salesforce is deploying it{results.deployId ? ` (deploy ${results.deployId})` : ''}.
                This page updates when it is done.
              </li>
            )}
          </ol>
        </>
      ) : (
        <>
          <h2 className="mb-2 text-sm font-semibold">
            {payload && !deploys(payload) ? 'What applying it changes' : 'What applying it deploys'}
          </h2>
          <ol className="space-y-2" data-testid="change-components">
            {(payload?.components ?? []).map((component, index) => (
              <li
                key={`${index}:${component.type}:${component.name}`}
                className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 font-mono text-xs break-all">{component.name}</span>
                  <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800">
                    {component.action === 'create' ? 'New' : 'Changed'}{' '}
                    {TYPE_LABELS[component.type] ?? component.type}
                  </span>
                </div>
                <dl className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[9rem_1fr]">
                  {component.rows.map((row) => (
                    <React.Fragment key={row.label}>
                      <dt className="text-gray-500 dark:text-gray-400">{row.label}</dt>
                      <dd className="min-w-0 break-words">
                        {row.from !== undefined && (
                          <span className="block text-red-700 line-through dark:text-red-400">
                            {row.from || '(blank)'}
                          </span>
                        )}
                        <span
                          className={
                            row.from !== undefined ? 'text-green-700 dark:text-green-400' : ''
                          }
                        >
                          {row.value || '(blank)'}
                        </span>
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
          {payload && payload.dataSteps.length > 0 && (
            <div
              className="mt-3 text-sm text-gray-700 dark:text-gray-300"
              data-testid="change-grants"
            >
              <p className="font-medium">
                {deploys(payload) ? 'Then, once it deploys:' : 'What applying it does:'}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {payload.dataSteps.map((step, index) => (
                  <li key={index} className="break-words">
                    {stepLabel(step)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {state === 'pending' && (
        <>
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            {payload && !deploys(payload)
              ? `Applying writes each of these on your own Salesforce Admin connection in ${orgName}, with the permissions you hold there; each is its own step, and the result lists every one.`
              : `Applying first checks that nothing it was built on has changed in ${orgName}, then deploys it on your own Salesforce Admin connection — all of it or none of it — with the permissions you hold there.`}
          </p>
          <ChangeActions
            changeId={change.id}
            orgName={orgName}
            applyBlocked={gate && !gate.ok ? gate.reason : null}
            dataOnly={payload !== null && !deploys(payload)}
          />
        </>
      )}
      {state === 'interrupted' && (
        <p className="mt-4 text-sm text-amber-800 dark:text-amber-300">
          Applying this was cut off before Salesforce started a deploy, so nothing was deployed. Ask
          for it again to get a fresh request.
        </p>
      )}
    </div>
  );
}
