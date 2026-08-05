'use server';

import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import type { FilterExpr, LogRow } from '@campfhir/bored-logs';
import { getDatabase } from '@/lib/db';
import { getSessionFromCookies } from '@/lib/session';
import { buildLogQueryOptions } from '@/lib/log-query';

/** What the caller may see, resolved from their session rather than the request. */
export interface LogScope {
  role: 'renkei-operator' | 'renkei-user';
  /** The Jira account the logs are narrowed to, or null for tenant-wide. */
  accountId: string | null;
}

/** The controls the viewer sends back on every change. */
export interface LogSearch {
  expr: FilterExpr | null;
  levels: string[];
  start: string | null;
  end: string | null;
  sort: 'asc' | 'desc';
  /** Operators only: narrow to one account. Ignored for everyone else. */
  accountId?: string | null;
}

export interface LogSearchResult {
  logs: LogRow[];
  scope: LogScope | null;
  error: string | null;
  /**
   * The cookie is present — the proxy let the request through — but it names no
   * live session. Distinguished from other failures because the answer is to
   * re-authenticate, and nothing else here can offer that.
   */
  signedOut?: boolean;
}

const EMPTY_SEARCH: LogSearch = { expr: null, levels: [], start: null, end: null, sort: 'desc' };

/**
 * Read this tenant's logs.
 *
 * Server functions are reachable by direct POST, not just through the UI, so
 * the session — and with it the role and the account the caller is allowed to
 * see — is resolved here on every call. `tenantId` arriving from the client is
 * safe because the session cookie is per-tenant: it only names which cookie to
 * read, and produces no session for a tenant the caller has not signed into.
 */
export async function searchLogs(
  tenantId: string,
  search: LogSearch = EMPTY_SEARCH
): Promise<LogSearchResult> {
  const session = await getSessionFromCookies(tenantId);
  if (!session) {
    return { logs: [], scope: null, error: 'Sign in to view activity', signedOut: true };
  }

  const roles = new Set(session.roles);
  const isOperator = roles.has('renkei-operator');
  if (!isOperator && !roles.has('renkei-user')) {
    return { logs: [], scope: null, error: 'Your account has no role in this tenant' };
  }
  const role = isOperator ? 'renkei-operator' : 'renkei-user';

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return { logs: [], scope: null, error: 'Database unavailable' };
  }
  const db = dbResult.val;

  // This caller's own Jira account, via the grant they personally connected.
  // Keyed on subject rather than "first grant in the tenant", which would have
  // shown one user another user's activity.
  const ownGrant = await db
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', 'atlassian')
    .where('subject', '=', session.subject)
    .executeTakeFirst();

  const ownAccountId = ownGrant?.provider_account_id ?? null;

  // Operators may look at one account or the whole tenant. Everyone else is
  // pinned to their own account, and without a grant there is no account to pin
  // to — falling through would widen the query to the entire tenant.
  const accountId = isOperator ? (search.accountId ?? null) : ownAccountId;
  const scope: LogScope = { role, accountId };

  if (!isOperator && !accountId) {
    return { logs: [], scope, error: 'Connect Jira to see your activity' };
  }

  const result = await new PostgresAdapter({ db }).query(
    buildLogQueryOptions(search.expr, tenantId, accountId ?? undefined, {
      levels: search.levels,
      start: search.start,
      end: search.end,
      sort: search.sort,
    })
  );

  if (!result.ok) {
    return { logs: [], scope, error: result.err.message || 'Failed to query logs' };
  }

  return { logs: result.val, scope, error: null };
}
