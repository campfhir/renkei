/**
 * Applying a Salesforce admin change request, and who may
 * (docs/salesforce-connectors-design.md, "Confirm rule: change requests,
 * applied in the browser"); lib/jira-admin/apply.ts's shape.
 *
 * Only the apply route calls `applyChangeRequest`, and only after
 * `applyGate` agreed and the route won the row's claim. The gate asks the
 * questions the MCP endpoint asks before it registers a salesforce_admin_
 * act tool — org read-only mode, the off switch, the audience, a connected
 * grant with the capability — through the same projection, and one more:
 * whether the org takes changes at all (any sandbox; production only when
 * an admin allowed it on the connector).
 *
 * Applying: the preconditions are re-read and any that moved stops it; then
 * a quick deploy of the passed validation, or a full deploy with the same
 * options when Salesforce says the validation no longer qualifies; its id
 * is recorded before waiting; then, once it succeeds, the field grants.
 * A deploy still running when the wait runs out stays 'applying' and is
 * finished by `refreshApplying` the next time anyone looks.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { takesChanges, type DeployOutcome } from '@renkei/connector-salesforce';
import { resolveAudience } from '@/lib/connectors/audience';
import { buildProjection } from '@/lib/mcp-tools/projection';
import { resolveConnectorAvailability } from '@/lib/mcp-tools/registry';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import { SALESFORCE_ADMIN_SCOPE_OPTIONS } from '@/lib/salesforce-admin-scopes';
import { soqlString } from '@renkei/connector-salesforce';
import {
  resolveSalesforceAccess,
  sfQuery,
  sfRequest,
  str,
  type SalesforceAccess,
  type SalesforceCallContext,
} from '@/lib/mcp-tools/salesforce/client';
import { orgCall } from '@/lib/mcp-tools/salesforce/org-choice';
import {
  finishChangeRequest,
  recordDeployStarted,
  setValidation,
  validationFrom,
  validationPassed,
  type ApplyResults,
  type ChangeRequest,
  type OperationResult,
} from './change-requests';
import { deployStatus, failureLines, quickDeploy, startDeploy, waitForDeploy } from './deploy';
import {
  applyScopesFor,
  brokenPreconditions,
  deploys,
  readMetadataPayload,
  stepLabel,
  type DataStep,
} from './plan';

/** The connector key the admin tools register under. */
const CONNECTOR = SALESFORCE_ADMIN_KIND.key;

/** How long one apply request waits on its deploy before leaving it to a later look. */
export const APPLY_WAIT_MS = 90_000;

/** Says what the apply is doing right now; the job writes it to the row, which is also its heartbeat. */
export type StepReporter = (step: string) => Promise<void> | void;

/** How often a running deploy is asked how far along it is. */
const PROGRESS_POLL_MS = 3_000;

type Gate = { ok: true } | { ok: false; reason: string };

function deployProgress(outcome: DeployOutcome): string {
  const counted =
    outcome.componentsTotal > 0
      ? ` — ${outcome.componentsDeployed} of ${outcome.componentsTotal} components`
      : '';
  return `Salesforce is deploying${counted} (${outcome.status})`;
}

/**
 * Poll a deploy until it is done or the budget runs out, saying how far it
 * is on each look. The last answer either way: a deploy still running is
 * not a failure.
 */
export async function waitReporting(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  deployId: string,
  budgetMs: number,
  onStep?: StepReporter,
  pollMs = PROGRESS_POLL_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<Awaited<ReturnType<typeof deployStatus>>> {
  if (!onStep) return waitForDeploy(context, access, deployId, budgetMs);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await deployStatus(context, access, deployId);
    if (!status.ok || status.outcome.done || Date.now() + pollMs > deadline) return status;
    await onStep(deployProgress(status.outcome));
    await sleep(pollMs);
  }
}

