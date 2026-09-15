/**
 * Organization-wide utilization: tokens by surface (chat, chat projects,
 * code projects, agents), how much of the org is actually using it, and
 * the leaderboards an operator needs — who spends the most, which agents
 * cost the most, and which agents get the most tool-call work done per
 * token. The tenant-wide counterpart to `user-utilization.ts`, read from
 * the same content-free ledgers.
 *
 * A couple of functions here (`getSurfaceTokenTotals`,
 * `getMostEfficientAgents`) also take an optional `ownerSubject` that
 * narrows the same query to one person's own chats and agents — "My
 * usage" reuses them rather than re-deriving the same SQL for a
 * single-subject case. Null is always what widens back to the whole
 * tenant.
 *
 * The one thing `llm_calls` (085) cannot say on its own is which CHAT a
 * `purpose = 'chat'` row belongs to — that ledger carries no chat id, only
 * a subject. So the chat/chat-project/code-project split is read instead
 * from `chat_turns` (092), which already carries `input_tokens` and
 * `output_tokens` per turn and links back through `chats.project_id` to a
 * `chat_projects.kind`. Both ledgers are written from the same accumulated
 * totals at the end of a turn (`turn-runner.ts`), so they agree; only the
 * grouping differs.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { sinceLocal, localDayOf } from './user-utilization';

export interface SurfaceTokens {
  input: number;
  output: number;
}

/** Every kind of spend the org has, with nothing left uncounted. */
export interface OrgTokenTotals {
  chat: SurfaceTokens;
  chatProjects: SurfaceTokens;
  codeProjects: SurfaceTokens;
  agents: SurfaceTokens;
}

export interface OrgActivityTotals {
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
  /** Distinct subjects with at least one token spent somewhere in the window. */
  activeUsers: number;
  /** Everyone who has ever signed in to this tenant — the activity rate's denominator. */
  totalUsers: number;
}

