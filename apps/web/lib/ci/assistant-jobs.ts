/**
 * The pipeline builder's assistant, answered in the background so the
 * page holds no request open while the model reads the repository and
 * thinks (that can take minutes). The salesforce-admin apply job's shape:
 *
 *   POST …/pipeline-builder/assistant          a job row, then 202 { jobId };
 *                                              the work runs in `after()`
 *   GET  …/pipeline-builder/assistant/[jobId]  the row: running with its
 *                                              step, or the answer, or why not
 *
 * The question lives only in the process working on it; the row holds what
 * it is doing (`step`) and, at the end, the answer or the error. Each step
 * is also the heartbeat: a running job silent for STALE_MS reads as
 * interrupted (its process went away — a deploy, a restart), so a page
 * never waits forever, and asking again is the remedy. Jobs are kept a day.
 *
 * Every model call goes to the usage ledger under purpose
 * `pipeline_assistant`, attributed to the person who asked (meteredComplete).
 */

import type { ResolvedLlm } from '@renkei/agent-llm';
import { recordLlmCall } from '@renkei/agents/runs';
import { getDataStore, type CiAssistantJobRecord, type Json } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import {
  runPipelineAssistant,
  type AssistantDeps,
  type AssistantInput,
  type AssistantReply,
} from './pipeline-assistant';

/** A running job this long without a step is taken as interrupted. */
export const STALE_MS = 5 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;
export const INTERRUPTED =
  'The assistant stopped before it answered (the server restarted); ask again.';

const jobs = () => getDataStore().ciAssistantJobs;

export type AssistantJobView =
  | { status: 'running'; step: string | null }
  /** The AssistantReply finishJob wrote, as stored. */
  | { status: 'succeeded'; answer: Json }
  | { status: 'failed'; error: string };

/** An answer as the job stores it: its JSON round trip. */
function asJson(reply: AssistantReply): Json {
  const value: Json = JSON.parse(JSON.stringify(reply));
  return value;
}

/** A job as the page reads it, `now` deciding whether a silent one was interrupted. */
export function jobView(job: CiAssistantJobRecord, now: Date): AssistantJobView {
  if (job.status === 'running') {
    return now.getTime() - job.updatedAt.getTime() > STALE_MS
      ? { status: 'failed', error: INTERRUPTED }
      : { status: 'running', step: job.step };
  }
  if (job.status === 'succeeded' && isRecord(job.result)) {
    return { status: 'succeeded', answer: job.result };
  }
  return { status: 'failed', error: job.error ?? 'The assistant did not answer.' };
}

/**
 * The model's `complete`, each answered call written to the usage ledger
 * as this person's spend. A failed write never fails the call.
 */
export function meteredComplete(
  llm: Pick<ResolvedLlm, 'provider' | 'providerName' | 'model' | 'modelConfigId'>,
  subject: string
): AssistantDeps['complete'] {
  return async (request) => {
    const startedAt = Date.now();
    const result = await llm.provider.complete(request);
    if (result.ok) {
      const usage = result.val.usage;
      await recordLlmCall({
        subject,
        agentId: null,
        purpose: 'pipeline_assistant',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - startedAt,
        ...(usage.cacheReadInputTokens !== undefined
          ? { cacheReadInputTokens: usage.cacheReadInputTokens }
          : {}),
        ...(usage.cacheWriteInputTokens !== undefined
          ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
          : {}),
        model: { provider: llm.providerName, model: llm.model, llmModelId: llm.modelConfigId },
      }).catch(() => undefined);
    }
    return result;
  };
}

/** Start a job for this person and project (and drop yesterday's). */
export async function startAssistantJob(
  id: string,
  subject: string,
  projectId: string,
  now: Date
): Promise<void> {
  await jobs().pruneBefore(new Date(now.getTime() - KEEP_MS));
  await jobs().create({ id, subject, projectId, step: 'Starting' }, now);
}

/** One of this person's jobs on this project, as the page reads it; null when there is none. */
export async function readAssistantJob(
  subject: string,
  projectId: string,
  id: string,
  now: Date
): Promise<AssistantJobView | null> {
  const job = await jobs().find(subject, id);
  return job && job.projectId === projectId ? jobView(job, now) : null;
}

/**
 * Work the question out and write the outcome to the job. Never throws:
 * whatever goes wrong ends the job with words the page shows.
 */
export async function runAssistantJob(
  id: string,
  about: { subject: string; project: string; repository: string },
  prepare: () => Promise<
    { input: AssistantInput; deps: Omit<AssistantDeps, 'onStep'> } | { error: string }
  >
): Promise<void> {
  const step = async (text: string) => {
    await jobs().progress(id, text, new Date());
  };
  const log = async () => ({
    component: 'ci/assistant-jobs',
    ...(await whoIs(about.subject)),
    project: about.project,
    repository: about.repository,
    jobId: id,
  });
  try {
    const ready = await prepare();
    if ('error' in ready) {
      await jobs().finish(id, { status: 'failed', error: ready.error }, new Date());
      return;
    }
    const reply = await runPipelineAssistant(ready.input, { ...ready.deps, onStep: step });
    if ('error' in reply) {
      logger.warn(
        '{actor} asked the pipeline assistant of the project "{project}" ({repository}), but the model did not answer; nothing was proposed: {error}',
        { ...(await log()), error: reply.error }
      );
      await jobs().finish(id, { status: 'failed', error: reply.error }, new Date());
      return;
    }
    logger.info(
      '{actor} asked the pipeline assistant of the project "{project}" ({repository}); it read {reads} paths and proposed {proposed}',
      {
        ...(await log()),
        reads: reply.read.length,
        proposed:
          [reply.proposal ? 'a pipeline' : '', reply.buildingBlock ? 'a building block' : '']
            .filter(Boolean)
            .join(' and ') || 'nothing',
      }
    );
    await jobs().finish(id, { status: 'succeeded', result: asJson(reply) }, new Date());
  } catch (error) {
    logger.error(
      '{actor} asked the pipeline assistant of the project "{project}" ({repository}), and working it out failed; nothing was proposed: {error}',
      { ...(await log()), error: error instanceof Error ? error.message : String(error) }
    );
    await jobs()
      .finish(
        id,
        { status: 'failed', error: 'The assistant failed while working it out; ask again.' },
        new Date()
      )
      .catch(() => undefined);
  }
}
