import { groupBy, like, orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { jsonbText, jsonField } from '../agents/json';
import {
  batchFromRow,
  LIVE_STATUSES,
  likePattern,
  newRunValues,
  runLogFromRow,
  stepFromRow,
  summaryFromRow,
} from './record';
import type { AgentRunStore } from './types';

const LIVE: readonly string[] = LIVE_STATUSES;
const SETTLED: readonly string[] = ['succeeded', 'failed', 'stopped'];

export function memoryAgentRuns(tables: MemoryTables): AgentRunStore {
  const runId = (value: string) => tables.param('agent_runs', 'id', value);
  const agentOf = (value: string) => tables.param('agent_runs', 'agent_id', value);

  return {
    async list({ agentId, ownerSubject, audience, status, q, matchId, limit }) {
      const agent = agentOf(agentId);
      const id = matchId ? runId(matchId) : undefined;
      const pattern = q ? likePattern(q) : null;
      const rows = tables.select('agent_runs', (r) => {
        if (r.agent_id !== agent) return false;
        if (ownerSubject !== null && r.owner_subject !== ownerSubject) return false;
        if (status && r.status !== status) return false;
        if (pattern === null) return true;
        const input =
          r.initial_state === null || (audience === 'admin' && r.status !== 'failed')
            ? null
            : jsonbText(r.initial_state);
        return (
          like(r.error, pattern) ||
          like(r.trigger_kind, pattern) ||
          like(input, pattern) ||
          (id !== undefined && r.id === id)
        );
      });
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]), limit).map(
        summaryFromRow
      );
    },
    async findDetail({ agentId, runId: wanted, ownerSubject, audience }) {
      const agent = agentOf(agentId);
      const id = runId(wanted);
      const row = tables.first(
        'agent_runs',
        (r) =>
          r.agent_id === agent &&
          r.id === id &&
          (ownerSubject === null || r.owner_subject === ownerSubject)
      );
      if (!row) return null;
      const contentVisible = audience === 'owner' || row.status === 'failed';
      const steps = orderBy(
        tables.select('agent_run_steps', (r) => r.run_id === row.id),
        [(r) => r.step_index],
        [(r) => r.iteration],
        [(r) => r.attempt],
        [(r) => r.step_id]
      );
      const batches = orderBy(
        tables.select('agent_action_batches', (r) => r.run_id === row.id),
        [(r) => r.turn]
      );
      return {
        ...summaryFromRow(row),
        ownerSubject: row.owner_subject,
        definitionSnapshot: row.definition_snapshot,
        initialState: contentVisible ? row.initial_state : null,
        resumeGuidance: contentVisible ? row.resume_guidance : null,
        activeMs: Number(row.active_ms ?? 0),
        steps: steps.map(stepFromRow),
        batches: batches.map(batchFromRow),
      };
    },
    async findPauseCard(wanted, ownerSubject) {
      const id = tables.param('actionable_items', 'run_id', wanted);
      const [row] = orderBy(
        tables.select(
          'actionable_items',
          (r) =>
            r.run_id === id &&
            (r.kind === 'approval' || r.kind === 'question') &&
            r.status === 'suggested' &&
            r.owner_subject === ownerSubject
        ),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
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
    async findStatus({ agentId, runId: wanted, ownerSubject }) {
      const id = runId(wanted);
      const agent = agentOf(agentId);
      const row = tables.first(
        'agent_runs',
        (r) =>
          r.id === id &&
          r.agent_id === agent &&
          (ownerSubject === undefined || r.owner_subject === ownerSubject)
      );
      return row ? { id: row.id, status: row.status, ownerSubject: row.owner_subject } : null;
    },
    async findRestartSource({ agentId, runId: wanted, ownerSubject }) {
      const id = runId(wanted);
      const agent = agentOf(agentId);
      const row = tables.first(
        'agent_runs',
        (r) => r.id === id && r.agent_id === agent && r.owner_subject === ownerSubject
      );
      return row
        ? {
            id: row.id,
            status: row.status,
            triggerKind: row.trigger_kind,
            triggerId: row.trigger_id,
            initialState: row.initial_state,
          }
        : null;
    },
    async forceCancel(wanted, { bySubject, errorKind, error }) {
      const id = runId(wanted);
      const now = new Date();
      const claimed = tables.update(
        'agent_runs',
        (r) => r.id === id && LIVE.includes(r.status),
        (row) => ({
          status: 'canceled',
          error_kind: errorKind,
          error,
          finished_at: now,
          updated_at: now,
          cancel_requested_at: row.cancel_requested_at ?? now,
          cancel_requested_by: row.cancel_requested_by ?? bySubject,
        })
      );
      if (claimed.length === 0) return false;
      tables.update('agent_run_steps', (r) => r.run_id === id && r.status === 'running', {
        status: 'canceled',
        finished_at: now,
        updated_at: now,
      });
      return true;
    },
    async requestCancel(wanted, bySubject) {
      const id = runId(wanted);
      const now = new Date();
      return (
        tables.update(
          'agent_runs',
          (r) => r.id === id && r.cancel_requested_at === null && LIVE.includes(r.status),
          { cancel_requested_at: now, cancel_requested_by: bySubject, updated_at: now }
        ).length > 0
      );
    },
    async requeueWaiting(ownerSubject, errorKind) {
      const rows = tables.update(
        'agent_runs',
        (r) =>
          r.owner_subject === ownerSubject && r.status === 'waiting' && r.error_kind === errorKind,
        { status: 'queued', error: null, error_kind: null, updated_at: new Date() }
      );
      return rows
        .map((row) => ({ id: row.id, agentId: row.agent_id }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async listPendingCards(subject, { kind, agentId, limit }) {
      const agent = agentId ? tables.param('agents', 'id', agentId) : undefined;
      const rows = tables.select(
        'actionable_items',
        (r) =>
          r.owner_subject === subject &&
          r.kind === kind &&
          r.status === 'suggested' &&
          r.archived_at === null &&
          r.created_by_agent_id !== null &&
          (agent === undefined || r.created_by_agent_id === agent)
      );
      const joined = rows.flatMap((row) => {
        const owner = tables.first('agents', (a) => a.id === row.created_by_agent_id);
        if (!owner) return [];
        const run = row.run_id ? tables.first('agent_runs', (r) => r.id === row.run_id) : undefined;
        return [{ row, agent: owner, run }];
      });
      return page(orderBy(joined, [(j) => j.row.created_at], [(j) => j.row.id]), limit).map(
        ({ row, agent: owner, run }) => ({
          cardId: row.id,
          runId: row.run_id,
          title: row.title,
          summary: row.summary,
          suggestedAction: row.suggested_action,
          createdAt: row.created_at,
          agentId: owner.id,
          agentName: owner.name,
          waitingUntil: run?.waiting_until ?? null,
        })
      );
    },
    async findCard(cardId, subject) {
      const id = tables.param('actionable_items', 'id', cardId);
      const row = tables.first(
        'actionable_items',
        (r) => r.id === id && r.owner_subject === subject
      );
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
      const id = tables.param('actionable_items', 'id', cardId);
      const now = new Date();
      return (
        tables.update('actionable_items', (r) => r.id === id && r.status === 'suggested', {
          status,
          result: JSON.stringify(result),
          decided_by: decidedBy,
          decided_at: now,
          archived_at: now,
          archived_by: decidedBy,
          updated_at: now,
        }).length > 0
      );
    },
    async findRunAgent(wanted) {
      const id = runId(wanted);
      const row = tables.first('agent_runs', (r) => r.id === id);
      return row ? { id: row.id, agentId: row.agent_id } : null;
    },
    async findRunOrigin(wanted) {
      const id = runId(wanted);
      const row = tables.first('agent_runs', (r) => r.id === id);
      return row ? { agentId: row.agent_id, triggerKind: row.trigger_kind } : null;
    },
    async findRunError(wanted) {
      const id = runId(wanted);
      const row = tables.first('agent_runs', (r) => r.id === id);
      return row ? { error: row.error } : null;
    },
    async optimizationEvidence({ ownerSubject, agentId, days, maxFailures, maxTools }) {
      const agent = agentOf(agentId);
      const since = Date.now() - days * 86_400_000;
      const logged = tables.select(
        'agent_run_log',
        (r) =>
          r.owner_subject === ownerSubject &&
          r.agent_id === agent &&
          r.created_at.getTime() >= since
      );
      const failures = page(
        orderBy(
          logged.filter((r) => r.status === 'failed'),
          [(r) => r.created_at, 'desc'],
          [(r) => r.run_id]
        ),
        maxFailures
      );
      const settled = logged.filter((r) => SETTLED.includes(r.status));
      const average = (values: number[]) =>
        values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
      const tokens = settled.map((r) => r.input_tokens + r.output_tokens);

      const runIds = new Set(
        tables
          .select(
            'agent_runs',
            (r) =>
              r.owner_subject === ownerSubject &&
              r.agent_id === agent &&
              r.created_at.getTime() >= since
          )
          .map((r) => r.id)
      );
      const calls = tables
        .select('agent_run_steps', (s) => runIds.has(s.run_id))
        .flatMap((step) => {
          const detail = step.detail;
          const list =
            typeof detail === 'object' && detail !== null && !Array.isArray(detail)
              ? Reflect.get(detail, 'toolCalls')
              : undefined;
          return Array.isArray(list) ? list : [];
        })
        .flatMap((call: unknown) => {
          const tool = jsonField(call, 'tool');
          if (tool === null || (jsonField(call, 'free') ?? 'false') === 'true') return [];
          return [{ tool, failed: jsonField(call, 'isError') === 'true' }];
        });
      const tools = [...groupBy(calls, (call) => call.tool).entries()].map(([tool, group]) => ({
        tool,
        calls: group.length,
        failed: group.filter((call) => call.failed).length,
      }));

      return {
        failures: failures.map((row) => ({
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
          runs: settled.length,
          succeeded: settled.filter((r) => r.status === 'succeeded').length,
          failed: settled.filter((r) => r.status === 'failed').length,
          avgTokens: average(tokens),
          maxTokens: tokens.length === 0 ? null : Math.max(...tokens),
          avgTurns: average(settled.map((r) => r.attempts)),
          avgCalls: average(settled.map((r) => r.tool_calls)),
        },
        tools: page(orderBy(tools, [(t) => t.calls, 'desc'], [(t) => t.tool]), maxTools),
      };
    },
    async countCreatedSince(since) {
      return tables.select('agent_runs', (r) => r.created_at.getTime() > since.getTime()).length;
    },
    async createQueued(run) {
      tables.insert('agent_runs', newRunValues(run));
    },
    async deleteRun(runId) {
      const key = tables.param('agent_runs', 'id', runId);
      return tables.delete('agent_runs', (r) => r.id === key).length;
    },
    async logRunCreated(entry) {
      tables.insert('agent_run_log', {
        run_id: entry.runId,
        agent_id: entry.agentId,
        owner_subject: entry.ownerSubject,
        trigger_kind: entry.triggerKind,
        status: entry.status,
      });
    },
    async findInProgress(agentId) {
      const key = tables.param('agent_runs', 'agent_id', agentId);
      const rows = tables.select(
        'agent_runs',
        (r) => r.agent_id === key && (r.status === 'queued' || r.status === 'running')
      );
      const row = orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id, 'desc'])[0];
      return row ? { id: row.id, status: row.status } : null;
    },
    async findForResume(runId, agentId, ownerSubject) {
      const id = tables.param('agent_runs', 'id', runId);
      const agent = tables.param('agent_runs', 'agent_id', agentId);
      const row = tables.first(
        'agent_runs',
        (r) => r.id === id && r.agent_id === agent && r.owner_subject === ownerSubject
      );
      return row ? { status: row.status, error: row.error, errorKind: row.error_kind } : null;
    },
    async markResumed(runId, resume) {
      const id = tables.param('agent_runs', 'id', runId);
      const now = new Date();
      return (
        tables.update(
          'agent_runs',
          (r) => r.id === id && r.status === 'failed',
          (r) => ({
            status: 'queued',
            error: null,
            error_kind: null,
            started_at: null,
            finished_at: null,
            waiting_until: null,
            active_ms: 0,
            cancel_requested_at: null,
            cancel_requested_by: null,
            resumed_at: now,
            resumed_by: resume.resumedBy,
            resume_count: r.resume_count + 1,
            resume_guidance: resume.guidance,
            resume_failure: resume.failure,
            updated_at: now,
          })
        ).length > 0
      );
    },
    async restoreFailure(runId, failure) {
      const id = tables.param('agent_runs', 'id', runId);
      const now = new Date();
      tables.update('agent_runs', (r) => r.id === id && r.status === 'queued', {
        status: 'failed',
        error: failure.error,
        error_kind: failure.errorKind,
        finished_at: now,
        updated_at: now,
      });
    },
    async findRunLog(runId) {
      const id = tables.param('agent_run_log', 'run_id', runId);
      const row = tables.first('agent_run_log', (r) => r.run_id === id);
      return row ? runLogFromRow(row) : null;
    },
    async markLogQueued(runId) {
      const id = tables.param('agent_run_log', 'run_id', runId);
      tables.update('agent_run_log', (r) => r.run_id === id, {
        status: 'queued',
        finished_at: null,
      });
    },
    async recordOutcome(outcome) {
      const id = tables.param('agent_run_log', 'run_id', outcome.runId);
      const run = tables.first('agent_runs', (r) => r.id === id);
      const steps = tables.select('agent_run_steps', (r) => r.run_id === id);
      const lastFailed = outcome.failed
        ? orderBy(
            steps.filter((r) => r.status === 'failed'),
            [(r) => r.step_index, 'desc'],
            [(r) => r.iteration, 'desc'],
            [(r) => r.attempt, 'desc'],
            [(r) => r.id, 'desc']
          )[0]
        : undefined;
      const sum = (pick: (r: (typeof steps)[number]) => number) =>
        steps.reduce((total, r) => total + pick(r), 0);
      const now = new Date();
      const values = {
        run_id: outcome.runId,
        agent_id: outcome.agentId,
        owner_subject: outcome.ownerSubject,
        trigger_kind: run?.trigger_kind ?? 'manual',
        status: outcome.status,
        created_at: run?.created_at ?? now,
        finished_at: now,
        step_id: null,
        step_name: null,
        error_kind: outcome.errorKind,
        outcome_code: lastFailed?.outcome_code ? lastFailed.outcome_code.slice(0, 64) : null,
        error: outcome.error,
        input_tokens: sum((r) => r.input_tokens),
        output_tokens: sum((r) => r.output_tokens),
        tool_calls: sum((r) => r.tool_call_count),
        attempts: steps.length,
        steps_version: null,
      };
      const {
        run_id: _runId,
        agent_id: _agentId,
        owner_subject: _owner,
        trigger_kind: _kind,
        created_at: _created,
        ...update
      } = values;
      tables.upsert('agent_run_log', values, ['run_id'], update);
    },
  };
}
