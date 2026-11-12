/**
 * The library's bulk acts — delete, run OCR, add to a project — done on the
 * server, so nobody has to keep the page open while they work through the
 * files (migration 178).
 *
 * The select toolbar sends one request (app/api/chat/artifacts/bulk): it
 * is checked, written as a 'queued' row and started in `after()`. The row
 * is the queue, the apply-job way (lib/jira-admin/apply-job.ts): a sweep
 * on every web process (instrumentation.ts) starts a queued row whose
 * process went away before starting it, and takes over a running row that
 * stopped touching itself. Every act is safe to repeat — a deleted file is
 * no longer found, a file attached again keeps one reference, a file being
 * read refuses a second read — so a job taken over carries on with the
 * files it has no answer for yet, rather than ending as an apply job does.
 *
 * Each file is done as the one-file routes do it (artifact-routes.ts), as
 * the person who asked, and its answer is written to the row as it lands:
 * that is the job's heartbeat and what the library shows while it runs. A
 * job where nothing failed is dismissed as it ends; one where something did
 * stays on the library page, naming the files, until the person closes it.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type ArtifactBulkJobRecord, type ArtifactBulkResult } from '@renkei/db';
import { resolveMistralOcrConfig } from '@renkei/connector-mistral-ocr';
import { isRecord } from '@renkei/guards';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { isShuttingDown, onShutdown } from '@/lib/shutdown';
import { resolveResourceAccess } from './access';
import { resolveArtifactAccess } from './artifact-access';
import { attachToProject, deleteArtifact, leaveArtifact } from './artifact-library';
import { claimArtifactOcr, ocrRefusalFor, runArtifactOcr } from './artifact-ocr';
import { actErrorMessage, OCR_REFUSALS } from './artifact-routes';
import { isReferenceMode, type ReferenceMode } from './attachments';

const COMPONENT = 'chat/artifact-bulk-job';

/** The most files one request may name. */
export const BULK_MAX_FILES = 500;
/** A running job untouched for this long lost its process; the sweep takes it over. */
export const BULK_STALE_MS = 2 * 60_000;
/** How often a running job touches its row while one file takes its time (a long OCR read). */
const HEARTBEAT_MS = 5_000;
/** How often each web process looks for jobs to start or take over. */
export const BULK_SWEEP_MS = 10_000;
/** The library shows at most this many of a person's jobs. */
export const BULK_JOBS_SHOWN = 5;

export type BulkAction = 'delete' | 'ocr' | 'attach';

export type BulkRequest =
  | { action: 'delete' | 'ocr'; artifactIds: string[] }
  | { action: 'attach'; artifactIds: string[]; projectId: string; mode: ReferenceMode };

/** Why a request was not taken: the status, code and sentence its answer carries. */
export interface BulkRefusal {
  status: number;
  code: string;
  message: string;
}

/** Taken, or refused with why. */
export type Taken<T> = { ok: true; val: T } | { ok: false; err: BulkRefusal };

const ok = <T>(val: T): Taken<T> => ({ ok: true, val });
const err = (refused: BulkRefusal): { ok: false; err: BulkRefusal } => ({
  ok: false,
  err: refused,
});
const refusal = (status: number, code: string, message: string): BulkRefusal => ({
  status,
  code,
  message,
});

