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

import { getDatabase, getDataStore, type ToolCallsByTool, type UsageWindow } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { getIdentityDisplay } from '@/lib/identity';
import { ROLE_OPERATOR, ROLE_USER } from '@/lib/access';
// Only async functions may be exported from a 'use server' module, so the
// descriptor type is imported from its own module wherever it is needed.
import { listAvailableTools, type ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { getAgentUsageSummaries, type AgentUsageSummary } from '@/lib/agents/agent-usage';
import {
  clampDays,
  safeTimeZone,
  zeroFill,
  resolveScope,
  canSeeOrgTop,
  TOP_TOOLS,
  type UsagePoint,
} from './window';

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
  /**
   * The caller's OWN five most-used tools, whatever scope is being viewed —
   * "what do I lean on" is a question the scope toggle should not change the
   * answer to.
   */
  myTop: ToolUsageRow[];
  /**
   * The org's five most-used. Populated for OPERATORS ONLY, and gated on the
   * session's role rather than on the requested scope: an operator looking at
   * their own calls still gets the org comparison, and nobody else gets it in
   * any view. Empty is the honest answer for a caller who may not see it.
   */
  orgTop: ToolUsageRow[];
  /** The five failing most in the current scope. Empty when nothing failed. */
  troubled: ToolUsageRow[];
  /**
   * Usage broken down by agent — the caller's own agents in the 'self'
   * scope, every agent in the tenant in 'tenant' (an operator only). Same
   * scope the rest of the report already uses; there is no separate toggle
   * for it.
   */
  byAgent: AgentUsageSummary[];
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
  myTop: [],
  orgTop: [],
  troubled: [],
  byAgent: [],
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last `days` days up to now — what `NOW() - MAKE_INTERVAL(days => …)` meant. */
function lastDays(days: number): UsageWindow {
  return { since: new Date(Date.now() - days * DAY_MS) };
}

function toolRow(row: ToolCallsByTool): ToolUsageRow {
  return {
    tool: row.tool,
    connector: row.connector,
    calls: row.calls,
    errors: row.errors,
    medianMs: row.medianMs ?? 0,
    p95Ms: row.p95Ms ?? 0,
  };
}

/**
 * The most-called tools over the window, for one subject or for the whole
 * tenant.
 *
 * `subject: null` means tenant-wide, and is the ONLY way to ask for it —
 * every caller has to state which they mean, so widening the scope cannot
 * happen by forgetting a filter.
 */
async function topToolsFor(window: UsageWindow, subject: string | null): Promise<ToolUsageRow[]> {
  // Latency is not what these cards are about, and asking for percentiles
  // would cost a sort over the window for a number nothing displays.
  const rows = await getDataStore().toolUsage.byTool(
    { window, subject },
    { latency: false, limit: TOP_TOOLS }
  );
  return rows.map(toolRow);
}

export async function getUsageReport(
  requestedDays = 7,
  requestedTimeZone?: string,
  requestedScope?: 'self' | 'tenant'
): Promise<UsageReport> {
  const days = clampDays(requestedDays);
  const timeZone = safeTimeZone(requestedTimeZone);
  const session = await getSessionFromCookies();
  if (!session) {
    return { ...EMPTY, days, error: 'Sign in to see tool usage', signedOut: true };
  }

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

  const window = lastDays(days);
  // A caller without the tenant-wide view is pinned to themselves: the
  // filter names their subject before any read runs.
  const scoped = { window, subject: tenantWide ? null : ownSubject };
  const store = getDataStore().toolUsage;

  try {
    const [toolRows, trendRows, personRows] = await Promise.all([
      store.byTool(scoped, { latency: true }),
      // Bucketed in the viewer's zone, not the database session's: "calls
      // today" has to mean their today.
      store.series(scoped, { timeZone, granularity: 'day' }),
      // Per-person totals are the operator's whole reason for this page, and
      // are not computed at all for anyone else.
      tenantWide ? store.byPerson({ window, subject: null }, 50) : Promise.resolve([]),
    ]);
    const byUser: UserUsageRow[] = personRows.map((row) => ({
      subject: row.subject,
      label: row.displayName || row.email || row.subject || 'unknown',
      calls: row.calls,
      errors: row.errors,
    }));

    const tools: ToolUsageRow[] = toolRows.map(toolRow);

    // The headline cards. `tools` is already ordered by call count, so the
    // caller's own top five come free whenever the view IS their own; the
    // extra query happens only for an operator looking tenant-wide, who is
    // the one person whose two answers differ.
    const myTop = tenantWide ? await topToolsFor(window, ownSubject) : tools.slice(0, TOP_TOOLS);
    // Role, never requested scope: an operator viewing their own calls still
    // gets the org comparison, and a non-operator gets it in no view at all.
    // Asking for it as a parameter cannot make it appear.
    const orgTop = canSeeOrgTop(isOperator)
      ? tenantWide
        ? tools.slice(0, TOP_TOOLS)
        : await topToolsFor(window, null)
      : [];
    // Ranked by failures, and only tools that actually failed — a card
    // listing the five least-broken tools in a healthy org would be noise
    // dressed as a warning.
    const troubled = tools
      .filter((row) => row.errors > 0)
      .sort((left, right) => right.errors - left.errors)
      .slice(0, TOP_TOOLS);

    const dbResult = getDatabase();
    const byAgent = dbResult.ok
      ? await getAgentUsageSummaries(dbResult.val, tenantWide ? null : ownSubject, days)
      : [];

    return {
      scope,
      canSeeTenant: isOperator,
      days,
      totalCalls: tools.reduce((sum, row) => sum + row.calls, 0),
      totalErrors: tools.reduce((sum, row) => sum + row.errors, 0),
      tools,
      myTop,
      orgTop,
      troubled,
      byAgent,
      trend: zeroFill(
        trendRows.map((row) => ({ day: row.bucket, calls: row.calls, errors: row.errors })),
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

  const session = await getSessionFromCookies();
  if (!session) return { ...empty, error: 'Sign in to see tool usage' };

  const isOperator = session.roles.includes(ROLE_OPERATOR);
  if (!isOperator && !session.roles.includes(ROLE_USER)) {
    return { ...empty, error: 'Your account has no role in this tenant' };
  }
  const scope = resolveScope(isOperator, requestedScope);
  const tenantWide = scope === 'tenant';
  const ownSubject = session.subject;

  const filter = { window: lastDays(days), subject: tenantWide ? null : ownSubject, tool };
  const store = getDataStore().toolUsage;

  try {
    const [totals, trendRows, failureRows] = await Promise.all([
      store.totals(filter, { latency: true }),
      store.series(filter, { timeZone, granularity: 'day' }),
      store.recentFailures(filter, 25),
    ]);

    return {
      tool,
      days,
      scope,
      calls: totals.calls,
      errors: totals.errors,
      medianMs: totals.medianMs ?? 0,
      p95Ms: totals.p95Ms ?? 0,
      trend: zeroFill(
        trendRows.map((row) => ({ day: row.bucket, calls: row.calls, errors: row.errors })),
        days,
        timeZone,
        new Date()
      ),
      failures: failureRows.map((row) => ({
        at: row.startedAt.toISOString(),
        durationMs: row.durationMs,
        by: tenantWide ? row.displayName || row.email || row.subject || 'unknown' : null,
        // The requester's OWN failures carry the message in either scope;
        // anyone else's never do, however privileged the viewer.
        summary: row.subject === ownSubject ? (row.errorSummary ?? null) : null,
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
export async function getAvailableTools(): Promise<ToolDescriptor[]> {
  const session = await getSessionFromCookies();
  if (!session) return [];
  return listAvailableTools(session.subject, { roles: session.roles });
}

/** The identity spine's name for the signed-in caller, for the page header. */
export async function getViewerLabel(): Promise<string | null> {
  const session = await getSessionFromCookies();
  if (!session) return null;
  const identity = await getIdentityDisplay(session.subject);
  return identity?.displayName || identity?.email || null;
}
