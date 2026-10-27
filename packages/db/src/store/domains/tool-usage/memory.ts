import { groupBy, orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { bucketOf, inWindow, percentileDisc } from '../usage-ledgers/window';
import type { ToolCallFilter, ToolUsageStore } from './types';

type Call = Row<'tool_calls'>;

const errorsOf = (rows: Call[]) => rows.filter((r) => r.status !== 'ok').length;

function latencyOf(rows: Call[], latency: boolean) {
  if (!latency) return { medianMs: null, p95Ms: null };
  const durations = rows.map((r) => r.duration_ms);
  return { medianMs: percentileDisc(durations, 0.5), p95Ms: percentileDisc(durations, 0.95) };
}

export function memoryToolUsage(tables: MemoryTables): ToolUsageStore {
  const calls = (filter: ToolCallFilter): Call[] => {
    const agents = filter.agentIds
      ? new Set(filter.agentIds.map((id) => tables.param('tool_calls', 'agent_id', id)))
      : null;
    return tables.select(
      'tool_calls',
      (r) =>
        inWindow(r.started_at, filter.window) &&
        (filter.subject === undefined || filter.subject === null || r.subject === filter.subject) &&
        (filter.tool === undefined || r.tool === filter.tool) &&
        (agents === null || (r.agent_id !== null && agents.has(r.agent_id)))
    );
  };
  const identity = (subject: string | null) =>
    subject === null ? undefined : tables.first('identities', (i) => i.subject === subject);

  return {
    async byTool(filter, { latency, limit }) {
      const groups = [
        ...groupBy(calls(filter), (r) => `${r.tool}\u0000${r.connector ?? '\u0001'}`).values(),
      ];
      const rows = groups.map((group) => ({
        tool: group[0].tool,
        connector: group[0].connector,
        calls: group.length,
        errors: errorsOf(group),
        ...latencyOf(group, latency),
      }));
      return page(
        orderBy(rows, [(r) => r.calls, 'desc'], [(r) => r.tool], [(r) => r.connector]),
        limit
      );
    },
    async totals(filter, { latency }) {
      const rows = calls(filter);
      return { calls: rows.length, errors: errorsOf(rows), ...latencyOf(rows, latency) };
    },
    async series(filter, bucketing) {
      const groups = groupBy(calls(filter), (r) => bucketOf(r.started_at, bucketing));
      return orderBy(
        [...groups].map(([bucket, group]) => ({
          bucket,
          calls: group.length,
          errors: errorsOf(group),
        })),
        [(r) => r.bucket]
      );
    },
    async byPerson(filter, limit) {
      const groups = groupBy(calls(filter), (r) => r.subject);
      const rows = [...groups].map(([subject, group]) => {
        const person = identity(subject);
        return {
          subject,
          displayName: person?.display_name ?? null,
          email: person?.email ?? null,
          calls: group.length,
          errors: errorsOf(group),
        };
      });
      return page(orderBy(rows, [(r) => r.calls, 'desc'], [(r) => r.subject]), limit);
    },
    async byAgent(filter) {
      const groups = groupBy(
        calls(filter).filter((r) => r.agent_id !== null),
        (r) => r.agent_id ?? ''
      );
      return orderBy(
        [...groups].map(([agentId, group]) => ({ agentId, calls: group.length })),
        [(r) => r.agentId]
      );
    },
    async recentFailures(filter, limit) {
      const rows = calls(filter).filter((r) => r.status !== 'ok');
      return page(orderBy(rows, [(r) => r.started_at, 'desc'], [(r) => r.id]), limit).map((r) => {
        const person = identity(r.subject);
        return {
          startedAt: r.started_at,
          durationMs: r.duration_ms,
          subject: r.subject,
          errorSummary: r.error_summary,
          displayName: person?.display_name ?? null,
          email: person?.email ?? null,
        };
      });
    },
  };
}