export async function applyGate(
  db: Kysely<DB>,
  subject: string,
  roles: readonly string[],
  change: Pick<ChangeRequest, 'connectorKey' | 'validation'>
): Promise<Gate> {
  const settingsResult = await getOrgSettings();
  if (!settingsResult.ok) {
    return { ok: false, reason: 'Could not read your organization’s settings.' };
  }
  const settings = settingsResult.val;
  if (settings.readOnly) {
    return {
      ok: false,
      reason: 'Your organization is in read-only mode, so changes cannot be applied.',
    };
  }
  if (settings.disabledConnectors.includes(CONNECTOR)) {
    return { ok: false, reason: 'Salesforce Admin is switched off for your organization.' };
  }
  const [availability, audience] = await Promise.all([
    resolveConnectorAvailability(db, subject),
    resolveAudience(subject),
  ]);
  if (
    audience.restrictedConnectors.includes(CONNECTOR) &&
    !audience.allowedConnectors.includes(CONNECTOR)
  ) {
    return {
      ok: false,
      reason: 'Your organization limits Salesforce Admin to certain people, and you are not one.',
    };
  }
  if (!availability.salesforceAdminAvailable) {
    return {
      ok: false,
      reason: 'Salesforce Admin is not connected. Connect the org on the Connectors page first.',
    };
  }
  const connector = (await listSalesforceConnectors(SALESFORCE_ADMIN_KIND)).find(
    (org) => org.key === change.connectorKey
  );
  if (!connector?.enabled) {
    return {
      ok: false,
      reason: 'The Salesforce Admin connector this was proposed for is removed or switched off.',
    };
  }
  if (!takesChanges(connector)) {
    return {
      ok: false,
      reason: `${connector.name} is a production org that does not take change requests. Build in a sandbox, or ask an organization admin to allow changes on this connector.`,
    };
  }
  if (!validationPassed(change.validation)) {
    const running =
      change.validation !== null && 'deployId' in change.validation && !change.validation.done;
    return {
      ok: false,
      reason: running
        ? 'Salesforce is still validating this change; it can be applied once that passes.'
        : 'Salesforce has not validated this change. Propose it again once the errors are fixed.',
    };
  }

  // The questions above give a person the reason; the projection is the
  // rule itself, and has the last word should the two ever disagree.
  const projection = buildProjection({ settings, availability, roles, audience });
  if (
    !projection.allows({
      id: 'salesforce_admin_apply_change',
      connector: CONNECTOR,
      kind: 'act',
    })
  ) {
    return { ok: false, reason: 'Salesforce Admin changes are not available to you.' };
  }
  return { ok: true };
}

/**
 * The person's connection to the org the change was built for, with the
 * capability applying needs — or why not. A connection to a different org
 * under the same connector is refused: the change is that org's.
 */
export async function accessForChange(
  context: SalesforceCallContext,
  change: Pick<ChangeRequest, 'connectorKey' | 'orgId' | 'kind' | 'payload'>
): Promise<SalesforceAccess | string> {
  const scopes = applyScopesFor(change.kind, readMetadataPayload(change.payload));
  const access = await orgCall.run({ org: change.connectorKey, tool: 'apply' }, () =>
    resolveSalesforceAccess(context, SALESFORCE_ADMIN_KIND, () => scopes)
  );
  if (typeof access === 'string') {
    const boxes = SALESFORCE_ADMIN_SCOPE_OPTIONS.filter((o) =>
      o.scopes.some((scope) => scopes.includes(scope))
    ).map((o) => `“${o.label}”`);
    return access.includes('does not allow') && boxes.length > 0
      ? `${access} ${boxes.length === 1 ? 'The box is' : 'It needs the boxes'} ${boxes.join(' and ')}.`
      : access;
  }
  if (access.orgId !== change.orgId) {
    return 'Your connection to this connector is to a different Salesforce org than the one this change was built for.';
  }
  return access;
}

/** The id of a live row a step updates instead of inserting, or null. */
async function existingRow(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  soql: string
): Promise<string | null | { error: string }> {
  const found = await sfQuery(context, access, soql);
  if (!found.ok) return { error: found.error };
  return str(found.records[0]?.Id) || null;
}

