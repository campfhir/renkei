/**
 * The two housekeeping sweeps: retention (delete run history past the
 * org's window) and the stuck-run janitor (close runs whose queue job is
 * gone). Both are idempotent and re-runnable, so N replicas sweeping at
 * once cost duplicate reads, never wrong writes.
 */

import { getDataStore } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { recordAgentRunOutcome } from '@renkei/agents/runs';
import { deleteStaleChatPresence } from '@renkei/notifications';
import { logger } from './logger';

/**
 * Well past the org's `chatReplyPresenceWindowSeconds` (capped at 300s at
 * the admin API) — a presence row this old cannot satisfy the window, so
 * there is no setting to consult here, unlike the sweeps above.
 */
const CHAT_PRESENCE_MAX_AGE_MS = 60 * 60_000;

const RETENTION_BATCH = 500;
const DAY_MS = 86_400_000;
/** A queued or running run this old with no live job has been abandoned. */
const STUCK_RUN_MS = 2 * 60 * 60_000;
const ABANDONED_ERROR = 'The run was abandoned — its job left the queue without finishing.';

/**
 * Delete runs older than agentRunRetentionDays. Batched so a neglected
 * table never produces one giant delete; steps go via cascade. One batch
 * per pass — the hourly cadence catches up quickly and a pass stays cheap.
 */
export function createRetentionSweep() {
  return async function sweep(): Promise<void> {
    const settingsResult = await getOrgSettings();
    if (!settingsResult.ok) return;
    const days = settingsResult.val.agentRunRetentionDays;

    const deleted = await getDataStore().agentRuns.pruneFinishedBefore(
      new Date(Date.now() - days * DAY_MS),
      RETENTION_BATCH
    );
    if (deleted > 0) {
      logger.info('retention pruned {count} runs', {
        component: 'worker-agents/retention',
        count: deleted,
      });
    }
  };
}

/**
 * Delete notifications older than agentNotificationRetentionDays — the
 * same shape as the run sweep above,
 * and unwrapped by `withSweepLock` for the same reason: a bounded DELETE is
 * idempotent, so two replicas running it cost a duplicate read and never a
 * wrong write.
 *
 * A notification is deleted whether or not it was ever read. Retention is
 * about how long the record of an act lives, not about whether somebody got
 * round to looking — and an unread notification from three weeks ago is not
 * going to be read now.
 */
export function createNotificationRetentionSweep() {
  return async function sweep(): Promise<void> {
    const settingsResult = await getOrgSettings();
    if (!settingsResult.ok) return;
    const days = settingsResult.val.agentNotificationRetentionDays;

    const deleted = await getDataStore().notifications.pruneBefore(
      new Date(Date.now() - days * DAY_MS),
      RETENTION_BATCH
    );
    if (deleted > 0) {
      logger.info('retention pruned {count} notifications', {
        component: 'worker-agents/notification-retention',
        count: deleted,
      });
    }
  };
}

/**
 * Close runs the queue has forgotten. A 'running' run whose wall clock is
 * spent AND whose agent_jobs row no longer exists (completed, dead-lettered
 * with a stale payload, or manually purged) will never be claimed again —
 * without this it would sit as 'running' forever, holding its agent's
 * ordering key hostage in every human's mental model if not the queue's.
 *
 * The live-job check is what keeps the janitor from racing a real worker:
 * a slow-but-alive run still has its processing row, and is left alone.
 */
export function createStuckRunJanitor() {
  return async function sweep(): Promise<void> {
    const store = getDataStore();
    const stuck = await store.agentRuns.listStaleInProgress(
      new Date(Date.now() - STUCK_RUN_MS),
      50
    );

    for (const run of stuck) {
      if (await store.queues.hasLiveAgentRunJob(run.id)) continue;

      await store.agentRuns.failAbandoned(run.id, {
        errorKind: 'timeout',
        error: ABANDONED_ERROR,
      });
      // The run log must agree: an abandoned run is a failed run there too.
      await recordAgentRunOutcome({
        agentId: run.agentId,
        runId: run.id,
        ownerSubject: run.ownerSubject,
        status: 'failed',
        errorKind: 'timeout',
        error: ABANDONED_ERROR,
      });
      logger.warn('janitor closed abandoned run {runId}', {
        component: 'worker-agents/janitor',
        runId: run.id,
      });
    }
  };
}

/**
 * Prune the usage ledgers — the run log (083), the token ledger (085)
 * the voice ledger (110) and the image ledger (132) — past the org's
 * agentUsageRetentionDays. The run sweep's shape: one bounded, idempotent
 * DELETE per table per pass. Longer than run retention by default (a year
 * vs 30 days) because these are what make a year of usage readable after
 * the runs are gone.
 */
export function createUsageRetentionSweep() {
  return async function sweep(): Promise<void> {
    const settingsResult = await getOrgSettings();
    if (!settingsResult.ok) return;
    const days = settingsResult.val.agentUsageRetentionDays;

    const pruned = await getDataStore().agentUsage.pruneLedgersBefore(
      new Date(Date.now() - days * DAY_MS),
      RETENTION_BATCH
    );
    if (
      pruned.runLog > 0 ||
      pruned.llmCalls > 0 ||
      pruned.voice > 0 ||
      pruned.images > 0 ||
      pruned.documents > 0
    ) {
      logger.info(
        'retention pruned {runs} run log row(s), {calls} token ledger row(s), {voice} voice ledger row(s), {images} image ledger row(s) and {documents} document ledger row(s)',
        {
          component: 'worker-agents/usage-retention',
          voice: pruned.voice,
          images: pruned.images,
          documents: pruned.documents,
          runs: pruned.runLog,
          calls: pruned.llmCalls,
        }
      );
    }
  };
}

/**
 * Prune `chat_presence` rows a chat's turn stream heartbeat left behind
 * (@renkei/notifications' presence.ts, touched by chats/[chatId]/turns/
 * [turnId]/stream/route.ts). Unlike the sweeps above this is hygiene on a
 * table nothing reads past a fixed, generous age, not a retention policy
 * an org has a reason to tune.
 */
export function createChatPresenceSweep() {
  return async function sweep(): Promise<void> {
    const deleted = await deleteStaleChatPresence(CHAT_PRESENCE_MAX_AGE_MS);
    if (deleted > 0) {
      logger.info('pruned {count} stale chat presence row(s)', {
        component: 'worker-agents/chat-presence-sweep',
        count: deleted,
      });
    }
  };
}
