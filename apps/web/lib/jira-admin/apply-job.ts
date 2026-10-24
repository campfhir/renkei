/**
 * The job that applies an approved Jira admin change request, on the
 * server, so nobody has to keep a page open while Jira works through the
 * operations.
 *
 * Approving (app/api/jira-admin/changes/[changeId]/apply) only moves the
 * row to 'queued', recording the operator whose own Jira connection the
 * operations will run on, and starts `runApplyJob` in `after()`. The row is
 * the queue: `recoverApplyJobs` (a sweep on every web process, started in
 * instrumentation.ts) picks up a queued row whose process went away before
 * starting it. While running, the job touches the row every few seconds —
 * its heartbeat, and the `step` the review page shows.
 *
 * A job that dies mid-apply is never run again: which of its operations
 * reached Jira is unknown, and repeating half of them is worse than
 * stopping. The sweep ends such a row as failed, saying to check Jira, and
 * the requester and approver are told.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { notifyChangeOutcome } from '@/lib/admin-changes/notify';
import { logger } from '@/lib/logger';
import { isShuttingDown, onShutdown } from '@/lib/shutdown';
import { resolveJiraAdminAccess, type JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { resolveJsmAccess } from '@/lib/mcp-tools/jira-admin/jsm-access';
import { resolveAutomationAccess } from '@/lib/mcp-tools/jira-admin/automation-client';
import { REQUEST_TYPE_KIND } from './request-type';
import { isAutomationKind } from './automation';
import {
  finishChangeRequest,
  getChangeRequestById,
  listRunnableChanges,
  reclaimStaleChange,
  setStep,
  startQueuedChange,
  type ChangeRequest,
  type OperationResult,
} from './change-requests';
import { applyChangeRequest, applyGate } from './apply';

const COMPONENT = 'jira-admin/apply-job';

/** How often each web process looks for jobs to start or end. */
export const APPLY_SWEEP_MS = 10_000;

/** How often a running job touches its row. */
const HEARTBEAT_MS = 5_000;

export interface ApplyAccess {
  access: JiraAdminAccess;
  jsm?: JiraAdminAccess;
  automation?: JiraAdminAccess;
}

/**
 * The operator's connections a change runs on — the Jira Administration
 * grant, plus the JSM grant (a request type) or the API token (automation)
 * where the kind needs them — each checked to be on the site the change
 * was proposed for. Or why not. Reconnecting to another site must not
 * redirect an old proposal there.
 */
export async function resolveApplyAccess(
  subject: string,
  change: Pick<ChangeRequest, 'kind' | 'cloudId'>
): Promise<ApplyAccess | string> {
  const access = await resolveJiraAdminAccess({ subject });
  if (typeof access === 'string') return access;
  if (access.cloudId !== change.cloudId) {
    return (
      'Your Jira Administration connection is on a different Jira site than the one this ' +
      'change was proposed for, so it was not applied.'
    );
  }
  let jsm: JiraAdminAccess | undefined;
  if (change.kind === REQUEST_TYPE_KIND) {
    const resolved = await resolveJsmAccess(subject);
    if (typeof resolved === 'string') return resolved;
    if (resolved.cloudId !== change.cloudId) {
      return (
        'Your Jira Service Management connection is on a different Jira site than the one ' +
        'this change was proposed for, so it was not applied.'
      );
    }
    jsm = resolved;
  }
  let automation: JiraAdminAccess | undefined;
  if (isAutomationKind(change.kind)) {
    const resolved = await resolveAutomationAccess({ subject });
    if (typeof resolved === 'string') return resolved;
    if (resolved.cloudId !== change.cloudId) {
      return (
        'Your Atlassian API token was saved for a different Jira site than the one this ' +
        'change was proposed for, so it was not applied. Save it again on the Connectors page.'
      );
    }
    automation = resolved;
  }
  return { access, jsm, automation };
}

function failure(label: string, detail: string): OperationResult[] {
  return [{ label, outcome: 'failed', detail }];
}

function finishedWith(
  change: ChangeRequest,
  status: 'applied' | 'partial' | 'failed',
  results: OperationResult[]
): void {
  recordAuditEvent({
    actorSubject: change.approvedBy ?? change.subject,
    action: 'jira_admin.change_applied',
    targetKind: 'jira_admin_change',
    targetLabel: change.title,
    details: {
      changeId: change.id,
      kind: change.kind,
      status,
      operations: results.length,
      done: results.filter((result) => result.outcome === 'done').length,
      site: change.siteUrl ?? change.cloudId,
      requestedBy: change.subject,
      ...(change.agentId ? { proposedByAgent: change.agentId } : {}),
    },
  });
  notifyChangeOutcome({
    connector: 'jira-admin',
    changeId: change.id,
    title: change.title,
    requester: change.subject,
    approver: change.approvedBy,
    outcome: status,
  });
}

