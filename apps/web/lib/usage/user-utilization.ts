/**
 * One person's overall utilization: tokens, agent runs, tool calls — and
 * where their agents are failing.
 *
 * Every read here is keyed on a SUBJECT, and the subject is the caller's
 * own (the action pins it from the session before calling in). Sources:
 *
 *   - `agent_run_counters` (durable, content-free): runs, failures and
 *     token spend per agent per day, for the agents this person OWNS.
 *   - `tool_calls` (durable, content-free): every MCP tool call made under
 *     this subject — their own calls from a chat client AND their agents'
 *     calls, which execute under a run token bound to the owner (RENKEI.md
 *     Decision #21). So "tool calls" here means everything done as them.
 *   - `agent_run_failures` (migration 079): which step, what kind, when.
 *
 * Counter days are Postgres CURRENT_DATE buckets; tool calls are bucketed
 * in the viewer's zone. The two can disagree by a day at the edges of a
 * calendar day — accepted, and said on the page, rather than re-keying a
 * durable rollup around whoever happens to be looking.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';

export interface UtilizationTotals {
  inputTokens: number;
  outputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

export interface UtilizationDay {
  /** YYYY-MM-DD */
  day: string;
  inputTokens: number;
  outputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

export interface AgentUtilizationRow {
  agentId: string;
  name: string;
  enabled: boolean;
  runs: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** The most recent captured failure in the window, if any. */
  lastFailureAt: string | null;
  lastFailureStep: string | null;
  lastFailureKind: string | null;
}

/**
 * A recurring failure: the same agent stopping at the same step for the
 * same kind of reason. Grouped this way because "failed 12 times" is a
 * number and "stops at 'Find the ticket' with a tool error, 12 times" is
 * something a person can fix.
 */
export interface FailureSignature {
  agentId: string;
  agentName: string;
  stepName: string | null;
  errorKind: string | null;
  outcomeCode: string | null;
  count: number;
  lastAt: string;
  /** The most recent error message for this signature — the owner's own content. */
  lastError: string | null;
}

const sinceDate = (days: number) =>
  sql<Date>`(CURRENT_DATE - MAKE_INTERVAL(days => ${Math.max(0, days - 1)}))::date`;
const sinceTs = (days: number) => sql<Date>`NOW() - MAKE_INTERVAL(days => ${days})`;