async function runStep(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  step: DataStep
): Promise<OperationResult> {
  const label = stepLabel(step);
  const done = (detail?: string): OperationResult => ({
    label,
    outcome: 'done',
    ...(detail ? { detail } : {}),
  });
  const failed = (detail: string): OperationResult => ({ label, outcome: 'failed', detail });
  const upsert = async (
    sobject: string,
    id: string | null,
    values: Record<string, unknown>,
    create: Record<string, unknown>
  ) => {
    const written = id
      ? await sfRequest(
          context,
          access,
          'PATCH',
          `/sobjects/${sobject}/${encodeURIComponent(id)}`,
          values
        )
      : await sfRequest(context, access, 'POST', `/sobjects/${sobject}`, { ...create, ...values });
    return written.ok
      ? done(id ? 'Updated the access it already had.' : undefined)
      : failed(written.error);
  };
  const parent = soqlString(step.permissionSetId);
  switch (step.kind) {
    case 'field-permission': {
      const field = `${step.object}.${step.field}`;
      const id = await existingRow(
        context,
        access,
        `SELECT Id FROM FieldPermissions WHERE ParentId = ${parent} AND Field = ${soqlString(field)} LIMIT 1`
      );
      if (id && typeof id === 'object') return failed(id.error);
      return upsert(
        'FieldPermissions',
        id,
        { PermissionsRead: step.read || step.edit, PermissionsEdit: step.edit },
        { ParentId: step.permissionSetId, SobjectType: step.object, Field: field }
      );
    }
    case 'object-permission': {
      const id = await existingRow(
        context,
        access,
        `SELECT Id FROM ObjectPermissions WHERE ParentId = ${parent} AND SobjectType = ${soqlString(step.object)} LIMIT 1`
      );
      if (id && typeof id === 'object') return failed(id.error);
      return upsert(
        'ObjectPermissions',
        id,
        {
          PermissionsRead: step.read,
          PermissionsCreate: step.create,
          PermissionsEdit: step.edit,
          PermissionsDelete: step.delete,
          PermissionsViewAllRecords: step.viewAll,
          PermissionsModifyAllRecords: step.modifyAll,
        },
        { ParentId: step.permissionSetId, SobjectType: step.object }
      );
    }
    case 'tab-visibility': {
      const id = await existingRow(
        context,
        access,
        `SELECT Id FROM PermissionSetTabSetting WHERE ParentId = ${parent} AND Name = ${soqlString(step.tab)} LIMIT 1`
      );
      if (id && typeof id === 'object') return failed(id.error);
      // A tab setting is created, never updated (Visibility takes no update).
      if (id) return done('It already shows the tab.');
      const created = await sfRequest(
        context,
        access,
        'POST',
        '/sobjects/PermissionSetTabSetting',
        {
          ParentId: step.permissionSetId,
          Name: step.tab,
          Visibility: step.visibility,
        }
      );
      return created.ok ? done() : failed(created.error);
    }
    case 'assign':
    case 'unassign': {
      const id = await existingRow(
        context,
        access,
        `SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = ${parent} AND AssigneeId = ${soqlString(step.userId)} LIMIT 1`
      );
      if (id && typeof id === 'object') return failed(id.error);
      if (step.kind === 'assign') {
        if (id) return done('They already had it.');
        const created = await sfRequest(
          context,
          access,
          'POST',
          '/sobjects/PermissionSetAssignment',
          {
            AssigneeId: step.userId,
            PermissionSetId: step.permissionSetId,
          }
        );
        return created.ok ? done() : failed(created.error);
      }
      if (!id) return done('They did not have it.');
      const removed = await sfRequest(
        context,
        access,
        'DELETE',
        `/sobjects/PermissionSetAssignment/${encodeURIComponent(id)}`
      );
      return removed.ok ? done() : failed(removed.error);
    }
  }
}

/** Every data step in order; one failing does not stop the rest (each is its own row). */
async function runDataSteps(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  steps: readonly DataStep[],
  onStep?: StepReporter
): Promise<OperationResult[]> {
  const results: OperationResult[] = [];
  for (const [index, step] of steps.entries()) {
    await onStep?.(`Granting access (${index + 1} of ${steps.length}): ${stepLabel(step)}`);
    results.push(await runStep(context, access, step));
  }
  return results;
}

/** Record a finished deploy: the deploy's own line, then the grants that follow a success. */
async function finish(
  db: Kysely<DB>,
  context: SalesforceCallContext,
  access: SalesforceAccess,
  change: ChangeRequest,
  outcome: DeployOutcome,
  base: ApplyResults,
  appliedBy: string,
  onStep?: StepReporter
): Promise<ApplyResults & { status: 'applied' | 'partial' | 'failed' }> {
  const payload = readMetadataPayload(change.payload);
  const deployLine: OperationResult = outcome.success
    ? {
        label: `Deploy ${payload?.members.length ?? 0} component(s)${base.quick ? ' (the validated deploy, without re-running it)' : ''}`,
        outcome: 'done',
        detail: `Deploy ${outcome.id}`,
      }
    : {
        label: 'Deploy',
        outcome: 'failed',
        detail: failureLines(outcome).join('\n') || `Salesforce says ${outcome.status}.`,
      };
  const grants =
    outcome.success && payload
      ? await runDataSteps(context, access, payload.dataSteps, onStep)
      : [];
  const operations = [...base.operations, deployLine, ...grants];
  const status = !outcome.success
    ? 'failed'
    : grants.some((g) => g.outcome === 'failed')
      ? 'partial'
      : 'applied';
  const results = { ...base, deployId: outcome.id, operations };
  await finishChangeRequest(db, change.id, { status, results, appliedBy });
  return { ...results, status };
}

