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
export type * from './domains/actionable-items';
export type * from './domains/first-run';
export type * from './domains/oauth-consents';
export type * from './domains/device-key-requests';
export type * from './domains/personal-account';
export type * from './domains/activity-logs';
export type * from './domains/tool-usage';
export type * from './domains/usage-ledgers';
export type * from './domains/knowledge-chunks';