/** The request's body as the job takes it: known action, one to BULK_MAX_FILES file ids, once each. */
export function parseBulkRequest(body: unknown): Taken<BulkRequest> {
  if (!isRecord(body)) return err(refusal(400, 'invalid', 'Say what to do with which files'));
  const action = body.action;
  if (action !== 'delete' && action !== 'ocr' && action !== 'attach') {
    return err(refusal(400, 'invalid', 'Say delete, ocr or attach'));
  }
  const listed = Array.isArray(body.artifactIds) ? body.artifactIds : [];
  const valid = listed.filter((id): id is string => typeof id === 'string' && isUuid(id));
  const artifactIds = [...new Set(valid)];
  if (artifactIds.length === 0 || valid.length !== listed.length) {
    return err(refusal(400, 'invalid', 'Name the files by their ids'));
  }
  if (artifactIds.length > BULK_MAX_FILES) {
    return err(refusal(400, 'too-many', `At most ${BULK_MAX_FILES} files at a time`));
  }
  if (action !== 'attach') return ok({ action, artifactIds });
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!isUuid(projectId)) return err(refusal(400, 'invalid', 'Choose a project'));
  const mode: ReferenceMode = isReferenceMode(body.mode) ? body.mode : 'on_demand';
  return ok({ action, artifactIds, projectId, mode });
}

/** "delete 26 files", "run OCR on 1 file", "add 3 files to a project": the act, for log lines. */
function actOf(job: Pick<ArtifactBulkJobRecord, 'action' | 'artifactIds'>): string {
  const count = `${job.artifactIds.length} ${job.artifactIds.length === 1 ? 'file' : 'files'}`;
  if (job.action === 'ocr') return `run OCR on ${count}`;
  if (job.action === 'attach') return `add ${count} to a project`;
  return `delete ${count}`;
}

/**
 * Takes a request: checks what can be checked once for every file (the
 * project, whether OCR is set up), writes the job and hands back its row.
 * The caller starts it (`runBulkJob`, in after()).
 */
export async function queueBulkJob(
  subject: string,
  request: BulkRequest
): Promise<Taken<ArtifactBulkJobRecord>> {
  if (request.action === 'attach') {
    const project = await resolveResourceAccess(subject, 'chat_project', request.projectId);
    if (!project) return err(refusal(404, 'not-found', 'No such project'));
    if (project.role === 'viewer') {
      return err(refusal(403, 'forbidden', 'You may read this project, not add files to it.'));
    }
  }
  if (request.action === 'ocr' && !(await resolveMistralOcrConfig()).ok) {
    return err(refusal(503, 'unconfigured', OCR_REFUSALS.unconfigured.message));
  }
  const job = await getDataStore().artifactBulkJobs.create({
    id: randomUUID(),
    subject,
    action: request.action,
    projectId: request.action === 'attach' ? request.projectId : null,
    mode: request.action === 'attach' ? request.mode : null,
    artifactIds: request.artifactIds,
  });
  logger.info('{actor} asked to {act} from their artifacts; it runs on the server', {
    component: COMPONENT,
    ...(await whoIs(subject)),
    act: actOf(job),
    jobId: job.id,
    action: job.action,
    files: job.artifactIds.length,
    ...(job.projectId ? { projectId: job.projectId } : {}),
  });
  return ok(job);
}

/** Does one file of a job as the one-file route does, as the person who asked. */
export type BulkAct = (
  job: ArtifactBulkJobRecord,
  artifactId: string
) => Promise<ArtifactBulkResult>;

const FORBIDDEN = actErrorMessage('FORBIDDEN');
const NOT_FOUND = actErrorMessage('NOT_FOUND');

/** The real acts: delete (or leave), OCR, attach. */
export const actOnFile: BulkAct = async (job, artifactId) => {
  const access = await resolveArtifactAccess(job.subject, artifactId);
  if (!access) return { id: artifactId, filename: null, error: NOT_FOUND };
  const answer = (error: string | null): ArtifactBulkResult => ({
    id: artifactId,
    filename: access.row.filename,
    error,
  });
  if (job.action === 'delete') {
    if (access.role === 'owner') {
      return answer((await deleteArtifact(access.row)) ? null : NOT_FOUND);
    }
    if (access.role === 'use') {
      return answer((await leaveArtifact({ subject: job.subject, artifactId })) ? null : NOT_FOUND);
    }
    return answer(FORBIDDEN);
  }
  if (job.action === 'ocr') {
    if (access.role !== 'owner') return answer(FORBIDDEN);
    const refused = ocrRefusalFor(access) ?? (await claimArtifactOcr(artifactId));
    if (refused) return answer(OCR_REFUSALS[refused].message);
    // One read at a time: a job over fifty scans does not ask for fifty at once.
    await runArtifactOcr(artifactId, job.subject);
    return answer(null);
  }
  if (job.action === 'attach' && job.projectId) {
    const attached = await attachToProject({
      actorSubject: job.subject,
      artifactId,
      projectId: job.projectId,
      mode: isReferenceMode(job.mode) ? job.mode : 'on_demand',
    });
    return answer(attached.ok ? null : actErrorMessage(attached.err.type));
  }
  return answer('This job asks for nothing that can be done.');
};