export interface OrgDay {
  /** YYYY-MM-DD, in the viewer's zone. */
  day: string;
  chatInputTokens: number;
  chatOutputTokens: number;
  chatProjectInputTokens: number;
  chatProjectOutputTokens: number;
  codeProjectInputTokens: number;
  codeProjectOutputTokens: number;
  agentInputTokens: number;
  agentOutputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

const EMPTY_SURFACE: SurfaceTokens = { input: 0, output: 0 };

interface ChatBucketRow {
  bucket: string;
  input_tokens: string;
  output_tokens: string;
}

/**
 * The chat surface split: a chat with no project is `'chat'`, a project's
 * chat is `'chat_project'` unless the project is a code project (`kind =
 * 'code'`), in which case it's `'code'`. Grouped in SQL so a row never has
 * to be re-labeled on the way out.
 */
const CHAT_BUCKET_CASE = sql`
  CASE
    WHEN c.project_id IS NULL THEN 'chat'
    WHEN cp.kind = 'code' THEN 'code'
    ELSE 'chat_project'
  END
`;

function surfaceOf(rows: readonly ChatBucketRow[], bucket: string): SurfaceTokens {
  const row = rows.find((candidate) => candidate.bucket === bucket);
  return row
    ? { input: Number(row.input_tokens ?? 0), output: Number(row.output_tokens ?? 0) }
    : EMPTY_SURFACE;
}

/**
 * Token totals by surface — org-wide when `ownerSubject` is null (the
 * Organization Usage page), or narrowed to one person's own chats,
 * projects and agents when it isn't (the "My usage" page). Null is the
 * only way to widen, matching `getAgentUsageSummaries`'s convention.
 */
export async function getSurfaceTokenTotals(
  db: Kysely<DB>,
  tenantId: string,
  days: number,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<OrgTokenTotals> {
  const since = sinceLocal(days, timeZone);
  const [chatResult, agentRow] = await Promise.all([
    sql<ChatBucketRow>`
      SELECT
        ${CHAT_BUCKET_CASE} AS bucket,
        COALESCE(SUM(ct.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(ct.output_tokens), 0) AS output_tokens
      FROM chat_turns ct
      JOIN chats c ON c.id = ct.chat_id
      LEFT JOIN chat_projects cp ON cp.id = c.project_id
      WHERE ct.tenant_id = ${tenantId} AND ct.started_at >= ${since}
        ${ownerSubject === null ? sql`` : sql`AND c.owner_subject = ${ownerSubject}`}
      GROUP BY bucket
    `.execute(db),
    sql<{ input_tokens: string; output_tokens: string }>`
      SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM llm_calls
      WHERE tenant_id = ${tenantId} AND agent_id IS NOT NULL AND created_at >= ${since}
        ${ownerSubject === null ? sql`` : sql`AND subject = ${ownerSubject}`}
    `.execute(db),
  ]);
  return {
    chat: surfaceOf(chatResult.rows, 'chat'),
    chatProjects: surfaceOf(chatResult.rows, 'chat_project'),
    codeProjects: surfaceOf(chatResult.rows, 'code'),
    agents: {
      input: Number(agentRow.rows[0]?.input_tokens ?? 0),
      output: Number(agentRow.rows[0]?.output_tokens ?? 0),
    },
  };
}

export async function getOrgActivityTotals(
  db: Kysely<DB>,
  tenantId: string,
  days: number,
  timeZone: string
): Promise<OrgActivityTotals> {
  const since = sinceLocal(days, timeZone);
  const [runs, calls, active, total] = await Promise.all([
    db
      .selectFrom('agent_run_log')
      .select([
        sql<string>`count(*)`.as('runs'),
        sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('created_at', '>=', since)
      .executeTakeFirst(),
    db
      .selectFrom('tool_calls')
      .select([
        sql<string>`count(*)`.as('calls'),
        sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('started_at', '>=', since)
      .executeTakeFirst(),
    db
      .selectFrom('llm_calls')
      .select(sql<string>`count(DISTINCT subject)`.as('n'))
      .where('tenant_id', '=', tenantId)
      .where('created_at', '>=', since)
      .executeTakeFirst(),
    db
      .selectFrom('identities')
      .select(sql<string>`count(DISTINCT subject)`.as('n'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst(),
  ]);
  return {
    runs: Number(runs?.runs ?? 0),
    failures: Number(runs?.failures ?? 0),
    toolCalls: Number(calls?.calls ?? 0),
    toolErrors: Number(calls?.errors ?? 0),
    activeUsers: Number(active?.n ?? 0),
    totalUsers: Number(total?.n ?? 0),
  };
}

/**
 * The daily series behind the trend chart, one row per calendar day (in
 * the viewer's zone) with every surface's tokens plus runs and tool
 * calls. Active-user counts are deliberately NOT part of this series:
 * summing a day's distinct subjects across a multi-day bucket would count
 * the same person once per day they were active, which is a different
 * (and less honest) number than the period's actual reach — that number
 * comes from `getOrgActivityTotals` instead, computed once over the whole
 * window.
 */
export async function getOrgDailySeries(
  db: Kysely<DB>,
  tenantId: string,
  days: number,
  timeZone: string
): Promise<OrgDay[]> {
  const since = sinceLocal(days, timeZone);
  const [chatRows, agentRows, runRows, callRows] = await Promise.all([
    sql<ChatBucketRow & { day: string }>`
      SELECT
        to_char(ct.started_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
        ${CHAT_BUCKET_CASE} AS bucket,
        COALESCE(SUM(ct.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(ct.output_tokens), 0) AS output_tokens
      FROM chat_turns ct
      JOIN chats c ON c.id = ct.chat_id
      LEFT JOIN chat_projects cp ON cp.id = c.project_id
      WHERE ct.tenant_id = ${tenantId} AND ct.started_at >= ${since}
      GROUP BY day, bucket
    `.execute(db),
    sql<{ day: string; input_tokens: string; output_tokens: string }>`
      SELECT to_char(created_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM llm_calls
      WHERE tenant_id = ${tenantId} AND agent_id IS NOT NULL AND created_at >= ${since}
      GROUP BY day
    `.execute(db),
    db
      .selectFrom('agent_run_log')
      .select([
        localDayOf('created_at', timeZone).as('day'),
        sql<string>`count(*)`.as('runs'),
        sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
      ])
      .where('tenant_id', '=', tenantId)
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
      .where('started_at', '>=', since)
      .groupBy(sql`day`)
      .execute(),
  ]);

  const byDay = new Map<string, OrgDay>();
  const dayOf = (day: string): OrgDay => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const fresh: OrgDay = {
      day,
      chatInputTokens: 0,
      chatOutputTokens: 0,
      chatProjectInputTokens: 0,
      chatProjectOutputTokens: 0,
      codeProjectInputTokens: 0,
      codeProjectOutputTokens: 0,
      agentInputTokens: 0,
      agentOutputTokens: 0,
      runs: 0,
      failures: 0,
      toolCalls: 0,
      toolErrors: 0,
    };
    byDay.set(day, fresh);
    return fresh;
  };
  for (const row of chatRows.rows) {
    const point = dayOf(row.day);
    const input = Number(row.input_tokens ?? 0);
    const output = Number(row.output_tokens ?? 0);
    if (row.bucket === 'chat') {
      point.chatInputTokens += input;
      point.chatOutputTokens += output;
    } else if (row.bucket === 'chat_project') {
      point.chatProjectInputTokens += input;
      point.chatProjectOutputTokens += output;
    } else {
      point.codeProjectInputTokens += input;
      point.codeProjectOutputTokens += output;
    }
  }
  for (const row of agentRows.rows) {
    const point = dayOf(row.day);
    point.agentInputTokens += Number(row.input_tokens ?? 0);
    point.agentOutputTokens += Number(row.output_tokens ?? 0);
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

export interface TopUserRow {
  subject: string;
  label: string;
  /** Tokens across the person's own chats, chat projects and code projects. */
  chatTokens: number;
  /** Tokens across the agents this person owns — separate, foldable into the rank on request. */
  agentTokens: number;
  /** `chatTokens`, plus `agentTokens` when the caller asked to include them. */
  totalTokens: number;
}

/**
 * People ranked by how much they've spent — chat, chat-project and
 * code-project tokens by default, with agent spend folded into the same
 * rank when `includeAgents` is set. Both figures are always returned so a
 * UI can show the split even while ranking on the combined total.
 */
export async function getTopUsers(
  db: Kysely<DB>,
  tenantId: string,
  days: number,
  timeZone: string,
  includeAgents: boolean,
  limit = 10
): Promise<TopUserRow[]> {
  const since = sinceLocal(days, timeZone);
  const [chatRows, agentRows, identityRows] = await Promise.all([
    db
      .selectFrom('chat_turns')
      .innerJoin('chats', 'chats.id', 'chat_turns.chat_id')
      .select(({ fn }) => [
        'chats.owner_subject as subject',
        fn.sum<string>('chat_turns.input_tokens').as('input_tokens'),
        fn.sum<string>('chat_turns.output_tokens').as('output_tokens'),
      ])
      .where('chat_turns.tenant_id', '=', tenantId)
      .where('chat_turns.started_at', '>=', since)
      .groupBy('chats.owner_subject')
      .execute(),
    sql<{ subject: string; input_tokens: string; output_tokens: string }>`
      SELECT subject, COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM llm_calls
      WHERE tenant_id = ${tenantId} AND agent_id IS NOT NULL AND created_at >= ${since}
      GROUP BY subject
    `.execute(db),
    db
      .selectFrom('identities')
      .select(['subject', 'display_name', 'email'])
      .where('tenant_id', '=', tenantId)
      .execute(),
  ]);

  const identityBySubject = new Map(identityRows.map((row) => [row.subject, row]));
  const chatBySubject = new Map(chatRows.map((row) => [row.subject, row]));
  const agentBySubject = new Map(agentRows.rows.map((row) => [row.subject, row]));
  const subjects = new Set<string>([...chatBySubject.keys(), ...agentBySubject.keys()]);

  const rows: TopUserRow[] = [...subjects].map((subject) => {
    const chat = chatBySubject.get(subject);
    const agent = agentBySubject.get(subject);
    const chatTokens = Number(chat?.input_tokens ?? 0) + Number(chat?.output_tokens ?? 0);
    const agentTokens = Number(agent?.input_tokens ?? 0) + Number(agent?.output_tokens ?? 0);
    const identity = identityBySubject.get(subject);
    return {
      subject,
      label: identity?.display_name || identity?.email || subject,
      chatTokens,
      agentTokens,
      totalTokens: chatTokens + (includeAgents ? agentTokens : 0),
    };
  });

  return rows.sort((left, right) => right.totalTokens - left.totalTokens).slice(0, limit);
}

export interface TopAgentRow {
  agentId: string;
  name: string;
  enabled: boolean;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

/** Agents ranked by token spend over the window — the org's biggest agent bills. */
export async function getTopAgentsByTokens(
  db: Kysely<DB>,
  tenantId: string,
  days: number,
  timeZone: string,
  limit = 10
): Promise<TopAgentRow[]> {
  const since = sinceLocal(days, timeZone);
  const rows = await sql<{
    agent_id: string;
    name: string;
    enabled: boolean;
    input_tokens: string;
    output_tokens: string;
  }>`
    SELECT a.id AS agent_id, a.name, a.enabled,
           SUM(l.input_tokens) AS input_tokens, SUM(l.output_tokens) AS output_tokens
    FROM llm_calls l
    JOIN agents a ON a.id = l.agent_id
    WHERE l.tenant_id = ${tenantId} AND l.agent_id IS NOT NULL AND l.created_at >= ${since}
    GROUP BY a.id, a.name, a.enabled
    ORDER BY SUM(l.input_tokens) + SUM(l.output_tokens) DESC
    LIMIT ${limit}
  `.execute(db);
  if (rows.rows.length === 0) return [];

  const ids = rows.rows.map((row) => row.agent_id);
  const runRows = await db
    .selectFrom('agent_run_log')
    .select(['agent_id', sql<string>`count(*)`.as('runs')])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', 'in', ids)
    .where('created_at', '>=', since)
    .groupBy('agent_id')
    .execute();
  const runsByAgent = new Map(runRows.map((row) => [row.agent_id, Number(row.runs)]));

  return rows.rows.map((row) => ({
    agentId: row.agent_id,
    name: row.name,
    enabled: row.enabled,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    runs: runsByAgent.get(row.agent_id) ?? 0,
  }));
}

export interface EfficientAgentRow {
  agentId: string;
  name: string;
  succeededRuns: number;
  tokens: number;
  toolCalls: number;
  tokensPerRun: number;
  toolCallsPerRun: number;
  /** Tool calls per 1,000 tokens spent — higher means more work done per token. */
  efficiency: number;
}

/**
 * Agents doing the most actual work per token: among SUCCEEDED runs only
 * (a cheap run that fails proves nothing), tool calls per token spent —
 * an agent that runs cheaply but never calls a tool (nothing to check, or
 * nothing to do) is not "efficient" by this measure, it's idle. Weighting
 * by tool calls rather than ranking on raw tokens-per-run alone is the
 * point: it separates an agent that gets real work done cheaply from one
 * that is merely cheap.
 *
 * `minSucceededRuns` keeps a single lucky run from topping the list —
 * three by default, low enough for a new agent to qualify within a normal
 * reporting window.
 *
 * `ownerSubject` narrows to one person's own agents (the "My usage" page);
 * null ranks every agent in the tenant (Organization Usage). Null is the
 * only way to widen.
 */
export async function getMostEfficientAgents(
  db: Kysely<DB>,
  tenantId: string,
  days: number,
  timeZone: string,
  limit = 10,
  minSucceededRuns = 3,
  ownerSubject: string | null = null
): Promise<EfficientAgentRow[]> {
  const since = sinceLocal(days, timeZone);
  const rows = await sql<{
    agent_id: string;
    name: string;
    succeeded_runs: string;
    input_tokens: string;
    output_tokens: string;
    tool_calls: string;
  }>`
    SELECT a.id AS agent_id, a.name, COUNT(*) AS succeeded_runs,
           SUM(f.input_tokens) AS input_tokens, SUM(f.output_tokens) AS output_tokens,
           SUM(f.tool_calls) AS tool_calls
    FROM agent_run_log f
    JOIN agents a ON a.id = f.agent_id
    WHERE f.tenant_id = ${tenantId} AND f.status = 'succeeded' AND f.created_at >= ${since}
      ${ownerSubject === null ? sql`` : sql`AND f.owner_subject = ${ownerSubject}`}
    GROUP BY a.id, a.name
    HAVING COUNT(*) >= ${minSucceededRuns}
  `.execute(db);

  const scored: EfficientAgentRow[] = rows.rows.map((row) => {
    const succeededRuns = Number(row.succeeded_runs);
    const tokens = Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
    const toolCalls = Number(row.tool_calls ?? 0);
    return {
      agentId: row.agent_id,
      name: row.name,
      succeededRuns,
      tokens,
      toolCalls,
      tokensPerRun: succeededRuns > 0 ? Math.round(tokens / succeededRuns) : 0,
      toolCallsPerRun: succeededRuns > 0 ? toolCalls / succeededRuns : 0,
      efficiency: tokens > 0 ? (toolCalls / tokens) * 1000 : 0,
    };
  });

  return scored.sort((left, right) => right.efficiency - left.efficiency).slice(0, limit);
}

export interface OrgToolRow {
  tool: string;
  connector: string | null;
  calls: number;
  errors: number;
}

/** The org's most-used tools over the window — the same ranking the tools page's "org top" card shows. */
export async function getTopToolsOrg(
  db: Kysely<DB>,
  tenantId: string,
  days: number,
  timeZone: string,
  limit = 10
): Promise<OrgToolRow[]> {
  const since = sinceLocal(days, timeZone);
  const rows = await db
    .selectFrom('tool_calls')
    .select([
      'tool',
      'connector',
      sql<string>`count(*)`.as('calls'),
      sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('started_at', '>=', since)
    .groupBy(['tool', 'connector'])
    .orderBy(sql`count(*)`, 'desc')
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    tool: row.tool,
    connector: row.connector,
    calls: Number(row.calls),
    errors: Number(row.errors),
  }));
}