async function end(
  db: Kysely<DB>,
  change: ChangeRequest,
  status: 'applied' | 'partial' | 'failed',
  results: OperationResult[]
): Promise<void> {
  await finishChangeRequest(db, change.id, {
    status,
    results,
    appliedBy: change.approvedBy ?? change.subject,
  });
  finishedWith(change, status, results);
}

/**
 * Run one approved request. Safe to call from anywhere, any number of
 * times: only the call that wins the row's claim does anything. A row
 * already 'applying' here belongs to a job that stopped reporting (the
 * sweep only offers those), and is ended, not run again.
 */
export async function runApplyJob(db: Kysely<DB>, changeId: string): Promise<void> {
  let change = await getChangeRequestById(db, changeId);
  if (!change) return;

  if (change.status === 'applying') {
    if (!(await reclaimStaleChange(db, change.id))) return;
    await end(
      db,
      change,
      'failed',
      failure(
        'Apply the change request',
        'The server stopped partway through this change. Some of it may have reached Jira; check Jira before asking for it again.'
      )
    );
    return;
  }
  if (change.status !== 'queued' || !(await startQueuedChange(db, change.id))) return;
  change = (await getChangeRequestById(db, changeId)) ?? change;

  const approver = change.approvedBy;
  if (!approver) {
    await end(
      db,
      change,
      'failed',
      failure('Start the change', 'No operator is recorded as having approved this change.')
    );
    return;
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const gate = await applyGate(db, approver, [ROLE_OPERATOR], change);
    if (!gate.ok) {
      await end(db, change, 'failed', failure('Check this can still be applied', gate.reason));
      return;
    }
    const resolved = await resolveApplyAccess(approver, change);
    if (typeof resolved === 'string') {
      await end(db, change, 'failed', failure('Connect to Jira', resolved));
      return;
    }

    await setStep(db, change.id, 'Applying the change in Jira');
    heartbeat = setInterval(
      () => void setStep(db, change.id, 'Applying the change in Jira'),
      HEARTBEAT_MS
    );
    const outcome = await applyChangeRequest({ subject: approver }, resolved.access, change, {
      jsm: resolved.jsm,
      automation: resolved.automation,
    });
    clearInterval(heartbeat);
    heartbeat = undefined;
    await end(db, change, outcome.status, outcome.results);
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat);
    logger.error('jira admin change job threw: {message}', {
      component: COMPONENT,
      changeId: change.id,
      message: error instanceof Error ? error.message : String(error),
    });
    await end(
      db,
      change,
      'failed',
      failure(
        'Apply the change request',
        'Something went wrong partway; check Jira for what reached it.'
      )
    );
  }
}

/** One pass: start whatever is queued, and end what lost its job. */
export async function recoverApplyJobs(db: Kysely<DB>): Promise<void> {
  for (const job of await listRunnableChanges(db)) {
    if (isShuttingDown()) return;
    await runApplyJob(db, job.id);
  }
}

/**
 * Start the sweep on this web process. Returns the stop function.
 *
 * Each job it finds runs on its own, not inside the tick: a deploy can
 * take half an hour, and the next queued change must not wait behind it.
 * What is already running here is remembered so a tick does not offer it
 * again (the row's claim would refuse the duplicate anyway).
 */
export function startApplyJobRecovery(db: Kysely<DB>, intervalMs = APPLY_SWEEP_MS): () => void {
  const inFlight = new Set<string>();
  let listing = false;
  const tick = async () => {
    if (listing || isShuttingDown()) return;
    listing = true;
    try {
      for (const job of await listRunnableChanges(db)) {
        if (inFlight.has(job.id) || isShuttingDown()) continue;
        inFlight.add(job.id);
        void runApplyJob(db, job.id)
          .catch((error: unknown) => {
            logger.error('jira admin change job failed: {message}', {
              component: COMPONENT,
              message: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => inFlight.delete(job.id));
      }
    } catch (error) {
      logger.error('jira admin change sweep failed: {message}', {
        component: COMPONENT,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      listing = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  const stop = () => clearInterval(timer);
  const unsubscribe = onShutdown(stop);
  return () => {
    stop();
    unsubscribe();
  };
}