/** A file whose act threw: said so on its line, logged with who asked. */
async function crashed(
  job: ArtifactBulkJobRecord,
  artifactId: string,
  error: unknown
): Promise<ArtifactBulkResult> {
  logger.error(
    'a file in the bulk job {actor} asked for (to {act}) crashed; it was left as it was and the job went on: {message}',
    {
      component: COMPONENT,
      ...(await whoIs(job.subject)),
      act: actOf(job),
      jobId: job.id,
      artifactId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }
  );
  return { id: artifactId, filename: null, error: 'Something went wrong; it was not done.' };
}

/** How a job ends, from its answers: done, partial, or failed when nothing went through. */
export function outcomeOf(results: readonly ArtifactBulkResult[]): 'done' | 'partial' | 'failed' {
  const failed = results.filter((result) => result.error !== null).length;
  if (failed === 0) return 'done';
  return failed === results.length ? 'failed' : 'partial';
}

async function ended(job: ArtifactBulkJobRecord, results: readonly ArtifactBulkResult[]) {
  const status = outcomeOf(results);
  await getDataStore().artifactBulkJobs.finish(job.id, { status, dismiss: status === 'done' });
  const failures = results.filter((result) => result.error !== null);
  const attrs = {
    component: COMPONENT,
    ...(await whoIs(job.subject)),
    act: actOf(job),
    jobId: job.id,
    action: job.action,
    files: results.length,
    failed: failures.length,
    status,
  };
  if (status === 'done') {
    logger.info('the bulk job {actor} asked for (to {act}) is done', attrs);
    return;
  }
  logger.warn(
    'the bulk job {actor} asked for (to {act}) ended {status}: {failed} of {files} were not done, first "{filename}": {error}',
    { ...attrs, filename: failures[0]?.filename ?? 'a file', error: failures[0]?.error ?? '' }
  );
}

/**
 * Runs one job. Safe to call any number of times from anywhere: only the
 * call that wins the row's claim does anything. A running row here belongs
 * to a job that stopped touching it (only the sweep offers those); it is
 * taken over and carries on with the files it has no answer for.
 */
