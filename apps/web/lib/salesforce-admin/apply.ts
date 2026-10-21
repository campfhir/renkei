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
import {
  resolveSalesforceAccess,
  sfRequest,
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
import { failureLines, quickDeploy, startDeploy, waitForDeploy } from './deploy';
import { brokenPreconditions, readMetadataPayload, type MetadataPayload } from './plan';

/** The connector key the admin tools register under. */
const CONNECTOR = SALESFORCE_ADMIN_KIND.key;

/** How long one apply request waits on its deploy before leaving it to a later look. */
export const APPLY_WAIT_MS = 90_000;

/** The capability applying a metadata change stands on. */
export const APPLY_SCOPES = ['sfa-schema'];

type Gate = { ok: true } | { ok: false; reason: string };

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
    resolveAudience(db, subject),
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
  change: Pick<ChangeRequest, 'connectorKey' | 'orgId'>
): Promise<SalesforceAccess | string> {
  const access = await orgCall.run({ org: change.connectorKey, tool: 'apply' }, () =>
    resolveSalesforceAccess(context, SALESFORCE_ADMIN_KIND, () => APPLY_SCOPES)
  );
  if (typeof access === 'string') {
    const box = SALESFORCE_ADMIN_SCOPE_OPTIONS.find((o) => o.scopes.includes('sfa-schema'));
    return access.includes('does not allow')
      ? `${access} The box is “${box?.label ?? 'Propose objects and fields'}”.`
      : access;
  }
  if (access.orgId !== change.orgId) {
    return 'Your connection to this connector is to a different Salesforce org than the one this change was built for.';
  }
  return access;
}

async function grantFields(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  payload: MetadataPayload
): Promise<OperationResult[]> {
  const results: OperationResult[] = [];
  for (const grant of payload.fieldGrants) {
    const label = `Give ${grant.permissionSetName} ${grant.edit ? 'read and edit' : 'read'} access to ${grant.object}.${grant.field}`;
    const created = await sfRequest(context, access, 'POST', '/sobjects/FieldPermissions', {
      ParentId: grant.permissionSetId,
      SobjectType: grant.object,
      Field: `${grant.object}.${grant.field}`,
      PermissionsRead: true,
      PermissionsEdit: grant.edit,
    });
    results.push(
      created.ok ? { label, outcome: 'done' } : { label, outcome: 'failed', detail: created.error }
    );
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
  appliedBy: string
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
  const grants = outcome.success && payload ? await grantFields(context, access, payload) : [];
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
  waitMs = APPLY_WAIT_MS
): Promise<{ status: ChangeRequest['status']; results: ApplyResults }> {
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

  const validatedId =
    change.validation && 'deployId' in change.validation ? change.validation.deployId : '';
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
    : await waitForDeploy(context, access, started.outcome.id, waitMs);
  if (!waited.ok || !waited.outcome.done) {
    // Still running in Salesforce: a later look finishes it.
    return { status: 'applying', results: base };
  }
  const done = await finish(db, context, access, change, waited.outcome, base, appliedBy);
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
  change: ChangeRequest
): Promise<boolean> {
  if (change.status !== 'applying' || !change.results?.deployId) return false;
  const status = await waitForDeploy(context, access, change.results.deployId, 0);
  if (!status.ok || !status.outcome.done) return false;
  await finish(
    db,
    context,
    access,
    change,
    status.outcome,
    change.results,
    change.appliedBy ?? change.subject
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
