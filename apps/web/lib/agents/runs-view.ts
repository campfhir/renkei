/**
 * Run history reads, with the visibility rule applied AT THE QUERY SEAM.
 *
 * Two audiences, one schema: status/outcome/timing columns are content-free
 * and safe for any org operator; the `detail` jsonb is CONTENT. The owner
 * gets it always; an admin gets it only for FAILED attempts — enough to
 * troubleshoot a broken agent, nothing of a working one's inner life. The
 * projection happens here, in the functions pages call, so no page can
 * forget to redact: the admin functions never even SELECT what they must
 * not show.
 */

import { sql, type Kysely } from 'kysely';
import type { DB, Json } from '@renkei/db';
import { findNodeById, isAgentStepsDoc } from '@renkei/agents';
import { isUuid } from '@/lib/uuid';

export interface RunSummary {
  id: string;
  status: string;
  triggerKind: string;
  errorKind: string | null;
  error: string | null;
  /** Resolved from the snapshot when errorKind is 'step_failed', else null. */
  failedStepName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Milliseconds, when both ends exist. */
  durationMs: number | null;
}

export interface AttemptView {
  stepId: string;
  stepIndex: number;
  attempt: number;
  /** 0 = not inside a loop; 1-based loop round otherwise. */
  iteration: number;
  status: string;
  outcome: string | null;
  outcomeCode: string | null;
  toolCallCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Absent = redacted (admin viewing a non-failed attempt). */
  detail?: Json;
  redacted: boolean;
}

export interface RunDetail extends RunSummary {
  stepsSnapshot: Json;
  attempts: AttemptView[];
  /**
   * What the trigger handed the run — the `trigger.*` variables it started
   * with. Absent when redacted, which follows the SAME rule the per-attempt
   * detail does: the owner always, an admin only on a failed run. It is
   * content (an email's subject, a message's text), so it cannot be treated
   * as the content-free status columns are.
   */
  initialState?: Json;
  initialStateRedacted: boolean;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

interface RunRow {
  id: string;
  status: string;
  trigger_kind: string;
  error_kind: string | null;
  error: string | null;
  current_step_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** The failed step's name, from wherever the caller has a snapshot. */
function failedStepNameOf(
  row: Pick<RunRow, 'error_kind' | 'current_step_id'>,
  snapshot: Json | null | undefined
): string | null {
  if (row.error_kind !== 'step_failed' || !row.current_step_id) return null;
  if (!isAgentStepsDoc(snapshot)) return null;
  const found = findNodeById(snapshot.steps, row.current_step_id);
  return found?.node.name || null;
}

function summaryOf(row: RunRow, snapshot?: Json | null): RunSummary {
  return {
    id: row.id,
    status: row.status,
    triggerKind: row.trigger_kind,
    errorKind: row.error_kind,
    error: row.error,
    failedStepName: failedStepNameOf(row, snapshot),
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    durationMs:
      row.started_at && row.finished_at
        ? row.finished_at.getTime() - row.started_at.getTime()
        : null,
  };
}

const RUN_COLUMNS = [
  'id',
  'status',
  'trigger_kind',
  'error_kind',
  'error',
  'current_step_id',
  'created_at',
  'started_at',
  'finished_at',
] as const;

/**
 * The snapshot ONLY for rows that need it for a name lookup — a list of
 * healthy runs transfers zero jsonb, and `RunSummary` never exposes the
 * snapshot itself.
 */
const FAILED_SNAPSHOT = sql<Json | null>`
  case when error_kind = 'step_failed' then steps_snapshot end
`.as('failed_snapshot');

/**
 * The trigger payload, for the admin path only — and only on a failed run.
 *
 * A CASE rather than a filter in TypeScript, for the same reason
 * FAILED_SNAPSHOT is one: content an admin may not see never leaves the
 * database, so no later refactor can accidentally surface it. `runDetail`
 * applies the same rule again when it sets `initialStateRedacted`; the two
 * agreeing is the point, not duplication to remove.
 */
const FAILED_INITIAL_STATE = sql<Json | null>`
  case when status = 'failed' then initial_state end
`.as('initial_state');

/**
 * Every status a run can be in — the one authoritative list. The runs
 * pages' filter tabs, the MCP surface, and the query options all read
 * this so a status added later cannot be missed by one of them.
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'stopped',
  'canceled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: string | undefined): value is RunStatus {
  return RUN_STATUSES.some((status) => status === value);
}

/** A user's search text as a literal ILIKE pattern — wildcards escaped. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function listRunsForOwner(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string,
  options: {
    status?: RunStatus;
    /** Free-text search; see the predicate below for what it matches. */
    q?: string;
    limit?: number;
  } = {}
): Promise<RunSummary[]> {
  if (!isUuid(agentId)) return [];
  let query = db
    .selectFrom('agent_runs')
    .select([...RUN_COLUMNS, FAILED_SNAPSHOT])
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('agent_id', '=', agentId);
  if (options.status) query = query.where('status', '=', options.status);
  const q = options.q?.trim();
  if (q) {
    // The owner sees everything about their own runs, so the search may
    // read content: the error text, the trigger kind, and the trigger
    // input (the payload the run started from — the thing a person
    // actually remembers about "that particular run"). A pasted run id
    // matches exactly. Unindexed ILIKE on purpose: one agent's retained
    // runs are bounded by the retention sweep and the LIMIT below.
    const pattern = likePattern(q);
    query = query.where((eb) =>
      eb.or([
        eb('error', 'ilike', pattern),
        eb('trigger_kind', 'ilike', pattern),
        eb(sql<string>`initial_state::text`, 'ilike', pattern),
        ...(isUuid(q) ? [eb('id', '=', q)] : []),
      ])
    );
  }
  const rows = await query
    .orderBy('created_at', 'desc')
    .limit(options.limit ?? 50)
    .execute();
  return rows.map((row) => summaryOf(row, row.failed_snapshot));
}