export async function runBulkJob(jobId: string, act: BulkAct = actOnFile): Promise<void> {
  if (!isUuid(jobId)) return;
  const jobs = getDataStore().artifactBulkJobs;
  const job = await jobs.get(jobId);
  if (!job) return;
  const claimed =
    job.status === 'queued'
      ? await jobs.startQueued(job.id)
      : job.status === 'running' && (await jobs.reclaimStale(job.id, BULK_STALE_MS));
  if (!claimed) return;

  const results: ArtifactBulkResult[] = [...job.results];
  const answered = new Set(results.map((result) => result.id));
  const heartbeat = setInterval(() => void jobs.recordResults(job.id, results), HEARTBEAT_MS);
  try {
    for (const artifactId of job.artifactIds) {
      if (answered.has(artifactId)) continue;
      // A process going away leaves the job running; the next sweep, here or
      // elsewhere, takes it over once it goes stale.
      if (isShuttingDown()) return;
      const result = await act(job, artifactId).catch((error: unknown) =>
        crashed(job, artifactId, error)
      );
      results.push(result);
      answered.add(artifactId);
      // False when another process took the job over (this one stalled): it carries on, not us.
      if (!(await jobs.recordResults(job.id, results))) return;
    }
    await ended(job, results);
  } catch (error) {
    logger.error(
      'the bulk job {actor} asked for (to {act}) crashed between files; it is marked failed: {message}',
      {
        component: COMPONENT,
        ...(await whoIs(job.subject)),
        act: actOf(job),
        jobId: job.id,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }
    );
    await jobs.finish(job.id, {
      status: 'failed',
      lastError: 'Something went wrong partway; the files not listed were left as they were.',
      dismiss: false,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Starts the sweep on this web process; returns the stop function. Each job
 * it finds runs on its own, not inside the tick, and what already runs here
 * is not offered again (the row's claim would refuse the duplicate anyway).
 */
export function startBulkJobRecovery(intervalMs = BULK_SWEEP_MS): () => void {
  const inFlight = new Set<string>();
  let listing = false;
  const tick = async () => {
    if (listing || isShuttingDown()) return;
    listing = true;
    try {
      for (const job of await getDataStore().artifactBulkJobs.listRunnable(BULK_STALE_MS, 5)) {
        if (inFlight.has(job.id) || isShuttingDown()) continue;
        inFlight.add(job.id);
        void runBulkJob(job.id)
          .catch((error: unknown) => {
            logger.error(
              'an artifact bulk job threw outside its own handler; it is left for the next sweep: {message}',
              {
                component: COMPONENT,
                jobId: job.id,
                message: error instanceof Error ? error.message : String(error),
              }
            );
          })
          .finally(() => inFlight.delete(job.id));
      }
    } catch (error) {
      logger.error(
        'the artifact bulk job sweep failed; queued jobs wait for the next pass: {message}',
        { component: COMPONENT, message: error instanceof Error ? error.message : String(error) }
      );
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

/** A job as the library shows it: what is being done, how far it got, what failed. */
export interface BulkJobView {
  id: string;
  action: BulkAction;
  /** 'queued' | 'running' | 'done' | 'partial' | 'failed'. */
  status: string;
  projectId: string | null;
  total: number;
  /** Files answered so far. */
  answered: number;
  /** The files not answered yet, while the job is live. */
  pendingIds: string[];
  /** The files that were not done: what each was called and why. */
  failures: { id: string; filename: string | null; error: string }[];
  /** Why the job as a whole stopped, when it did. */
  lastError: string | null;
}

const isAction = (value: string): value is BulkAction =>
  value === 'delete' || value === 'ocr' || value === 'attach';

export function bulkJobView(job: ArtifactBulkJobRecord): BulkJobView | null {
  if (!isAction(job.action)) return null;
  const answered = new Set(job.results.map((result) => result.id));
  const live = job.status === 'queued' || job.status === 'running';
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    projectId: job.projectId,
    total: job.artifactIds.length,
    answered: job.results.length,
    pendingIds: live ? job.artifactIds.filter((id) => !answered.has(id)) : [],
    failures: job.results.flatMap((result) =>
      result.error === null
        ? []
        : [{ id: result.id, filename: result.filename, error: result.error }]
    ),
    lastError: job.lastError,
  };
}

/** The person's jobs the library shows: live ones, and finished ones they have not closed. */
export async function listShownBulkJobs(subject: string): Promise<BulkJobView[]> {
  const jobs = await getDataStore().artifactBulkJobs.listShown(subject, BULK_JOBS_SHOWN);
  return jobs.flatMap((job) => {
    const view = bulkJobView(job);
    return view ? [view] : [];
  });
}

/** The person closes a finished job's line. False when it is not theirs or not finished. */
export async function dismissBulkJob(subject: string, jobId: string): Promise<boolean> {
  if (!isUuid(jobId)) return false;
  return getDataStore().artifactBulkJobs.dismiss(jobId, subject);
}