export async function getUtilizationTotals(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  days: number
): Promise<UtilizationTotals> {
  const [counters, calls] = await Promise.all([
    db
      .selectFrom('agent_run_counters as c')
      .innerJoin('agents as a', (join) =>
        join.onRef('a.id', '=', 'c.agent_id').onRef('a.tenant_id', '=', 'c.tenant_id')
      )
      .select(({ fn }) => [
        fn.sum<string>('c.input_tokens').as('input_tokens'),
        fn.sum<string>('c.output_tokens').as('output_tokens'),
        fn.sum<string>('c.runs').as('runs'),
        fn.sum<string>('c.failures').as('failures'),
      ])
      .where('c.tenant_id', '=', tenantId)
      .where('a.owner_subject', '=', subject)
      .where('c.day', '>=', sinceDate(days))
      .executeTakeFirst(),
    db
      .selectFrom('tool_calls')
      .select([
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('started_at', '>=', sinceTs(days))
      .executeTakeFirst(),
  ]);
  return {
    inputTokens: Number(counters?.input_tokens ?? 0),
    outputTokens: Number(counters?.output_tokens ?? 0),
    runs: Number(counters?.runs ?? 0),
    failures: Number(counters?.failures ?? 0),
    toolCalls: Number(calls?.calls ?? 0),
    toolErrors: Number(calls?.errors ?? 0),
  };
}

/**
 * The daily series, merged from the two sources by calendar day. Only days
 * with activity come back; the window helper zero-fills and buckets.
 */
export async function getUtilizationSeries(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  days: number,
  timeZone: string
): Promise<UtilizationDay[]> {
  const [counterRows, callRows] = await Promise.all([
    db
      .selectFrom('agent_run_counters as c')
      .innerJoin('agents as a', (join) =>
        join.onRef('a.id', '=', 'c.agent_id').onRef('a.tenant_id', '=', 'c.tenant_id')
      )
      .select(({ fn }) => [
        sql<string>`to_char(c.day, 'YYYY-MM-DD')`.as('day'),
        fn.sum<string>('c.input_tokens').as('input_tokens'),
        fn.sum<string>('c.output_tokens').as('output_tokens'),
        fn.sum<string>('c.runs').as('runs'),
        fn.sum<string>('c.failures').as('failures'),
      ])
      .where('c.tenant_id', '=', tenantId)
      .where('a.owner_subject', '=', subject)
      .where('c.day', '>=', sinceDate(days))
      .groupBy(sql`day`)
      .execute(),
    db
      .selectFrom('tool_calls')
      .select([
        // The viewer's day, as the tools page buckets it. Grouped by the
        // alias, not a repeat of the expression — see usage/actions.ts.
        sql<string>`to_char(date_trunc('day', started_at AT TIME ZONE ${timeZone}), 'YYYY-MM-DD')`.as(
          'day'
        ),
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('started_at', '>=', sinceTs(days))
      .groupBy(sql`day`)
      .execute(),
  ]);

  const byDay = new Map<string, UtilizationDay>();
  const dayOf = (day: string): UtilizationDay => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const fresh: UtilizationDay = {
      day,
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
      failures: 0,
      toolCalls: 0,
      toolErrors: 0,
    };
    byDay.set(day, fresh);
    return fresh;
  };
  for (const row of counterRows) {
    const point = dayOf(row.day);
    point.inputTokens += Number(row.input_tokens ?? 0);
    point.outputTokens += Number(row.output_tokens ?? 0);
    point.runs += Number(row.runs ?? 0);
    point.failures += Number(row.failures ?? 0);
  }
  for (const row of callRows) {
    const point = dayOf(row.day);
    point.toolCalls += Number(row.calls ?? 0);
    point.toolErrors += Number(row.errors ?? 0);
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
}

/** Every agent this person owns, with its share of the window's usage. */
export async function getAgentUtilization(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  days: number
): Promise<AgentUtilizationRow[]> {
  const agents = await db
    .selectFrom('agents')
    .select(['id', 'name', 'enabled'])
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', subject)
    .orderBy('name')
    .execute();
  if (agents.length === 0) return [];
  const ids = agents.map((agent) => agent.id);

  const [counterRows, failureRows] = await Promise.all([
    db
      .selectFrom('agent_run_counters')
      .select(({ fn }) => [
        'agent_id',
        fn.sum<string>('runs').as('runs'),
        fn.sum<string>('failures').as('failures'),
        fn.sum<string>('input_tokens').as('input_tokens'),
        fn.sum<string>('output_tokens').as('output_tokens'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('agent_id', 'in', ids)
      .where('day', '>=', sinceDate(days))
      .groupBy('agent_id')
      .execute(),
    // The newest captured failure per agent — DISTINCT ON walks the
    // (agent, created_at) index once.
    sql<{
      agent_id: string;
      created_at: Date;
      step_name: string | null;
      error_kind: string | null;
    }>`
      SELECT DISTINCT ON (agent_id) agent_id, created_at, step_name, error_kind
      FROM agent_run_failures
      WHERE tenant_id = ${tenantId}
        AND owner_subject = ${subject}
        AND agent_id IN (${sql.join(ids)})
        AND created_at >= NOW() - MAKE_INTERVAL(days => ${days})
      ORDER BY agent_id, created_at DESC
    `.execute(db),
  ]);
  const counters = new Map(counterRows.map((row) => [row.agent_id, row]));
  const failures = new Map(failureRows.rows.map((row) => [row.agent_id, row]));

  return agents
    .map((agent) => {
      const counter = counters.get(agent.id);
      const failure = failures.get(agent.id);
      return {
        agentId: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        runs: Number(counter?.runs ?? 0),
        failures: Number(counter?.failures ?? 0),
        inputTokens: Number(counter?.input_tokens ?? 0),
        outputTokens: Number(counter?.output_tokens ?? 0),
        lastFailureAt: failure ? failure.created_at.toISOString() : null,
        lastFailureStep: failure?.step_name ?? null,
        lastFailureKind: failure?.error_kind ?? null,
      };
    })
    .sort(
      (left, right) =>
        right.failures - left.failures ||
        right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens) ||
        left.name.localeCompare(right.name)
    );
}

/**
 * The recurring failures across this person's agents, most frequent
 * first. `limit` keeps the attention list a list rather than a log.
 */
export async function getFailureSignatures(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  days: number,
  limit = 5
): Promise<FailureSignature[]> {
  const rows = await sql<{
    agent_id: string;
    agent_name: string;
    step_name: string | null;
    error_kind: string | null;
    outcome_code: string | null;
    count: string;
    last_at: Date;
    last_error: string | null;
  }>`
    SELECT
      f.agent_id,
      a.name AS agent_name,
      f.step_name,
      f.error_kind,
      f.outcome_code,
      COUNT(*) AS count,
      MAX(f.created_at) AS last_at,
      (ARRAY_AGG(f.error ORDER BY f.created_at DESC))[1] AS last_error
    FROM agent_run_failures f
    JOIN agents a ON a.id = f.agent_id AND a.tenant_id = f.tenant_id
    WHERE f.tenant_id = ${tenantId}
      AND f.owner_subject = ${subject}
      AND f.created_at >= NOW() - MAKE_INTERVAL(days => ${days})
    GROUP BY f.agent_id, a.name, f.step_name, f.error_kind, f.outcome_code
    ORDER BY count DESC, last_at DESC
    LIMIT ${limit}
  `.execute(db);
  return rows.rows.map((row) => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    stepName: row.step_name,
    errorKind: row.error_kind,
    outcomeCode: row.outcome_code,
    count: Number(row.count),
    lastAt: row.last_at.toISOString(),
    lastError: row.last_error,
  }));
}