async function runDetail(
  db: Kysely<DB>,
  runRow: RunRow & { steps_snapshot: Json; initial_state: Json | null },
  audience: 'owner' | 'admin'
): Promise<RunDetail> {
  const attemptRows = await db
    .selectFrom('agent_run_steps')
    .select([
      'step_id',
      'step_index',
      'attempt',
      'iteration',
      'status',
      'outcome',
      'outcome_code',
      'tool_call_count',
      'detail',
      'started_at',
      'finished_at',
    ])
    .where('run_id', '=', runRow.id)
    // Iteration between index and attempt: a looped step's rounds stay
    // grouped under its block, in execution order. All-zero iterations
    // (every pre-v3 run) sort identically to the old query.
    .orderBy('step_index')
    .orderBy('iteration')
    .orderBy('attempt')
    .execute();

  // The run-level equivalent of the per-attempt rule below: an admin sees
  // what a run started with only when it failed. A working agent's inbound
  // mail is not theirs to read.
  const initialVisible = audience === 'owner' || runRow.status === 'failed';

  return {
    ...summaryOf(runRow, runRow.steps_snapshot),
    stepsSnapshot: runRow.steps_snapshot,
    ...(initialVisible && runRow.initial_state !== null
      ? { initialState: runRow.initial_state }
      : {}),
    initialStateRedacted: !initialVisible,
    attempts: attemptRows.map((row) => {
      // THE visibility rule: content for the owner always; for an admin
      // only when the attempt failed (troubleshooting is their job,
      // reading a working agent's content is not).
      const contentVisible = audience === 'owner' || row.status === 'failed';
      return {
        stepId: row.step_id,
        stepIndex: row.step_index,
        attempt: row.attempt,
        iteration: row.iteration,
        status: row.status,
        outcome: row.outcome,
        outcomeCode: row.outcome_code,
        toolCallCount: row.tool_call_count,
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        ...(contentVisible && row.detail !== null ? { detail: row.detail } : {}),
        redacted: !contentVisible,
      };
    }),
  };
}

export async function getRunForOwner(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string,
  runId: string
): Promise<RunDetail | null> {
  if (!isUuid(agentId) || !isUuid(runId)) return null;
  const row = await db
    .selectFrom('agent_runs')
    .select([...RUN_COLUMNS, 'steps_snapshot', 'initial_state'])
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('agent_id', '=', agentId)
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!row) return null;
  return runDetail(db, row, 'owner');
}

/** Admin oversight: any agent's runs, statuses always, content on failures. */
export async function listRunsForAdmin(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  options: { status?: RunStatus; q?: string; limit?: number } = {}
): Promise<RunSummary[]> {
  if (!isUuid(agentId)) return [];
  let query = db
    .selectFrom('agent_runs')
    .select([...RUN_COLUMNS, FAILED_SNAPSHOT])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId);
  if (options.status) query = query.where('status', '=', options.status);
  const q = options.q?.trim();
  if (q) {
    // The admin search obeys the same content rule as FAILED_INITIAL_STATE:
    // trigger input is matched only on failed runs — a match count over
    // healthy runs' content would leak by side channel what the admin
    // cannot read. Error text and a pasted run id are always fair game.
    const pattern = likePattern(q);
    query = query.where((eb) =>
      eb.or([
        eb('error', 'ilike', pattern),
        eb('trigger_kind', 'ilike', pattern),
        eb(sql<string>`case when status = 'failed' then initial_state::text end`, 'ilike', pattern),
        ...(isUuid(q) ? [eb('id', '=', q)] : []),
      ])
    );
  }
  const rows = await query
    .orderBy('created_at', 'desc')
    .limit(options.limit ?? 50)
    .execute();
  return rows.map((row) => summaryOf(row, row.failed_snapshot));
}

