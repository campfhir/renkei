/**
 * Raising a change: a deployment reported, or a deployed application's
 * health became something else. The web app only notices and enqueues —
 * who is told, by which of their settings, and which agents wake is the
 * worker's (apps/worker/src/deployments/changes.ts), reached through the
 * events queue so a slow push or mail never holds a pipeline's report or
 * an application's check-in.
 *
 * A change says what happened to which environment (@renkei/ci-blocks
 * changes.ts). It carries no variable, token or request body.
 *
 * Health is announced once per state: the environment's row keeps the
 * state last announced, moved by compare-and-set, so a check-in here and
 * the worker's sweep (which notices silence) never both announce one.
 * Raising never throws: a change that could not be queued is logged, and
 * the report or check-in that caused it still stands.
 */

import { getDataStore, type CiHealthRecord } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import {
  DEPLOYMENTS_SOURCE,
  changeId,
  changeType,
  healthChange,
  type DeploymentsChange,
  type HealthChanged,
} from '@renkei/ci-blocks';
import { logger } from '@/lib/logger';

const COMPONENT = 'ci/deployment-changes';

export async function raiseChange(change: DeploymentsChange): Promise<boolean> {
  try {
    const enqueued = await webhookEventsQueue().producer.enqueue({
      source: DEPLOYMENTS_SOURCE,
      type: changeType(change),
      payload: { ...change },
      orderingKey: `deployments/${change.projectId}/${change.environment}`,
    });
    if (enqueued.ok) return true;
    throw new Error(enqueued.err.message ?? 'the queue refused it');
  } catch (error) {
    logger.error(
      'a change to {environment} of project {projectId} ({change}) could not be queued: {error}; nobody was notified and no agent was woken',
      {
        component: COMPONENT,
        projectId: change.projectId,
        environment: change.environment,
        change: changeId(change),
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return false;
  }
}

/**
 * Announce an environment's health if it is not the state last announced:
 * after a check-in, or when its page is read and the clock has moved it
 * (the worker's sweep does the same on its own rhythm). Answers the change
 * raised, or null.
 */
export async function settleHealth(
  record: CiHealthRecord,
  now: Date
): Promise<HealthChanged | null> {
  const found = healthChange(
    {
      status: record.status,
      sentAt: record.sentAt?.toISOString() ?? null,
      intervalSeconds: record.intervalSeconds,
      announcedState: record.announcedState,
    },
    now.getTime()
  );
  if (!found) return null;
  try {
    const moved = await getDataStore().ciHealth.announce(
      record.projectId,
      record.environment,
      found.from,
      found.to
    );
    if (!moved) return null;
  } catch {
    // The page or the check-in matters more; the sweep will look again.
    return null;
  }
  const change: HealthChanged = {
    kind: 'health',
    projectId: record.projectId,
    environment: record.environment,
    state: found.to,
    previous: found.from,
    missed: found.missed,
    message: record.message,
    version: record.version,
    at: now.toISOString(),
  };
  await raiseChange(change);
  return change;
}
