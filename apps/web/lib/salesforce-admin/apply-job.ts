/**
 * The job that applies an approved Salesforce admin change request, on the
 * server, so nobody has to keep a page open while Salesforce deploys.
 *
 * Approving (app/api/salesforce-admin/changes/[changeId]/apply) only moves
 * the row to 'queued', recording the operator whose own connection the
 * deploy will use, and starts `runApplyJob` in `after()`. The row is the
 * queue: `recoverApplyJobs` (a sweep on every web process, started in
 * instrumentation.ts, the chat turns' recovery shape) picks up a queued
 * row whose process went away before starting it, and an 'applying' row
 * whose job stopped touching it. The job writes what it is doing to
 * `step` as it goes, which is both what the review page shows and the
 * heartbeat that tells a slow job from a dead one.
 *
 * Resuming never re-runs a deploy: a job that died after Salesforce gave
 * the deploy an id carries on from that deploy, and one that died before
 * it is left to read as 'interrupted' (apply.ts, change-requests.ts) —
 * whether Salesforce started anything is unknown, and deploying twice is
 * the worse mistake.
 */

import { ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { notifyChangeOutcome } from '@/lib/admin-changes/notify';
import { logger } from '@/lib/logger';
import { isShuttingDown, onShutdown } from '@/lib/shutdown';
import {
  finishChangeRequest,
  getChangeRequestById,
  listRunnableChanges,
  reclaimStaleChange,
  setStep,
  startQueuedChange,
  type ApplyResults,
  type ChangeRequest,
  type ChangeRequestStatus,
} from './change-requests';
import {
  accessForChange,
  applyChangeRequest,
  applyGate,
  refreshApplying,
  type StepReporter,
} from './apply';

const COMPONENT = 'salesforce-admin/apply-job';

/** How long a job waits on one deploy before leaving it to the sweep. */
export const JOB_DEPLOY_WAIT_MS = 30 * 60 * 1000;

/** How often each web process looks for jobs to start or take over. */
export const APPLY_SWEEP_MS = 10_000;

function failure(label: string, detail: string): ApplyResults {
  return { operations: [{ label, outcome: 'failed', detail }] };
}

function finishedWith(change: ChangeRequest, status: ChangeRequestStatus, results: ApplyResults) {
  const outcome = status === 'applied' || status === 'partial' ? status : 'failed';
  recordAuditEvent({
    actorSubject: change.approvedBy ?? change.subject,
    action: 'salesforce_admin.change_applied',
    targetKind: 'salesforce_admin_change',
    targetLabel: change.title,
    details: {
      changeId: change.id,
      kind: change.kind,
      status,
      connector: change.connectorKey,
      orgId: change.orgId,
      requestedBy: change.subject,
      deployId: results.deployId ?? null,
      quick: results.quick === true,
      ...(change.agentId ? { proposedByAgent: change.agentId } : {}),
    },
  });
  notifyChangeOutcome({
    connector: 'salesforce-admin',
    changeId: change.id,
    title: change.title,
    requester: change.subject,
    approver: change.approvedBy,
    outcome,
  });
}

/**
 * Run (or resume) one approved request. Safe to call from anywhere, any
 * number of times: only the call that wins the row's claim does anything.
 */
export async function runApplyJob(changeId: string): Promise<void> {
  let change = await getChangeRequestById(changeId);
  if (!change) return;

  const resuming = change.status === 'applying';
  if (change.status === 'queued') {
    if (!(await startQueuedChange(change.id))) return;
  } else if (resuming) {
    // Only a job that stopped reporting is taken over.
    if (!(await reclaimStaleChange(change.id))) return;
  } else {
    return;
  }
  change = (await getChangeRequestById(changeId)) ?? change;

  const approver = change.approvedBy;
  const fail = async (label: string, detail: string): Promise<void> => {
    const results = failure(label, detail);
    await finishChangeRequest(change.id, {
      status: 'failed',
      results,
      appliedBy: approver ?? change.subject,
    });
    finishedWith(change, 'failed', results);
  };

  // No deploy id: whether Salesforce started anything is unknown, so it is
  // ended with that said, never guessed at (a second deploy is the worse mistake).
  if (resuming && !change.results?.deployId) {
    await fail(
      'Start the deploy',
      'The server stopped before Salesforce gave this change a deploy id, so it may not have started. Check Setup → Deployment Status before asking for it again.'
    );
    return;
  }

  try {
    if (!approver) {
      await fail('Start the change', 'No operator is recorded as having approved this change.');
      return;
    }
    const context = { subject: approver };
    const onStep: StepReporter = async (step) => {
      if (isShuttingDown()) throw new JobSuspended();
      await setStep(change.id, step);
    };

    const gate = await applyGate(approver, [ROLE_OPERATOR], change);
    if (!gate.ok) {
      await fail('Check this can still be applied', gate.reason);
      return;
    }
    const access = await accessForChange(context, change);
    if (typeof access === 'string') {
      await fail('Connect to Salesforce', access);
      return;
    }

    if (resuming) {
      // A deploy Salesforce already has: carry on from it, never start another.
      await onStep('Picking up the deploy where it was');
      await refreshApplying(context, access, change, JOB_DEPLOY_WAIT_MS, onStep);
    } else {
      const outcome = await applyChangeRequest(
        context,
        access,
        change,
        approver,
        JOB_DEPLOY_WAIT_MS,
        onStep
      );
      if (outcome.status === 'applying') return; // Still deploying: the sweep follows it up.
      finishedWith(change, outcome.status, outcome.results);
      return;
    }
    const finished = await getChangeRequestById(change.id);
    if (finished && finished.status !== 'applying' && finished.status !== 'queued') {
      finishedWith(finished, finished.status, finished.results ?? { operations: [] });
    }
  } catch (error) {
    if (error instanceof JobSuspended) {
      // The process is going down; the row stays 'applying' and another
      // process's sweep takes it over once its heartbeat has gone quiet.
      return;
    }
    logger.error('salesforce admin change job threw: {message}', {
      component: COMPONENT,
      changeId: change.id,
      message: error instanceof Error ? error.message : String(error),
    });
    const fresh = await getChangeRequestById(change.id);
    // A deploy that already started is followed up by the sweep; one that
    // never did is a failure to say plainly.
    if (fresh?.status === 'applying' && !fresh.results?.deployId) {
      await fail(
        'Apply the change',
        'Something went wrong before Salesforce started a deploy; nothing was deployed.'
      );
    }
  }
}

class JobSuspended extends Error {}

/** One pass: start or take over whatever is waiting. */
export async function recoverApplyJobs(): Promise<void> {
  for (const job of await listRunnableChanges()) {
    if (isShuttingDown()) return;
    await runApplyJob(job.id);
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
export function startApplyJobRecovery(intervalMs = APPLY_SWEEP_MS): () => void {
  const inFlight = new Set<string>();
  let listing = false;
  const tick = async () => {
    if (listing || isShuttingDown()) return;
    listing = true;
    try {
      for (const job of await listRunnableChanges()) {
        if (inFlight.has(job.id) || isShuttingDown()) continue;
        inFlight.add(job.id);
        void runApplyJob(job.id)
          .catch((error: unknown) => {
            logger.error('salesforce admin change job failed: {message}', {
              component: COMPONENT,
              message: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => inFlight.delete(job.id));
      }
    } catch (error) {
      logger.error('salesforce admin change sweep failed: {message}', {
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
