import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { bucketSql, inWindowSql } from './window';
import type { ToolCallFilter, ToolUsageStore } from './types';

const CALLS = sql<string>`count(*)`;
const ERRORS = sql<string>`count(*) FILTER (WHERE tool_calls.status <> 'ok')`;
const MEDIAN = sql<
  string | null
>`percentile_disc(0.5) WITHIN GROUP (ORDER BY tool_calls.duration_ms)`;
const P95 = sql<
  string | null
>`percentile_disc(0.95) WITHIN GROUP (ORDER BY tool_calls.duration_ms)`;

const numberOrNull = (value: string | number | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

export function postgresToolUsage(db: () => Kysely<DB>): ToolUsageStore {
  /** tool_calls narrowed by the filter; an empty agent list reaches nothing. */
  const calls = (filter: ToolCallFilter) => {
    let query = db()
      .selectFrom('tool_calls')
      .where(inWindowSql('tool_calls.started_at', filter.window));
    if (filter.subject !== undefined && filter.subject !== null) {
      query = query.where('tool_calls.subject', '=', filter.subject);
    }
    if (filter.tool !== undefined) query = query.where('tool_calls.tool', '=', filter.tool);
    if (filter.agentIds !== undefined) {
      query =
        filter.agentIds.length > 0
          ? query.where('tool_calls.agent_id', 'in', filter.agentIds)
          : query.where(sql<boolean>`false`);
    }
    return query;
  };

  return {
    async byTool(filter, { latency, limit }) {
      let query = calls(filter)
        .select([
          'tool_calls.tool as tool',
          'tool_calls.connector as connector',
          CALLS.as('calls'),
          ERRORS.as('errors'),
        ])
        .$if(latency, (q) => q.select([MEDIAN.as('median_ms'), P95.as('p95_ms')]))
        .groupBy(['tool_calls.tool', 'tool_calls.connector'])
        .orderBy(CALLS, 'desc')
        .orderBy('tool_calls.tool')
        .orderBy('tool_calls.connector');
      if (limit !== undefined) query = query.limit(limit);
      const rows = await query.execute();
      return rows.map((row) => ({
        tool: row.tool,
        connector: row.connector,
        calls: Number(row.calls),
        errors: Number(row.errors),
        medianMs: latency ? numberOrNull(row.median_ms) : null,
        p95Ms: latency ? numberOrNull(row.p95_ms) : null,
      }));
    },
    async totals(filter, { latency }) {
      const row = await calls(filter)
        .select([CALLS.as('calls'), ERRORS.as('errors')])
        .$if(latency, (q) => q.select([MEDIAN.as('median_ms'), P95.as('p95_ms')]))
        .executeTakeFirst();
      return {
        calls: Number(row?.calls ?? 0),
        errors: Number(row?.errors ?? 0),
        medianMs: latency ? numberOrNull(row?.median_ms) : null,
        p95Ms: latency ? numberOrNull(row?.p95_ms) : null,
      };
    },
    async series(filter, bucketing) {
      const rows = await calls(filter)
        .select([
          bucketSql('tool_calls.started_at', bucketing).as('bucket'),
          CALLS.as('calls'),
          ERRORS.as('errors'),
        ])
        .groupBy(sql`bucket`)
        .orderBy(sql`bucket`, 'asc')
        .execute();
      return rows.map((row) => ({
        bucket: row.bucket,
        calls: Number(row.calls),
        errors: Number(row.errors),
      }));
    },
    async byPerson(filter, limit) {
      const rows = await calls(filter)
        .leftJoin('identities', 'identities.subject', 'tool_calls.subject')
        .select([
          'tool_calls.subject as subject',
          sql<string | null>`max(identities.display_name)`.as('display_name'),
          sql<string | null>`max(identities.email)`.as('email'),
          CALLS.as('calls'),
          ERRORS.as('errors'),
        ])
        .groupBy('tool_calls.subject')
        .orderBy(CALLS, 'desc')
        .orderBy('tool_calls.subject')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        subject: row.subject,
        displayName: row.display_name,
        email: row.email,
        calls: Number(row.calls),
        errors: Number(row.errors),
      }));
    },
    async byAgent(filter) {
      const rows = await calls(filter)
        .select(['tool_calls.agent_id as agent_id', CALLS.as('calls')])
        .where('tool_calls.agent_id', 'is not', null)
        .groupBy('tool_calls.agent_id')
        .orderBy('tool_calls.agent_id')
        .execute();
      return rows.flatMap((row) =>
        row.agent_id ? [{ agentId: row.agent_id, calls: Number(row.calls) }] : []
      );
    },
    async recentFailures(filter, limit) {
      const rows = await calls(filter)
        .leftJoin('identities', 'identities.subject', 'tool_calls.subject')
        .select([
          'tool_calls.started_at as started_at',
          'tool_calls.duration_ms as duration_ms',
          'tool_calls.subject as subject',
          'tool_calls.error_summary as error_summary',
          'identities.display_name as display_name',
          'identities.email as email',
        ])
        .where('tool_calls.status', '<>', 'ok')
        .orderBy('tool_calls.started_at', 'desc')
        .orderBy('tool_calls.id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        startedAt: new Date(row.started_at),
        durationMs: Number(row.duration_ms),
        subject: row.subject,
        errorSummary: row.error_summary,
        displayName: row.display_name,
        email: row.email,
      }));
    },
  };
}
