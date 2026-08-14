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
