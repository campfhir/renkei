/**
 * A GitHub or Bitbucket webhook delivery, matched against pr_subscriptions
 * and turned into a recorded pr_pipeline_events row plus, per that
 * subscription's own opt-ins, an automatic merge or a note in the chat
 * that pushed the PR. Never trusts the delivery's own conclusion — it
 * re-fetches the run/pipeline under the SUBSCRIBER's own token before
 * acting, the same rationale every other webhook handler in this app
 * follows (see e.g. handlers/zoom-events.ts's header comment).
 *
 * GitHub's `workflow_run` payload names the exact PR(s) a run belongs
 * to, so matching narrows to those PR numbers. Bitbucket has no single
 * "pipeline completed" webhook event — commit-status updates
 * (repo:commit_status_updated) are the closest signal, and they name a
 * commit, not a PR — so the Bitbucket path instead re-checks every
 * active subscription for the repository directly (bounded: a repo
 * rarely has more than a handful of subscribed PRs at once), reading
 * each PR's current head commit's build statuses.
 *
 * "Auto-fix" does not restart the agent unattended — this worker has no
 * way to start a new chat turn (see chat-note.ts's header comment for
 * why). On a failing, auto-fix-opted-in subscription it posts a note
 * into the chat instead, naming the failure, ready for whoever opens
 * the chat next.
 */

import { getDataStore, type PrPipelineSubscriptionRecord } from '@renkei/db';
import type { EventHandler } from '../handlers';
import type { ClaimedEvent } from '../queue';
import { logger } from '../logger';
import { GITHUB, ATLASSIAN_BITBUCKET } from '@renkei/provider-grants';
import type { AuthedFetch } from '@renkei/delegate-client';
import { resolveGitHubSubjectAccess, resolveBitbucketSubjectAccess } from './repo-access';
import {
  getGitHubWorkflowRunConclusion,
  mergeGitHubPullRequest,
  getBitbucketCommitStatusConclusion,
  mergeBitbucketPullRequest,
  type PipelineConclusion,
} from './repo-host-lite';
import { insertChatNote } from './chat-note';

const COMPONENT = 'repo/pr-pipeline-events';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type ActionTaken = 'merged' | 'merge_failed' | 'fix_started' | 'fix_failed' | null;

type SubscriptionRow = PrPipelineSubscriptionRecord;

function activeSubscriptions(
  provider: string,
  repoFullName: string,
  prNumber?: number
): Promise<SubscriptionRow[]> {
  return getDataStore().codeProjects.listPipelineSubscriptions(provider, repoFullName, prNumber);
}

/** A redelivery (both GitHub and Bitbucket retry) is a no-op, not a second action. */
function alreadyRecorded(subscriptionId: string, providerRunId: string): Promise<boolean> {
  return getDataStore().codeProjects.hasPrPipelineEvent(subscriptionId, providerRunId);
}

function recordEvent(
  subscriptionId: string,
  providerRunId: string,
  conclusion: PipelineConclusion,
  rawPayload: unknown,
  actionTaken: ActionTaken
): Promise<void> {
  return getDataStore().codeProjects.recordPrPipelineEvent({
    subscriptionId,
    providerRunId,
    conclusion,
    rawPayload,
    actionTaken,
  });
}

function fixNote(repoFullName: string, prNumber: number): string {
  return (
    `Pipeline failed for pull request #${prNumber} on ${repoFullName}. This chat is subscribed ` +
    `to this PR's pipeline outcome with auto-fix on — open the failing run to see what broke, ` +
    `then continue here to have the agent look at it.`
  );
}

/** Terminal — a later run would carry a different provider_run_id, not repeat this one. */
export function isTerminal(conclusion: PipelineConclusion): boolean {
  return conclusion === 'success' || conclusion === 'failure';
}

