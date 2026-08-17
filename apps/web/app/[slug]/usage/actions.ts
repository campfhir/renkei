'use server';

/**
 * Usage rollups for the tools page.
 *
 * Scope is decided HERE, from the session, never from a parameter. A caller
 * who is not an operator is pinned to their own subject before any query
 * runs, so "show me everyone" is not a request the server can be talked into
 * — the same shape the logs actions use, and for the same reason.
 *
 * What an operator sees is deliberately asymmetric with what they can read
 * elsewhere: counts and latency per PERSON, because knowing that one team
 * leans entirely on one connector is how you decide what to invest in, but
 * never what any call contained. The table has no content to leak (migration
 * 032), which makes that guarantee structural rather than a promise.
 */

import { getDatabase } from '@renkei/db';
import { sql } from 'kysely';
import { getSessionFromCookies } from '@/lib/session';
import { getIdentityDisplay } from '@/lib/identity';
import { ROLE_OPERATOR, ROLE_USER } from '@/lib/access';
// Only async functions may be exported from a 'use server' module, so the
// descriptor type is imported from its own module wherever it is needed.
import { listAvailableTools, type ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { clampDays, safeTimeZone, zeroFill, resolveScope, type UsagePoint } from './window';

export interface ToolUsageRow {
  tool: string;
  connector: string | null;
  calls: number;
  errors: number;
  /** Median and tail, because an average hides the calls people complain about. */
  medianMs: number;
  p95Ms: number;
}

export interface UserUsageRow {
  subject: string | null;
  label: string;
  calls: number;
  errors: number;
}

export interface UsageReport {
  scope: 'self' | 'tenant';
  /** Whether this caller may see the tenant-wide view at all. */
  canSeeTenant: boolean;
  days: number;
  totalCalls: number;
  totalErrors: number;
  tools: ToolUsageRow[];
  trend: UsagePoint[];
  /** Operator view only. */
  byUser: UserUsageRow[];
  error?: string;
  signedOut?: boolean;
}

const EMPTY: UsageReport = {
  scope: 'self',
  canSeeTenant: false,
  days: 7,
  totalCalls: 0,
  totalErrors: 0,
  tools: [],
  trend: [],
  byUser: [],
};

export async function getUsageReport(
  tenantId: string,
  requestedDays = 7,
  requestedTimeZone?: string,
  requestedScope?: 'self' | 'tenant'
): Promise<UsageReport> {
  const days = clampDays(requestedDays);
  const timeZone = safeTimeZone(requestedTimeZone);
  const session = await getSessionFromCookies(tenantId);
  if (!session) {
    return { ...EMPTY, days, error: 'Sign in to see tool usage', signedOut: true };
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return { ...EMPTY, days, error: 'Database unavailable' };
  const db = dbResult.val;

  const isOperator = session.roles.includes(ROLE_OPERATOR);
  if (!isOperator && !session.roles.includes(ROLE_USER)) {
    return { ...EMPTY, days, error: 'Your account has no role in this tenant' };
  }
  // `requestedScope` can only NARROW. An operator may ask to see just their
  // own calls; nobody else's request for 'tenant' is honoured, because the
  // permission comes from the session and never from the argument.
  const scope = resolveScope(isOperator, requestedScope);
  const tenantWide = scope === 'tenant';
  // A caller without the tenant-wide view is pinned to themselves before the
  // query, not filtered after it: scope that is applied late is scope that can
  // be forgotten.
  const ownSubject = session.subject;

  const since = sql<Date>`NOW() - MAKE_INTERVAL(days => ${days})`;

  try {
    // Built by conditional rather than a generic helper: Kysely's builders are
    // immutable, so narrowing to one subject is just another .where(), and
    // expressing it plainly keeps the scope visible at the call site.
    let toolQuery = db
      .selectFrom('tool_calls')
      .select([
        'tool',
        'connector',
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
        sql<string>`percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)`.as('median_ms'),
        sql<string>`percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)`.as('p95_ms'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('started_at', '>=', since);
    if (!tenantWide) toolQuery = toolQuery.where('subject', '=', ownSubject);

    const toolRows = await toolQuery
      .groupBy(['tool', 'connector'])
      .orderBy(sql`count(*)`, 'desc')
      .execute();

    let trendQuery = db
      .selectFrom('tool_calls')
      .select([
        // Bucketed in the viewer's zone, not the database session's: "calls
        // today" has to mean their today.
        sql<string>`to_char(date_trunc('day', started_at AT TIME ZONE ${timeZone}), 'YYYY-MM-DD')`.as(
          'day'
        ),
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('started_at', '>=', since);
    if (!tenantWide) trendQuery = trendQuery.where('subject', '=', ownSubject);

    // Grouped by the OUTPUT ALIAS, not by a repeat of the bucket expression.
    // Repeating it looks equivalent and is not: each `${timeZone}` becomes its
    // own bound parameter, so Postgres sees `AT TIME ZONE $2` in the select and
    // `AT TIME ZONE $3` in the group by, decides they are different
    // expressions, and rejects the query with "started_at must appear in the
    // GROUP BY clause". Naming the alias once removes the possibility.
    const trendRows = await trendQuery
      .groupBy(sql`day`)
      .orderBy(sql`day`, 'asc')
      .execute();

    // Per-person totals are the operator's whole reason for this page, and
    // are not computed at all for anyone else.
    const byUser: UserUsageRow[] = [];
    if (tenantWide) {
      const rows = await db
        .selectFrom('tool_calls')
        .leftJoin('identities', (join) =>
          join
            .onRef('identities.subject', '=', 'tool_calls.subject')
            .onRef('identities.tenant_id', '=', 'tool_calls.tenant_id')
        )
        .select([
          'tool_calls.subject as subject',
          sql<string>`max(identities.display_name)`.as('display_name'),
          sql<string>`max(identities.email)`.as('email'),
          sql<string>`count(*)`.as('calls'),
          sql<string>`count(*) FILTER (WHERE tool_calls.status <> 'ok')`.as('errors'),
        ])
        .where('tool_calls.tenant_id', '=', tenantId)
        .where('tool_calls.started_at', '>=', since)
        .groupBy('tool_calls.subject')
        .orderBy(sql`count(*)`, 'desc')
        .limit(50)
        .execute();
      for (const row of rows) {
        byUser.push({
          subject: row.subject,
          label: row.display_name || row.email || row.subject || 'unknown',
          calls: Number(row.calls),
          errors: Number(row.errors),
        });
      }
    }

    const tools: ToolUsageRow[] = toolRows.map((row) => ({
      tool: row.tool,
      connector: row.connector,
      calls: Number(row.calls),
      errors: Number(row.errors),
      medianMs: Number(row.median_ms ?? 0),
      p95Ms: Number(row.p95_ms ?? 0),
    }));

    return {
      scope,
      canSeeTenant: isOperator,
      days,
      totalCalls: tools.reduce((sum, row) => sum + row.calls, 0),
      totalErrors: tools.reduce((sum, row) => sum + row.errors, 0),
      tools,
      trend: zeroFill(
        trendRows.map((row) => ({
          day: row.day,
          calls: Number(row.calls),
          errors: Number(row.errors),
        })),
        days,
        timeZone,
        new Date()
      ),
      byUser,
    };
  } catch (error) {
    return {
      ...EMPTY,
      scope,
      canSeeTenant: isOperator,
      days,
      error: error instanceof Error ? error.message : 'Could not read usage',
    };
  }
}

export interface ToolFailureRow {
  /** ISO timestamp of the failed call. */
  at: string;
  durationMs: number;
  /** Who made it — only in the tenant-wide view; null in the self view. */
  by: string | null;
  /**
   * Brief error text, ONLY for the requester's own calls — error messages
   * can quote inputs, so an operator browsing tenant-wide sees who/when/how
   * long but never another person's message. The caller quotes this at the
   * helpdesk; the helpdesk does not read it off the failing user's rows.
   */
  summary: string | null;
}

export interface ToolDetail {
  tool: string;
  days: number;
  scope: 'self' | 'tenant';
  calls: number;
  errors: number;
  medianMs: number;
  p95Ms: number;
  trend: UsagePoint[];
  /** Most recent failures, newest first. */
  failures: ToolFailureRow[];
  error?: string;
}

/**
 * One tool, up close — what the card cannot say in two lines.
 *
 * "Details on a failure" means when it happened, how long it ran, for an
 * operator looking tenant-wide whose call it was, and — for the requester's
 * own calls only — the brief error summary (migration 037). Arguments and
 * successful results are never recorded at all (migration 032). Scope is
 * resolved from the session exactly as in getUsageReport: a non-operator is
 * pinned to their own calls before any query runs.
 */
export async function getToolDetail(
  tenantId: string,
  tool: string,
  requestedDays = 7,
  requestedTimeZone?: string,
  requestedScope?: 'self' | 'tenant'
): Promise<ToolDetail> {
  const days = clampDays(requestedDays);
  const timeZone = safeTimeZone(requestedTimeZone);
  const empty: ToolDetail = {
    tool,
    days,
    scope: 'self',
    calls: 0,
    errors: 0,
    medianMs: 0,
    p95Ms: 0,
    trend: [],
    failures: [],
  };

  const session = await getSessionFromCookies(tenantId);
  if (!session) return { ...empty, error: 'Sign in to see tool usage' };
  const dbResult = getDatabase();
  if (!dbResult.ok) return { ...empty, error: 'Database unavailable' };
  const db = dbResult.val;

  const isOperator = session.roles.includes(ROLE_OPERATOR);
  if (!isOperator && !session.roles.includes(ROLE_USER)) {
    return { ...empty, error: 'Your account has no role in this tenant' };
  }
  const scope = resolveScope(isOperator, requestedScope);
  const tenantWide = scope === 'tenant';
  const ownSubject = session.subject;

  const since = sql<Date>`NOW() - MAKE_INTERVAL(days => ${days})`;

  try {
    let totalsQuery = db
      .selectFrom('tool_calls')
      .select([
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
        sql<string>`percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)`.as('median_ms'),
        sql<string>`percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)`.as('p95_ms'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('tool', '=', tool)
      .where('started_at', '>=', since);
    if (!tenantWide) totalsQuery = totalsQuery.where('subject', '=', ownSubject);
    const totals = await totalsQuery.executeTakeFirst();

    let trendQuery = db
      .selectFrom('tool_calls')
      .select([
        sql<string>`to_char(date_trunc('day', started_at AT TIME ZONE ${timeZone}), 'YYYY-MM-DD')`.as(
          'day'
        ),
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('tool', '=', tool)
      .where('started_at', '>=', since);
    if (!tenantWide) trendQuery = trendQuery.where('subject', '=', ownSubject);
    // Grouped by the alias for the same reason getUsageReport is: repeating
    // the expression rebinds ${timeZone} and Postgres rejects the query.
    const trendRows = await trendQuery
      .groupBy(sql`day`)
      .orderBy(sql`day`, 'asc')
      .execute();

    let failureQuery = db
      .selectFrom('tool_calls')
      .leftJoin('identities', (join) =>
        join
          .onRef('identities.subject', '=', 'tool_calls.subject')
          .onRef('identities.tenant_id', '=', 'tool_calls.tenant_id')
      )
      .select([
        'tool_calls.started_at as started_at',
        'tool_calls.duration_ms as duration_ms',
        'tool_calls.subject as subject',
        'tool_calls.error_summary as error_summary',
        'identities.display_name as display_name',
        'identities.email as email',
      ])
      .where('tool_calls.tenant_id', '=', tenantId)
      .where('tool_calls.tool', '=', tool)
      .where('tool_calls.status', '<>', 'ok')
      .where('tool_calls.started_at', '>=', since);
    if (!tenantWide) failureQuery = failureQuery.where('tool_calls.subject', '=', ownSubject);
    const failureRows = await failureQuery
      .orderBy('tool_calls.started_at', 'desc')
      .limit(25)
      .execute();

    return {
      tool,
      days,
      scope,
      calls: Number(totals?.calls ?? 0),
      errors: Number(totals?.errors ?? 0),
      medianMs: Number(totals?.median_ms ?? 0),
      p95Ms: Number(totals?.p95_ms ?? 0),
      trend: zeroFill(
        trendRows.map((row) => ({
          day: row.day,
          calls: Number(row.calls),
          errors: Number(row.errors),
        })),
        days,
        timeZone,
        new Date()
      ),
      failures: failureRows.map((row) => ({
        at: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
        durationMs: Number(row.duration_ms),
        by: tenantWide ? row.display_name || row.email || row.subject || 'unknown' : null,
        // The requester's OWN failures carry the message in either scope;
        // anyone else's never do, however privileged the viewer.
        summary: row.subject === ownSubject ? (row.error_summary ?? null) : null,
      })),
    };
  } catch (error) {
    return { ...empty, scope, error: error instanceof Error ? error.message : 'Could not read' };
  }
}

/**
 * The tools this caller is offered over MCP right now.
 *
 * Always their OWN tools, even for an operator: usage aggregates across the
 * org, but "the tools you have" is a per-person question, and an operator's
 * grants are not a proxy for anyone else's.
 */
export async function getAvailableTools(tenantId: string): Promise<ToolDescriptor[]> {
  const session = await getSessionFromCookies(tenantId);
  if (!session) return [];
  return listAvailableTools(tenantId, session.subject);
}

/** The identity spine's name for the signed-in caller, for the page header. */
export async function getViewerLabel(tenantId: string): Promise<string | null> {
  const session = await getSessionFromCookies(tenantId);
  if (!session) return null;
  const identity = await getIdentityDisplay(tenantId, session.subject);
  return identity?.displayName || identity?.email || null;
}
