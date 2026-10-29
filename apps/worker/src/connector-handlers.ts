/**
 * Every events-queue handler this worker runs, registered by source and
 * type. index.ts registers them at boot; embedded.ts does the same inside
 * the web server on the in-memory data store.
 */

import { registerHandler } from './handlers';
import { createWebexUserMessageHandler } from './handlers/webex-user-message';
import {
  createMicrosoftGrantConnectedHandler,
  createMicrosoftChangeNotificationHandler,
  createMicrosoftLifecycleHandler,
  createMicrosoftMessageOverrideHandler,
} from './handlers/microsoft-events';
import { createZoomTranscriptHandler, createZoomSummaryHandler } from './handlers/zoom-events';
import {
  createGitHubPrPipelineHandler,
  createBitbucketPrPipelineHandler,
} from './handlers/pr-pipeline-events';
import { createDomainDispatchHandler } from './handlers/domain-dispatch';
import { createAgentRunFailedHandler } from './handlers/agent-run-failed';
import { createMailBulkJobHandler } from './handlers/mail-bulk-jobs';
import { logger } from './logger';

/**
 * Handlers register unconditionally; whether a connector is actually
 * configured is per-tenant database state, resolved when its events are
 * processed. A tenant without configuration fails its events visibly (into
 * the retry/dead-letter path) rather than having them silently swallowed.
 */
export function registerConnectorHandlers(): void {
  registerHandler('webex', 'user-message.created', createWebexUserMessageHandler());
  registerHandler('microsoft', 'grant.connected', createMicrosoftGrantConnectedHandler());
  registerHandler('microsoft', 'change-notification', createMicrosoftChangeNotificationHandler());
  registerHandler('microsoft', 'lifecycle', createMicrosoftLifecycleHandler());
  registerHandler('microsoft', 'message-override', createMicrosoftMessageOverrideHandler());
  registerHandler('zoom', 'recording.transcript_completed', createZoomTranscriptHandler());
  registerHandler('zoom', 'meeting.summary_completed', createZoomSummaryHandler());
  // A subscribed pull request's pipeline outcome (app/api/webhooks/
  // github|bitbucket/[tenantId]/route.ts in apps/web) — matched against
  // pr_subscriptions, recorded, and acted on per that subscription's own
  // auto_merge/auto_fix (handlers/pr-pipeline-events.ts).
  registerHandler('github', 'workflow_run', createGitHubPrPipelineHandler());
  registerHandler(
    'atlassian-bitbucket',
    'repo:commit_status_updated',
    createBitbucketPrPipelineHandler()
  );
  // Async Outlook bulk mail actions — submitted by the MCP tool as a bare
  // {jobId} pointer; the mail_bulk_jobs row is the source of truth.
  registerHandler('mailjobs', 'bulk-action', createMailBulkJobHandler());
  // Emitted by worker-agents when a run fails; delivery of the owner's
  // notification belongs here, where the connector paths live. (run.reply
  // is gone: agents that answer in a room do it as a STEP now.)
  registerHandler('agents', 'run.failed', createAgentRunFailedHandler());
  // Domain events published by the provider handlers above arrive on
  // `domain:{provider}` lanes; the colon-lane fallback in handlerFor
  // resolves them to the one dispatch handler, registered per type.
  const dispatch = createDomainDispatchHandler();
  registerHandler('domain', 'message.received', dispatch);
  registerHandler('domain', 'mail.received', dispatch);
  registerHandler('domain', 'recording.transcript_completed', dispatch);
  registerHandler('domain', 'meeting.summary_completed', dispatch);
  // Published by the batch-jobs worker (batch-jobs/lifecycle.ts) when a
  // batch begins or ends; dispatched here so the agent fan-out lives in
  // one process regardless of who published.
  registerHandler('domain', 'job.started', dispatch);
  registerHandler('domain', 'job.completed', dispatch);
  logger.info('webex, microsoft, zoom and dispatch handlers registered', {
    component: 'worker/loop',
  });
}
