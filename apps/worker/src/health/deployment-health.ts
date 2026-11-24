/**
 * Applications that went quiet.
 *
 * A deployed application tells Renkei how it is by checking in
 * (apps/web/lib/ci/health-rules.ts); Renkei never calls it. So nothing
 * arrives when one stops: its lateness is read from the last check-in and
 * the clock (@renkei/ci-blocks health.ts). This sweep is what notices —
 * every pass it reads each environment that has ever checked in, and
 * where the state now is not the one last announced (overdue: potentially
 * failing; three missed in a row: failed; said it was stopping and went
 * quiet: stopped) it moves the announced state and enqueues the change
 * for deployments/changes.ts to tell people and wake agents.
 *
 * The announced state moves by compare-and-set (`ciHealth.announce`), so a
 * check-in arriving at the same moment in the web app and a second worker
 * replica each announce a given change at most once between them.
 */

import { getDataStore, type CiHealthRecord } from '@renkei/db';
import {
  DEPLOYMENTS_SOURCE,
  HEALTH_CHANGED,
  healthChange,
  type HealthChanged,
} from '@renkei/ci-blocks';
import { eventsQueue } from '../queue';
import { logger } from '../logger';

const COMPONENT = 'deployments/health-sweep';

export const DEPLOYMENT_HEALTH_SWEEP_INTERVAL_MS = 60_000;

function changeOf(record: CiHealthRecord, now: Date): HealthChanged | null {
  const change = healthChange(
    {
      status: record.status,
      sentAt: record.sentAt?.toISOString() ?? null,
      intervalSeconds: record.intervalSeconds,
      announcedState: record.announcedState,
    },
    now.getTime()
  );
  if (!change) return null;
  return {
    kind: 'health',
    projectId: record.projectId,
    environment: record.environment,
    state: change.to,
    previous: change.from,
    missed: change.missed,
    message: record.message,
    version: record.version,
    at: now.toISOString(),
  };
}

export function createDeploymentHealthSweep(clock: () => Date = () => new Date()) {
  return async (): Promise<void> => {
    const store = getDataStore().ciHealth;
    const now = clock();
    for (const record of await store.listCheckedIn()) {
      const change = changeOf(record, now);
      if (!change) continue;
      if (
        !(await store.announce(record.projectId, record.environment, change.previous, change.state))
      ) {
        continue;
      }
      const enqueued = await eventsQueue.producer.enqueue({
        source: DEPLOYMENTS_SOURCE,
        type: HEALTH_CHANGED,
        payload: { ...change },
        orderingKey: `deployments/${record.projectId}/${record.environment}`,
      });
      if (!enqueued.ok) {
        logger.error(
          'the application in {environment} of project {projectId} went from {previous} to {state}, but the change could not be queued: {error}; nobody was told',
          {
            component: COMPONENT,
            projectId: record.projectId,
            environment: record.environment,
            previous: change.previous ?? 'nothing',
            state: change.state,
            error: enqueued.err.message ?? 'unknown',
          }
        );
      }
    }
  };
}
