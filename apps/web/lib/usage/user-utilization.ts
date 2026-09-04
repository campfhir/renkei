/**
 * One person's overall utilization: tokens, agent runs, tool calls — and
 * where their agents are failing — read from three timestamped ledgers
 * and bucketed in the VIEWER's own calendar day.
 *
 * Every read here is keyed on a SUBJECT, and the subject is the caller's
 * own (the action pins it from the session before calling in). Sources:
 *
 *   - `llm_calls` (migration 085): one row per model call, attributed to
 *     the person whose spend it was — a run's owner, whoever asked for an
 *     optimization pass, or the person chatting (purpose 'chat', which
 *     the totals also report on its own).
 *   - `agent_run_log` (migration 083): one row per run of an agent this
 *     person OWNS, with its outcome and, on failure, the step and kind.
 *   - `tool_calls` (migration 032, agent stamped by 086): every MCP tool
 *     call made under this subject — their own calls from a chat client
 *     AND their agents' calls, which execute under a run token bound to
 *     the owner (RENKEI.md Decision #21). So "tool calls" means everything
 *     done as them.
 *
 * All three carry a real timestamp, which is what lets a day mean the
 * viewer's day: rows are bucketed with `AT TIME ZONE` and the window
 * starts at the viewer's midnight, so a bar shows one local day's runs
 * with that day's tool calls and tokens. Nothing here reads the per-day
 * counters (049/072) — those are keyed on the database's calendar and
 * cannot be re-cut per viewer, which is the whole reason the ledgers
 * exist. All three tables are content-free by construction.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '@renkei/db';

export interface UtilizationTotals {
  inputTokens: number;
  outputTokens: number;
  /** The part of the tokens spent in the chat (llm_calls.purpose = 'chat'). */
  chatInputTokens: number;
  chatOutputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