export async function getRunForAdmin(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  runId: string
): Promise<RunDetail | null> {
  if (!isUuid(agentId) || !isUuid(runId)) return null;
  const row = await db
    .selectFrom('agent_runs')
    .select([...RUN_COLUMNS, 'steps_snapshot', FAILED_INITIAL_STATE])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!row) return null;
  return runDetail(db, row, 'admin');
}

export interface AdminAgentRow {
  id: string;
  name: string;
  ownerSubject: string;
  ownerEmail: string | null;
  enabled: boolean;
  descriptionStatus: string;
  lastRunAt: string | null;
}

export interface AdminAgentDetail extends AdminAgentRow {
  description: string | null;
}

/** One agent, for the admin detail page — the single-row sibling of listAgentsForAdmin. */
export async function getAgentForAdmin(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<AdminAgentDetail | null> {
  if (!isUuid(agentId)) return null;
  const agent = await db
    .selectFrom('agents as a')
    .leftJoin('identities as i', (join) =>
      join.onRef('i.tenant_id', '=', 'a.tenant_id').onRef('i.subject', '=', 'a.owner_subject')
    )
    .select([
      'a.id',
      'a.name',
      'a.owner_subject',
      'a.enabled',
      'a.description',
      'a.description_status',
      'i.email',
    ])
    .where('a.tenant_id', '=', tenantId)
    .where('a.id', '=', agentId)
    .executeTakeFirst();
  if (!agent) return null;

  const lastRun = await db
    .selectFrom('agent_runs')
    .select('created_at')
    .where('agent_id', '=', agentId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return {
    id: agent.id,
    name: agent.name,
    ownerSubject: agent.owner_subject,
    ownerEmail: agent.email,
    enabled: agent.enabled,
    description: agent.description,
    descriptionStatus: agent.description_status,
    lastRunAt: lastRun ? lastRun.created_at.toISOString() : null,
  };
}

/**
 * Every agent in the org, or every agent owned by one person — the shared
 * query behind the oversight list and the people page's drill-down. Run and
 * failure tallies come from agent_run_counters on the page itself, not from
 * here: run ROWS are pruned by retention, counters are not.
 *
 * `ownerSubject: null` means every agent in the tenant; a subject narrows to
 * just theirs. Same "null is the only way to widen" shape `getAgentUsageSummaries`
 * already uses, for the same reason.
 */
async function listAgentRows(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string | null
): Promise<AdminAgentRow[]> {
  let query = db
    .selectFrom('agents as a')
    .leftJoin('identities as i', (join) =>
      join.onRef('i.tenant_id', '=', 'a.tenant_id').onRef('i.subject', '=', 'a.owner_subject')
    )
    .select(['a.id', 'a.name', 'a.owner_subject', 'a.enabled', 'a.description_status', 'i.email'])
    .where('a.tenant_id', '=', tenantId);
  if (ownerSubject !== null) query = query.where('a.owner_subject', '=', ownerSubject);
  const agents = await query.orderBy('a.name').execute();

  const rows: AdminAgentRow[] = [];
  for (const agent of agents) {
    const lastRun = await db
      .selectFrom('agent_runs')
      .select('created_at')
      .where('agent_id', '=', agent.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    rows.push({
      id: agent.id,
      name: agent.name,
      ownerSubject: agent.owner_subject,
      ownerEmail: agent.email,
      enabled: agent.enabled,
      descriptionStatus: agent.description_status,
      lastRunAt: lastRun ? lastRun.created_at.toISOString() : null,
    });
  }
  return rows;
}

export async function listAgentsForAdmin(
  db: Kysely<DB>,
  tenantId: string
): Promise<AdminAgentRow[]> {
  return listAgentRows(db, tenantId, null);
}

/** One person's own agents — the people page's drill-down. */
export async function listAgentsForOwner(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string
): Promise<AdminAgentRow[]> {
  return listAgentRows(db, tenantId, ownerSubject);
}
