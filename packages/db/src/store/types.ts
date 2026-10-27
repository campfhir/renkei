/**
 * The data store: the seam between the app and where its rows live.
 *
 * Callers that go through `getDataStore()` ask for domain records — a
 * session, a person's preference, a page of notifications — and never see
 * SQL. Two implementations stand behind every area (domains/<name>/):
 *
 *   - postgres: the production store, Kysely against the one shared
 *     database;
 *   - memory: the same answers from plain JavaScript tables in the web
 *     process (memory/tables.ts), for the UI suite that checks layout and
 *     navigation without a database (apps/web/playwright.memory.config.ts)
 *     and for unit tests.
 *
 * The two are held to each other by the differential suite
 * (differential/): every method has scenarios — the same fixture rows and
 * the same call against a fresh Postgres and a fresh memory store — whose
 * answers must be equal. A method without a scenario fails the coverage
 * test.
 *
 * The interface is domain-shaped, not table-shaped: it says what a caller
 * needs, so the memory store can answer it without a query engine.
 * Business rules — the idle timeout, preference defaults, a tour's reducer
 * — stay with the callers; a store only keeps and returns what it is
 * given. Every list has a defined order (ties broken explicitly), so both
 * stores can agree on it.
 *
 * Every method rejects on a storage failure (a dropped connection, a
 * constraint), as Kysely does; the memory store rejects with the same
 * SQLSTATE on `code` (memory/tables.ts). Callers wrap them the way they
 * wrapped the queries these replace.
 */

import type { DOMAINS } from './domains';

/** Which implementation answered. */
export type DataStoreKind = 'postgres' | 'memory';

type Repositories = {
  readonly [K in keyof typeof DOMAINS]: ReturnType<(typeof DOMAINS)[K]['memory']>;
};

export type DataStore = Repositories & { readonly kind: DataStoreKind };

export type * from './domains/sessions';
export type * from './domains/identities';
export type * from './domains/user-preferences';
export type * from './domains/settings';
export type * from './domains/coach-marks';
export type * from './domains/notifications';
export type * from './domains/salesforce-changes';
export type * from './domains/jira-changes';
export type * from './domains/jira-space-templates';
export type * from './domains/admin-change-queue';
export type * from './domains/salesforce-grants';
export type * from './domains/batch-jobs';
export type * from './domains/batch-job-schedules';
export type * from './domains/audit-events';
export type * from './domains/event-log';
export type * from './domains/oidc-config';
export type * from './domains/llm-models';
export type * from './domains/schedule-calendars';
export type * from './domains/org-access';
export type * from './domains/usage';
export type * from './domains/agents';
export type * from './domains/agent-runs';
export type * from './domains/agent-usage';
export type * from './domains/agent-optimizations';
export type * from './domains/agent-drafts';
export type * from './domains/connector-configs';
export type * from './domains/provider-grants';
export type * from './domains/mcp-servers';
export type * from './domains/file-shares';
export type * from './domains/mirth-instances';
export type * from './domains/admanager-instances';
export type * from './domains/email-sanitizer';
export type * from './domains/mail-review';
export type * from './domains/resource-grants';
export type * from './domains/chats';
export type * from './domains/chat-threads';
export type * from './domains/chat-projects';
export type * from './domains/prompt-libraries';
export type * from './domains/user-memory';
export type * from './domains/artifacts';
export type * from './domains/code-projects';
export type * from './domains/code-templates';
export type * from './domains/chat-models';
export type * from './domains/actionable-items';
export type * from './domains/first-run';
export type * from './domains/oauth-consents';
export type * from './domains/device-key-requests';
export type * from './domains/personal-account';
export type * from './domains/activity-logs';
export type * from './domains/tool-usage';
export type * from './domains/knowledge-chunks';
export type * from './domains/pending-signins';
export type * from './domains/webhook-subscriptions';
export type * from './domains/upload-slots';
export type * from './domains/platform-settings';
export type * from './domains/user-keys';
export type * from './domains/queues';
export type * from './domains/run-tokens';
export type * from './domains/knowledge-reindex-runs';
export type * from './domains/oauth-tokens';
export type * from './domains/phi-access';
export type * from './domains/mail-bulk-jobs';
export type * from './domains/webex-sent-messages';
export type * from './domains/tool-surface';
export type * from './domains/content-watches';
export type * from './domains/sandbox-files';
export type * from './domains/sandbox-workspaces';
export type * from './domains/sandbox-secrets';
export type * from './domains/sandbox-services';
export type * from './domains/code-service-image-rules';
export type * from './domains/sandbox-env-secrets';
export type * from './domains/sandbox-crawls';
export type * from './domains/webex-dirty-windows';
export type * from './domains/resource-keys';
export type * from './domains/delegate-signing-keys';
export type * from './domains/delegate-access-events';
export type * from './domains/delegate-git-tickets';
export type * from './domains/sealed-envelopes';
export type * from './domains/legacy-envelopes';
export type * from './domains/advisory-locks';
export type * from './domains/agent-trigger-firings';