async function actOnSubscription(
  provider: typeof GITHUB | typeof ATLASSIAN_BITBUCKET,
  subscription: SubscriptionRow,
  providerRunId: string,
  conclusion: PipelineConclusion,
  rawPayload: unknown
): Promise<void> {
  if (await alreadyRecorded(subscription.id, providerRunId)) return;
  if (!isTerminal(conclusion)) {
    await recordEvent(subscription.id, providerRunId, conclusion, rawPayload, null);
    return;
  }

  let actionTaken: ActionTaken = null;
  const target = { fullName: subscription.repoFullName };

  if (conclusion === 'success' && subscription.autoMerge) {
    const access =
      provider === GITHUB
        ? await resolveGitHubSubjectAccess(subscription.subscriberSubject)
        : await resolveBitbucketSubjectAccess(subscription.subscriberSubject);
    const merged = access
      ? provider === GITHUB
        ? await mergeGitHubPullRequest(access.auth, target, subscription.prNumber)
        : await mergeBitbucketPullRequest(access.auth, target, subscription.prNumber)
      : { ok: false as const, error: 'The subscriber has no live grant for this host.' };
    if (merged.ok) {
      actionTaken = 'merged';
      logger.info('merged pull request #{pr} on {repo} after a green subscribed pipeline', {
        component: COMPONENT,
        pr: subscription.prNumber,
        repo: subscription.repoFullName,
      });
    } else {
      actionTaken = 'merge_failed';
      logger.warn('could not merge pull request #{pr} on {repo}: {error}', {
        component: COMPONENT,
        pr: subscription.prNumber,
        repo: subscription.repoFullName,
        error: merged.error,
      });
    }
  } else if (conclusion === 'failure' && subscription.autoFix && subscription.chatId) {
    try {
      await insertChatNote(
        subscription.chatId,
        fixNote(subscription.repoFullName, subscription.prNumber)
      );
      actionTaken = 'fix_started';
    } catch (error) {
      actionTaken = 'fix_failed';
      logger.warn('could not post the pipeline-failure note into chat {chatId}: {error}', {
        component: COMPONENT,
        chatId: subscription.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await recordEvent(subscription.id, providerRunId, conclusion, rawPayload, actionTaken);
}

export function parseGitHubWorkflowRun(
  payload: Record<string, unknown>
): { repoFullName: string; runId: string; prNumbers: number[] } | null {
  if (payload.action !== 'completed') return null;
  const repository = rec(payload.repository);
  const workflowRun = rec(payload.workflow_run);
  const repoFullName = typeof repository.full_name === 'string' ? repository.full_name : '';
  const runId = typeof workflowRun.id === 'number' ? String(workflowRun.id) : '';
  if (!repoFullName || !runId) return null;
  const prNumbers = arr(workflowRun.pull_requests)
    .map((entry) => rec(entry).number)
    .filter((value): value is number => typeof value === 'number');
  return { repoFullName, runId, prNumbers };
}

export function createGitHubPrPipelineHandler(): EventHandler {
  return async (event: ClaimedEvent) => {
    const parsed = parseGitHubWorkflowRun(rec(event.payload));
    if (!parsed || parsed.prNumbers.length === 0) return 'skipped';

    const candidates = (
      await Promise.all(
        parsed.prNumbers.map((number) => activeSubscriptions(GITHUB, parsed.repoFullName, number))
      )
    ).flat();
    if (candidates.length === 0) return 'skipped';

    for (const subscription of candidates) {
      const access = await resolveGitHubSubjectAccess(subscription.subscriberSubject);
      if (!access) continue;
      const conclusion = await getGitHubWorkflowRunConclusion(
        access.auth,
        { fullName: parsed.repoFullName },
        parsed.runId
      );
      if (!conclusion) continue;
      await actOnSubscription(GITHUB, subscription, parsed.runId, conclusion, event.payload);
    }
  };
}

export function parseBitbucketRepoFullName(payload: Record<string, unknown>): string | null {
  const repository = rec(payload.repository);
  const fullName = typeof repository.full_name === 'string' ? repository.full_name : '';
  return fullName || null;
}

async function bitbucketPrHead(
  auth: AuthedFetch,
  repoFullName: string,
  prNumber: number
): Promise<string | null> {
  const response = await auth(
    `https://api.bitbucket.org/2.0/repositories/${repoFullName}/pullrequests/${prNumber}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const commit = rec(rec(rec(body).source).commit);
  return typeof commit.hash === 'string' ? commit.hash : null;
}

export function createBitbucketPrPipelineHandler(): EventHandler {
  return async (event: ClaimedEvent) => {
    const repoFullName = parseBitbucketRepoFullName(rec(event.payload));
    if (!repoFullName) return 'skipped';

    const candidates = await activeSubscriptions(ATLASSIAN_BITBUCKET, repoFullName);
    if (candidates.length === 0) return 'skipped';

    for (const subscription of candidates) {
      const access = await resolveBitbucketSubjectAccess(subscription.subscriberSubject);
      if (!access) continue;
      const head = await bitbucketPrHead(access.auth, repoFullName, subscription.prNumber);
      if (!head) continue;
      const conclusion = await getBitbucketCommitStatusConclusion(
        access.auth,
        { fullName: repoFullName },
        head
      );
      if (!conclusion) continue;
      // The PR's current head commit stands in for a "run id": a later
      // commit on the same PR is treated as a new run, since Bitbucket
      // gives this path no single pipeline-run identifier to key off.
      await actOnSubscription(ATLASSIAN_BITBUCKET, subscription, head, conclusion, event.payload);
    }
  };
}