export interface UtilizationDay {
  /** YYYY-MM-DD, in the viewer's zone. */
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
  toolCalls: number;
  /** The most recent failure in the window, if any. */
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

/**
 * The window's start: the viewer's local midnight, `days` calendar days
 * ending today, as an instant. `NOW() AT TIME ZONE tz` is the viewer's
 * wall clock; truncated to the day and stepped back, then read as an
 * instant in that same zone again.
 */
function sinceLocal(days: number, timeZone: string): RawBuilder<Date> {
  return sql<Date>`((date_trunc('day', NOW() AT TIME ZONE ${timeZone}) - MAKE_INTERVAL(days => ${Math.max(0, days - 1)})) AT TIME ZONE ${timeZone})`;
}

/**
 * A timestamp's calendar day in the viewer's zone. Every query that groups
 * by this MUST group by the alias `day`, never by a repeat of the
 * expression: each `${timeZone}` is its own bound parameter, so a repeat
 * is a different expression to Postgres and the query is rejected.
 */
function localDayOf(column: string, timeZone: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`;
}

export async function getUtilizationTotals(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  days: number,
  timeZone: string
): Promise<UtilizationTotals> {
  const since = sinceLocal(days, timeZone);
  const [tokens, runs, calls] = await Promise.all([
    db
      .selectFrom('llm_calls')
      .select(({ fn }) => [
        fn.sum<string>('input_tokens').as('input_tokens'),
        fn.sum<string>('output_tokens').as('output_tokens'),
        sql<string>`COALESCE(SUM(input_tokens) FILTER (WHERE purpose = 'chat'), 0)`.as(
          'chat_input_tokens'
        ),
        sql<string>`COALESCE(SUM(output_tokens) FILTER (WHERE purpose = 'chat'), 0)`.as(
          'chat_output_tokens'
        ),
      ])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('created_at', '>=', since)
      .executeTakeFirst(),
    db
      .selectFrom('agent_run_log')
      .select([
        sql<string>`count(*)`.as('runs'),
        sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', subject)
      .where('created_at', '>=', since)
      .executeTakeFirst(),
    db
      .selectFrom('tool_calls')
      .select([
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('started_at', '>=', since)
      .executeTakeFirst(),
  ]);
  return {
    inputTokens: Number(tokens?.input_tokens ?? 0),
    outputTokens: Number(tokens?.output_tokens ?? 0),
    chatInputTokens: Number(tokens?.chat_input_tokens ?? 0),
    chatOutputTokens: Number(tokens?.chat_output_tokens ?? 0),
    runs: Number(runs?.runs ?? 0),
    failures: Number(runs?.failures ?? 0),
    toolCalls: Number(calls?.calls ?? 0),
    toolErrors: Number(calls?.errors ?? 0),
  };
}

/**
 * The daily series, merged from the three ledgers by the viewer's calendar
 * day. Only days with activity come back; the window helper zero-fills
 * and buckets.
 */
export async function getUtilizationSeries(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  days: number,
  timeZone: string
): Promise<UtilizationDay[]> {
  const since = sinceLocal(days, timeZone);
  const [tokenRows, runRows, callRows] = await Promise.all([
    db
      .selectFrom('llm_calls')
      .select(({ fn }) => [
        localDayOf('created_at', timeZone).as('day'),
        fn.sum<string>('input_tokens').as('input_tokens'),
        fn.sum<string>('output_tokens').as('output_tokens'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('created_at', '>=', since)
      .groupBy(sql`day`)
      .execute(),
    db
      .selectFrom('agent_run_log')
      .select([
        localDayOf('created_at', timeZone).as('day'),
        sql<string>`count(*)`.as('runs'),
        sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', subject)
      .where('created_at', '>=', since)
      .groupBy(sql`day`)
      .execute(),
    db
      .selectFrom('tool_calls')
      .select([
        localDayOf('started_at', timeZone).as('day'),
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('started_at', '>=', since)
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
  for (const row of tokenRows) {
    const point = dayOf(row.day);
    point.inputTokens += Number(row.input_tokens ?? 0);
    point.outputTokens += Number(row.output_tokens ?? 0);
  }
  for (const row of runRows) {
    const point = dayOf(row.day);
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
  days: number,
  timeZone: string
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
  const since = sinceLocal(days, timeZone);

  const [runRows, tokenRows, callRows, failureRows] = await Promise.all([
    db
      .selectFrom('agent_run_log')
      .select([
        'agent_id',
        sql<string>`count(*)`.as('runs'),
        sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', subject)
      .where('agent_id', 'in', ids)
      .where('created_at', '>=', since)
      .groupBy('agent_id')
      .execute(),
    db
      .selectFrom('llm_calls')
      .select(({ fn }) => [
        'agent_id',
        fn.sum<string>('input_tokens').as('input_tokens'),
        fn.sum<string>('output_tokens').as('output_tokens'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('agent_id', 'in', ids)
      .where('created_at', '>=', since)
      .groupBy('agent_id')
      .execute(),
    db
      .selectFrom('tool_calls')
      .select(['agent_id', sql<string>`count(*)`.as('calls')])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('agent_id', 'in', ids)
      .where('started_at', '>=', since)
      .groupBy('agent_id')
      .execute(),
    // The newest failure per agent — DISTINCT ON walks the (agent,
    // created_at) index once.
    sql<{
      agent_id: string;
      created_at: Date;
      step_name: string | null;
      error_kind: string | null;
    }>`
      SELECT DISTINCT ON (agent_id) agent_id, created_at, step_name, error_kind
      FROM agent_run_log
      WHERE tenant_id = ${tenantId}
        AND owner_subject = ${subject}
        AND agent_id IN (${sql.join(ids)})
        AND status = 'failed'
        AND created_at >= ${since}
      ORDER BY agent_id, created_at DESC
    `.execute(db),
  ]);
  const runs = new Map(runRows.map((row) => [row.agent_id, row]));
  const tokens = new Map(tokenRows.map((row) => [row.agent_id, row]));
  const calls = new Map(callRows.map((row) => [row.agent_id, row]));
  const failures = new Map(failureRows.rows.map((row) => [row.agent_id, row]));

  return agents
    .map((agent) => {
      const run = runs.get(agent.id);
      const token = tokens.get(agent.id);
      const call = calls.get(agent.id);
      const failure = failures.get(agent.id);
      return {
        agentId: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        runs: Number(run?.runs ?? 0),
        failures: Number(run?.failures ?? 0),
        inputTokens: Number(token?.input_tokens ?? 0),
        outputTokens: Number(token?.output_tokens ?? 0),
        toolCalls: Number(call?.calls ?? 0),
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
  timeZone: string,
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
    FROM agent_run_log f
    JOIN agents a ON a.id = f.agent_id AND a.tenant_id = f.tenant_id
    WHERE f.tenant_id = ${tenantId}
      AND f.owner_subject = ${subject}
      AND f.status = 'failed'
      AND f.created_at >= ${sinceLocal(days, timeZone)}
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
