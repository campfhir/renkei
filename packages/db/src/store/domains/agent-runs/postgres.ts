import { sql, type Kysely } from 'kysely';
import type { DB, Json } from '../../../db.types';
import { batchFromRow, LIVE_STATUSES, likePattern, stepFromRow, summaryFromRow } from './record';
import type { AgentRunStore } from './types';

const RUN_COLUMNS = [
  'id',
  'agent_id',
  'status',
  'trigger_kind',
  'error_kind',
  'error',
  'created_at',
  'started_at',
  'finished_at',
  'resume_count',
  'resumed_at',
] as const;

/**
 * The trigger payload and the resume note, for the admin audience only on
 * a failed run — a CASE, so content an admin may not see never leaves the
 * database.
 */
// Built on use, not at import: the store barrel is imported everywhere,
// including tests that stub kysely.
const FAILED_INITIAL_STATE = () =>
  sql<Json | null>`
  case when status = 'failed' then initial_state end
`.as('initial_state');
// Built on use, not at import: the store barrel is imported everywhere,
// including tests that stub kysely.
const FAILED_RESUME_GUIDANCE = () =>
  sql<string | null>`
  case when status = 'failed' then resume_guidance end
`.as('resume_guidance');

export function postgresAgentRuns(db: () => Kysely<DB>): AgentRunStore {
  function pendingCards(
    subject: string,
    options: { kind: string; agentId?: string; limit: number }
  ) {
    let query = db()
      .selectFrom('actionable_items as c')
      .innerJoin('agents as a', 'a.id', 'c.created_by_agent_id')
      .leftJoin('agent_runs as r', 'r.id', 'c.run_id')
      .select([
        'c.id as cardId',
        'c.run_id as runId',
        'c.title as title',
        'c.summary as summary',
        'c.suggested_action as suggestedAction',
        'c.created_at as createdAt',
        'a.id as agentId',
        'a.name as agentName',
        'r.waiting_until as waitingUntil',
      ])
      .where('c.owner_subject', '=', subject)
      .where('c.kind', '=', options.kind)
      .where('c.status', '=', 'suggested')
      .where('c.archived_at', 'is', null)
      .orderBy('c.created_at', 'asc')
      .orderBy('c.id')
      .limit(options.limit);
    if (options.agentId) query = query.where('a.id', '=', options.agentId);
    return query;
  }

  return {
    async list({ agentId, ownerSubject, audience, status, q, matchId, limit }) {
      let query = db().selectFrom('agent_runs').select(RUN_COLUMNS).where('agent_id', '=', agentId);
      if (ownerSubject !== null) query = query.where('owner_subject', '=', ownerSubject);
      if (status) query = query.where('status', '=', status);
      if (q) {
        const pattern = likePattern(q);
        query = query.where((eb) =>
          eb.or([
            eb('error', 'ilike', pattern),
            eb('trigger_kind', 'ilike', pattern),
            audience === 'owner'
              ? eb(sql<string>`initial_state::text`, 'ilike', pattern)
              : eb(
                  sql<string>`case when status = 'failed' then initial_state::text end`,
                  'ilike',
                  pattern
                ),
            ...(matchId ? [eb('id', '=', matchId)] : []),
          ])
        );
      }
      const rows = await query.orderBy('created_at', 'desc').orderBy('id').limit(limit).execute();
      return rows.map(summaryFromRow);
    },
    async findDetail({ agentId, runId, ownerSubject, audience }) {
      let query = db()
        .selectFrom('agent_runs')
        .select([
          ...RUN_COLUMNS,
          'owner_subject',
          'definition_snapshot',
          'active_ms',
          ...(audience === 'owner'
            ? (['initial_state', 'resume_guidance'] as const)
            : [FAILED_INITIAL_STATE(), FAILED_RESUME_GUIDANCE()]),
        ])
        .where('agent_id', '=', agentId)
        .where('id', '=', runId);
      if (ownerSubject !== null) query = query.where('owner_subject', '=', ownerSubject);
      const row = await query.executeTakeFirst();
      if (!row) return null;
      const [steps, batches] = await Promise.all([
        db()
          .selectFrom('agent_run_steps')
          .selectAll()
          .where('run_id', '=', row.id)
          // Iteration between index and attempt: a looped step's rounds
          // stay grouped under its block, in execution order.
          .orderBy('step_index')
          .orderBy('iteration')
          .orderBy('attempt')
          .orderBy('step_id')
          .execute(),
        db()
          .selectFrom('agent_action_batches')
          .selectAll()
          .where('run_id', '=', row.id)
          .orderBy('turn')
          .execute(),
      ]);
      return {
        ...summaryFromRow(row),
        ownerSubject: row.owner_subject,
        definitionSnapshot: row.definition_snapshot,
        initialState: row.initial_state,
        resumeGuidance: row.resume_guidance,
        activeMs: Number(row.active_ms ?? 0),
        steps: steps.map(stepFromRow),
        batches: batches.map(batchFromRow),
      };
    },
    async findPauseCard(runId, ownerSubject) {
      const row = await db()
        .selectFrom('actionable_items')
        .select(['id', 'kind', 'status', 'summary', 'suggested_action'])
        .where('run_id', '=', runId)
        .where((eb) => eb.or([eb('kind', '=', 'approval'), eb('kind', '=', 'question')]))
        .where('status', '=', 'suggested')
        .where('owner_subject', '=', ownerSubject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .executeTakeFirst();
      return row
        ? {
            id: row.id,
            kind: row.kind,
            status: row.status,
            summary: row.summary,
            suggestedAction: row.suggested_action,
          }
        : null;
    },
    async findStatus({ agentId, runId, ownerSubject }) {
      let query = db()
        .selectFrom('agent_runs')
        .select(['id', 'status', 'owner_subject'])
        .where('id', '=', runId)
        .where('agent_id', '=', agentId);
      if (ownerSubject !== undefined) query = query.where('owner_subject', '=', ownerSubject);
      const row = await query.executeTakeFirst();
      return row ? { id: row.id, status: row.status, ownerSubject: row.owner_subject } : null;
    },
    async requestCancel(runId, bySubject) {
      const claimed = await db()
        .updateTable('agent_runs')
        .set({
          cancel_requested_at: sql`NOW()`,
          cancel_requested_by: bySubject,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', runId)
        .where('cancel_requested_at', 'is', null)
        .where('status', 'in', [...LIVE_STATUSES])
        .executeTakeFirst();
      return Number(claimed.numUpdatedRows ?? 0) > 0;
    },
    async requeueWaiting(ownerSubject, errorKind) {
      const rows = await db()
        .updateTable('agent_runs')
        .set({ status: 'queued', error: null, error_kind: null, updated_at: sql`NOW()` })
        .where('owner_subject', '=', ownerSubject)
        .where('status', '=', 'waiting')
        .where('error_kind', '=', errorKind)
        .returning(['id', 'agent_id'])
        .execute();
      return rows
        .map((row) => ({ id: row.id, agentId: row.agent_id }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async listPendingCards(subject, options) {
      const rows = await pendingCards(subject, options).execute();
      return rows.map((row) => ({
        cardId: row.cardId,
        runId: row.runId,
        title: row.title,
        summary: row.summary,
        suggestedAction: row.suggestedAction,
        createdAt: new Date(row.createdAt),
        agentId: row.agentId,
        agentName: row.agentName,
        waitingUntil: row.waitingUntil ? new Date(row.waitingUntil) : null,
      }));
    },
    async findCard(cardId, subject) {
      const row = await db()
        .selectFrom('actionable_items')
        .select(['id', 'kind', 'status', 'run_id', 'summary', 'suggested_action'])
        .where('id', '=', cardId)
        .where('owner_subject', '=', subject)
        .executeTakeFirst();
      return row
        ? {
            id: row.id,
            kind: row.kind,
            status: row.status,
            runId: row.run_id,
            summary: row.summary,
            suggestedAction: row.suggested_action,
          }
        : null;
    },
    async claimCard(cardId, { status, result, decidedBy }) {
      const claimed = await db()
        .updateTable('actionable_items')
        .set({
          status,
          result: JSON.stringify(result),
          decided_by: decidedBy,
          decided_at: sql`NOW()`,
          archived_at: sql`NOW()`,
          archived_by: decidedBy,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', cardId)
        .where('status', '=', 'suggested')
        .executeTakeFirst();
      return Number(claimed.numUpdatedRows ?? 0) > 0;
    },
    async findRunAgent(runId) {
      const row = await db()
        .selectFrom('agent_runs')
        .select(['id', 'agent_id'])
        .where('id', '=', runId)
        .executeTakeFirst();
      return row ? { id: row.id, agentId: row.agent_id } : null;
    },
    async findRunOrigin(runId) {
      const row = await db()
        .selectFrom('agent_runs')
        .select(['agent_id', 'trigger_kind'])
        .where('id', '=', runId)
        .executeTakeFirst();
      return row ? { agentId: row.agent_id, triggerKind: row.trigger_kind } : null;
    },
    async optimizationEvidence({ ownerSubject, agentId, days, maxFailures, maxTools }) {
      const since = sql<Date>`NOW() - MAKE_INTERVAL(days => ${days})`;
      const [failureRows, statRow, toolRows] = await Promise.all([
        db()
          .selectFrom('agent_run_log')
          .select([
            'created_at',
            'trigger_kind',
            'error_kind',
            'outcome_code',
            'error',
            'input_tokens',
            'output_tokens',
            'tool_calls',
          ])
          .where('owner_subject', '=', ownerSubject)
          .where('agent_id', '=', agentId)
          .where('status', '=', 'failed')
          .where('created_at', '>=', since)
          .orderBy('created_at', 'desc')
          .orderBy('run_id')
          .limit(maxFailures)
          .execute(),
        // Run-level numbers from the durable log, so the window is honoured
        // even past run retention; the tool profile below reads live turn
        // rows and is bounded by it.
        sql<{
          runs: string;
          succeeded: string;
          failed: string;
          avg_tokens: string | null;
          max_tokens: string | null;
          avg_turns: string | null;
          avg_calls: string | null;
        }>`
          SELECT COUNT(*) AS runs,
                 COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded,
                 COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                 AVG(input_tokens + output_tokens) AS avg_tokens,
                 MAX(input_tokens + output_tokens) AS max_tokens,
                 AVG(attempts) AS avg_turns,
                 AVG(tool_calls) AS avg_calls
          FROM agent_run_log
          WHERE owner_subject = ${ownerSubject}
            AND agent_id = ${agentId}
            AND created_at >= ${since}
            AND status IN ('succeeded', 'failed', 'stopped')
        `.execute(db()),
        // The clear half of each turn's detail outlines its tool calls
        // (name and error flag, never content), which is all this needs.
        sql<{ tool: string; calls: string; failed: string }>`
          SELECT call->>'tool' AS tool,
                 COUNT(*) AS calls,
                 COUNT(*) FILTER (WHERE call->>'isError' = 'true') AS failed
          FROM agent_run_steps s
          JOIN agent_runs r ON r.id = s.run_id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(s.detail->'toolCalls') = 'array'
                 THEN s.detail->'toolCalls' ELSE '[]'::jsonb END
          ) AS call
          WHERE r.owner_subject = ${ownerSubject}
            AND r.agent_id = ${agentId}
            AND r.created_at >= ${since}
            AND call->>'tool' IS NOT NULL
            AND COALESCE(call->>'free', 'false') <> 'true'
          GROUP BY 1
          ORDER BY calls DESC, 1
          LIMIT ${maxTools}
        `.execute(db()),
      ]);
      const stat = statRow.rows[0];
      const numberOrNull = (value: string | null | undefined) =>
        value === null || value === undefined ? null : Number(value);
      return {
        failures: failureRows.map((row) => ({
          createdAt: row.created_at,
          triggerKind: row.trigger_kind,
          errorKind: row.error_kind,
          outcomeCode: row.outcome_code,
          error: row.error,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          toolCalls: row.tool_calls,
        })),
        stats: {
          runs: Number(stat?.runs ?? 0),
          succeeded: Number(stat?.succeeded ?? 0),
          failed: Number(stat?.failed ?? 0),
          avgTokens: numberOrNull(stat?.avg_tokens),
          maxTokens: numberOrNull(stat?.max_tokens),
          avgTurns: numberOrNull(stat?.avg_turns),
          avgCalls: numberOrNull(stat?.avg_calls),
        },
        tools: toolRows.rows.map((row) => ({
          tool: row.tool,
          calls: Number(row.calls),
          failed: Number(row.failed),
        })),
      };
    },
  };
}