/** Apply a claimed request. The caller holds the claim; this records how it ended. */
export async function applyChangeRequest(
  db: Kysely<DB>,
  context: SalesforceCallContext,
  access: SalesforceAccess,
  change: ChangeRequest,
  appliedBy: string,
  waitMs = APPLY_WAIT_MS,
  onStep?: StepReporter
): Promise<{ status: ChangeRequest['status']; results: ApplyResults }> {
  await onStep?.('Checking the org has not changed since this was proposed');
  const payload = readMetadataPayload(change.payload);
  if (!payload) {
    const results = {
      operations: [
        {
          label: 'Read the change',
          outcome: 'failed' as const,
          detail: 'Not a change this version can apply.',
        },
      ],
    };
    await finishChangeRequest(db, change.id, { status: 'failed', results, appliedBy });
    return { status: 'failed', results };
  }
  const broken = await brokenPreconditions(context, access, payload.preconditions);
  if (broken.length > 0) {
    const results = {
      operations: [
        {
          label: 'Check the org has not changed since this was proposed',
          outcome: 'failed' as const,
          detail: broken.join('\n'),
        },
      ],
    };
    await finishChangeRequest(db, change.id, { status: 'failed', results, appliedBy });
    return { status: 'failed', results };
  }
  const checked: OperationResult = {
    label: 'Check the org has not changed since this was proposed',
    outcome: 'done',
  };

  if (!deploys(payload)) {
    // Data only: nothing to deploy, the steps are the change.
    const steps = await runDataSteps(context, access, payload.dataSteps, onStep);
    const failures = steps.filter((step) => step.outcome === 'failed').length;
    const status = failures === 0 ? 'applied' : failures === steps.length ? 'failed' : 'partial';
    const results = { operations: [checked, ...steps] };
    await finishChangeRequest(db, change.id, { status, results, appliedBy });
    return { status, results };
  }

  const validatedId =
    change.validation && 'deployId' in change.validation ? change.validation.deployId : '';
  await onStep?.('Starting the deploy in Salesforce');
  let quick = false;
  let started = validatedId ? await quickDeploy(context, access, validatedId) : null;
  if (started?.ok) quick = true;
  if (!started) started = await startDeploy(context, access, payload.files, { checkOnly: false });
  if (!started.ok) {
    const results = {
      operations: [checked, { label: 'Deploy', outcome: 'failed' as const, detail: started.error }],
    };
    await finishChangeRequest(db, change.id, { status: 'failed', results, appliedBy });
    return { status: 'failed', results };
  }
  const base: ApplyResults = { deployId: started.outcome.id, quick, operations: [checked] };
  await recordDeployStarted(db, change.id, base);

  const waited = started.outcome.done
    ? { ok: true as const, outcome: started.outcome }
    : await waitReporting(context, access, started.outcome.id, waitMs, onStep);
  if (!waited.ok || !waited.outcome.done) {
    // Still running in Salesforce: a later look finishes it.
    return { status: 'applying', results: base };
  }
  const done = await finish(db, context, access, change, waited.outcome, base, appliedBy, onStep);
  return { status: done.status, results: done };
}

/**
 * Finish an 'applying' request whose deploy outlived the request that
 * started it, by reading the deploy itself. Unchanged when it is still
 * running, or when it has no deploy to read.
 */
export async function refreshApplying(
  db: Kysely<DB>,
  context: SalesforceCallContext,
  access: SalesforceAccess,
  change: ChangeRequest,
  waitMs = 0,
  onStep?: StepReporter
): Promise<boolean> {
  if (change.status !== 'applying' || !change.results?.deployId) return false;
  const status = await waitReporting(context, access, change.results.deployId, waitMs, onStep);
  if (!status.ok || !status.outcome.done) return false;
  await finish(
    db,
    context,
    access,
    change,
    status.outcome,
    change.results,
    change.approvedBy ?? change.appliedBy ?? change.subject,
    onStep
  );
  return true;
}

/** Record a validation that was still running when its proposal answered. */
export async function refreshValidation(
  db: Kysely<DB>,
  context: SalesforceCallContext,
  access: SalesforceAccess,
  change: ChangeRequest
): Promise<boolean> {
  const validation = change.validation;
  if (!validation || !('deployId' in validation) || validation.done || !validation.deployId) {
    return false;
  }
  const status = await waitForDeploy(context, access, validation.deployId, 0);
  if (!status.ok || !status.outcome.done) return false;
  await setValidation(db, change.id, validationFrom(status.outcome));
  return true;
}
