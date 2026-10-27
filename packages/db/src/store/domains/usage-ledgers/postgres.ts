import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { ChatSurface, LedgerFilter, UsageLedgerStore } from './types';
import { bucketSql, inWindowSql } from './window';

const n = (value: string | number | bigint | null | undefined) => Number(value ?? 0);

const COUNT = sql<string>`count(*)`;
const sumOf = (column: string) => sql<string>`COALESCE(SUM(${sql.ref(column)}), 0)`;
const RUN_FAILURES = sql<string>`count(*) FILTER (WHERE agent_run_log.status = 'failed')`;

const CHAT_SURFACE = sql<ChatSurface>`CASE
    WHEN c.project_id IS NULL THEN 'chat'
    WHEN cp.kind = 'code' THEN 'code'
    ELSE 'chat_project'
  END`;

const isScoped = (filter: LedgerFilter): filter is LedgerFilter & { subject: string } =>
  filter.subject !== undefined && filter.subject !== null;

/** `where x in (…)` with an empty list is a syntax error in Postgres; it reaches nothing anyway. */
const noneOf = (ids: string[]) => ids.length === 0;

export function postgresUsageLedgers(db: () => Kysely<DB>): UsageLedgerStore {
  const llm = (filter: LedgerFilter & { agentsOnly?: boolean }) => {
    let query = db()
      .selectFrom('llm_calls')
      .where(inWindowSql('llm_calls.created_at', filter.window));
    if (isScoped(filter)) query = query.where('llm_calls.subject', '=', filter.subject);
    if (filter.agentsOnly) query = query.where('llm_calls.agent_id', 'is not', null);
    return query;
  };
  const runs = (filter: LedgerFilter) => {
    let query = db()
      .selectFrom('agent_run_log')
      .where(inWindowSql('agent_run_log.created_at', filter.window));
    if (isScoped(filter)) query = query.where('agent_run_log.owner_subject', '=', filter.subject);
    return query;
  };
  const turns = (filter: LedgerFilter) => {
    let query = db()
      .selectFrom('chat_turns as ct')
      .innerJoin('chats as c', 'c.id', 'ct.chat_id')
      .leftJoin('chat_projects as cp', 'cp.id', 'c.project_id')
      .where(inWindowSql('ct.started_at', filter.window));
    if (isScoped(filter)) query = query.where('c.owner_subject', '=', filter.subject);
    return query;
  };
  const images = (filter: LedgerFilter) => {
    let query = db()
      .selectFrom('image_usage')
      .where(inWindowSql('image_usage.created_at', filter.window));
    if (isScoped(filter)) query = query.where('image_usage.subject', '=', filter.subject);
    return query;
  };
  const voice = (filter: LedgerFilter) => {
    let query = db()
      .selectFrom('voice_usage')
      .where(inWindowSql('voice_usage.created_at', filter.window));
    if (isScoped(filter)) query = query.where('voice_usage.subject', '=', filter.subject);
    return query;
  };
  const documents = (filter: LedgerFilter) => {
    let query = db()
      .selectFrom('document_usage')
      .where(inWindowSql('document_usage.created_at', filter.window));
    if (isScoped(filter)) query = query.where('document_usage.subject', '=', filter.subject);
    return query;
  };
  const tokenSums = (row: { input_tokens: string | null; output_tokens: string | null }) => ({
    inputTokens: n(row.input_tokens),
    outputTokens: n(row.output_tokens),
  });
  const imageSums = (row: {
    images: string;
    bytes: string;
    input_tokens: string;
    output_tokens: string;
  }) => ({ images: n(row.images), bytes: n(row.bytes), ...tokenSums(row) });
  const imageColumns = [
    sumOf('image_usage.images').as('images'),
    sumOf('image_usage.image_bytes').as('bytes'),
    sumOf('image_usage.input_tokens').as('input_tokens'),
    sumOf('image_usage.output_tokens').as('output_tokens'),
  ];

  return {
    async llmTotals(filter) {
      const row = await llm(filter)
        .select([
          sumOf('llm_calls.input_tokens').as('input_tokens'),
          sumOf('llm_calls.output_tokens').as('output_tokens'),
          sql<string>`COALESCE(SUM(input_tokens) FILTER (WHERE purpose = 'chat'), 0)`.as(
            'chat_input_tokens'
          ),
          sql<string>`COALESCE(SUM(output_tokens) FILTER (WHERE purpose = 'chat'), 0)`.as(
            'chat_output_tokens'
          ),
        ])
        .executeTakeFirst();
      return {
        inputTokens: n(row?.input_tokens),
        outputTokens: n(row?.output_tokens),
        chatInputTokens: n(row?.chat_input_tokens),
        chatOutputTokens: n(row?.chat_output_tokens),
      };
    },
    async llmSeries(filter, bucketing) {
      const rows = await llm(filter)
        .select([
          bucketSql('llm_calls.created_at', bucketing).as('bucket'),
          sumOf('llm_calls.input_tokens').as('input_tokens'),
          sumOf('llm_calls.output_tokens').as('output_tokens'),
        ])
        .groupBy(sql`bucket`)
        .orderBy(sql`bucket`)
        .execute();
      return rows.map((row) => ({ bucket: row.bucket, ...tokenSums(row) }));
    },
    async llmByAgent(filter) {
      if (noneOf(filter.agentIds)) return [];
      const rows = await llm(filter)
        .select([
          'llm_calls.agent_id as agent_id',
          sumOf('llm_calls.input_tokens').as('input_tokens'),
          sumOf('llm_calls.output_tokens').as('output_tokens'),
        ])
        .where('llm_calls.agent_id', 'in', filter.agentIds)
        .groupBy('llm_calls.agent_id')
        .orderBy('llm_calls.agent_id')
        .execute();
      return rows.flatMap((row) =>
        row.agent_id ? [{ agentId: row.agent_id, ...tokenSums(row) }] : []
      );
    },
    async agentLlmBySubject(filter) {
      const rows = await llm({ ...filter, agentsOnly: true })
        .select([
          'llm_calls.subject as subject',
          sumOf('llm_calls.input_tokens').as('input_tokens'),
          sumOf('llm_calls.output_tokens').as('output_tokens'),
        ])
        .groupBy('llm_calls.subject')
        .orderBy('llm_calls.subject')
        .execute();
      return rows.map((row) => ({ subject: row.subject, ...tokenSums(row) }));
    },
    async topAgentsByTokens(filter, limit) {
      const rows = await llm({ ...filter, agentsOnly: true })
        .innerJoin('agents as a', 'a.id', 'llm_calls.agent_id')
        .select([
          'a.id as agent_id',
          'a.name as name',
          'a.enabled as enabled',
          sumOf('llm_calls.input_tokens').as('input_tokens'),
          sumOf('llm_calls.output_tokens').as('output_tokens'),
        ])
        .groupBy(['a.id', 'a.name', 'a.enabled'])
        .orderBy(sql`SUM(llm_calls.input_tokens) + SUM(llm_calls.output_tokens)`, 'desc')
        .orderBy('a.id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        agentId: row.agent_id,
        name: row.name,
        enabled: row.enabled,
        ...tokenSums(row),
      }));
    },
    async tokensByModel(filter, limit) {
      const rows = await llm(filter)
        .select([
          'llm_calls.provider as provider',
          'llm_calls.model as model',
          sumOf('llm_calls.input_tokens').as('input_tokens'),
          sumOf('llm_calls.output_tokens').as('output_tokens'),
          sumOf('llm_calls.cache_read_input_tokens').as('cached_input_tokens'),
          COUNT.as('calls'),
        ])
        .groupBy(['llm_calls.provider', 'llm_calls.model'])
        .orderBy(sql`SUM(llm_calls.input_tokens) + SUM(llm_calls.output_tokens)`, 'desc')
        .orderBy('llm_calls.provider')
        .orderBy('llm_calls.model')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        ...tokenSums(row),
        cachedInputTokens: n(row.cached_input_tokens),
        calls: n(row.calls),
      }));
    },
    async countActiveSubjects(window) {
      const row = await llm({ window })
        .select(sql<string>`count(DISTINCT llm_calls.subject)`.as('n'))
        .executeTakeFirst();
      return n(row?.n);
    },

    async runTotals(filter) {
      const row = await runs(filter)
        .select([COUNT.as('runs'), RUN_FAILURES.as('failures')])
        .executeTakeFirst();
      return { runs: n(row?.runs), failures: n(row?.failures) };
    },
    async runSeries(filter, bucketing) {
      const rows = await runs(filter)
        .select([
          bucketSql('agent_run_log.created_at', bucketing).as('bucket'),
          COUNT.as('runs'),
          RUN_FAILURES.as('failures'),
        ])
        .groupBy(sql`bucket`)
        .orderBy(sql`bucket`)
        .execute();
      return rows.map((row) => ({
        bucket: row.bucket,
        runs: n(row.runs),
        failures: n(row.failures),
      }));
    },
    async runsByAgent(filter) {
      if (noneOf(filter.agentIds)) return [];
      const rows = await runs(filter)
        .select([
          'agent_run_log.agent_id as agent_id',
          COUNT.as('runs'),
          RUN_FAILURES.as('failures'),
        ])
        .where('agent_run_log.agent_id', 'in', filter.agentIds)
        .groupBy('agent_run_log.agent_id')
        .orderBy('agent_run_log.agent_id')
        .execute();
      return rows.map((row) => ({
        agentId: row.agent_id,
        runs: n(row.runs),
        failures: n(row.failures),
      }));
    },
    async lastFailureByAgent(filter) {
      if (noneOf(filter.agentIds)) return [];
      // The newest failure per agent — DISTINCT ON walks the (agent,
      // created_at) index once.
      const rows = await runs(filter)
        .distinctOn('agent_run_log.agent_id')
        .select([
          'agent_run_log.agent_id as agent_id',
          'agent_run_log.created_at as created_at',
          'agent_run_log.step_name as step_name',
          'agent_run_log.error_kind as error_kind',
        ])
        .where('agent_run_log.agent_id', 'in', filter.agentIds)
        .where('agent_run_log.status', '=', 'failed')
        .orderBy('agent_run_log.agent_id')
        .orderBy('agent_run_log.created_at', 'desc')
        .orderBy('agent_run_log.run_id')
        .execute();
      return rows.map((row) => ({
        agentId: row.agent_id,
        at: new Date(row.created_at),
        stepName: row.step_name,
        errorKind: row.error_kind,
      }));
    },
    async failureSignatures(filter, limit) {
      const subjectClause = isScoped(filter) ? sql`AND f.owner_subject = ${filter.subject}` : sql``;
      const result = await sql<{
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
          (ARRAY_AGG(f.error ORDER BY f.created_at DESC, f.run_id))[1] AS last_error
        FROM agent_run_log f
        JOIN agents a ON a.id = f.agent_id
        WHERE f.status = 'failed'
          AND a.enabled
          AND ${inWindowSql('f.created_at', filter.window)}
          ${subjectClause}
        GROUP BY f.agent_id, a.name, f.step_name, f.error_kind, f.outcome_code
        ORDER BY count DESC, last_at DESC, f.agent_id, f.step_name, f.error_kind, f.outcome_code
        LIMIT ${limit}
      `.execute(db());
      return result.rows.map((row) => ({
        agentId: row.agent_id,
        agentName: row.agent_name,
        stepName: row.step_name,
        errorKind: row.error_kind,
        outcomeCode: row.outcome_code,
        count: n(row.count),
        lastAt: new Date(row.last_at),
        lastError: row.last_error,
      }));
    },
    async succeededRunStats(filter, minRuns) {
      const rows = await runs(filter)
        .innerJoin('agents as a', 'a.id', 'agent_run_log.agent_id')
        .select([
          'a.id as agent_id',
          'a.name as name',
          COUNT.as('runs'),
          sumOf('agent_run_log.input_tokens').as('input_tokens'),
          sumOf('agent_run_log.output_tokens').as('output_tokens'),
          sumOf('agent_run_log.tool_calls').as('tool_calls'),
        ])
        .where('agent_run_log.status', '=', 'succeeded')
        .groupBy(['a.id', 'a.name'])
        .having(sql`COUNT(*)`, '>=', minRuns)
        .orderBy('a.id')
        .execute();
      return rows.map((row) => ({
        agentId: row.agent_id,
        name: row.name,
        runs: n(row.runs),
        toolCalls: n(row.tool_calls),
        ...tokenSums(row),
      }));
    },

    async chatTokensBySurface(filter) {
      const rows = await turns(filter)
        .select([
          CHAT_SURFACE.as('surface'),
          sumOf('ct.input_tokens').as('input_tokens'),
          sumOf('ct.output_tokens').as('output_tokens'),
        ])
        .groupBy(sql`surface`)
        .orderBy(sql`surface`)
        .execute();
      return rows.map((row) => ({ surface: row.surface, ...tokenSums(row) }));
    },
    async chatSeriesBySurface(filter, bucketing) {
      const rows = await turns(filter)
        .select([
          bucketSql('ct.started_at', bucketing).as('bucket'),
          CHAT_SURFACE.as('surface'),
          sumOf('ct.input_tokens').as('input_tokens'),
          sumOf('ct.output_tokens').as('output_tokens'),
        ])
        .groupBy([sql`bucket`, sql`surface`])
        .orderBy(sql`bucket`)
        .orderBy(sql`surface`)
        .execute();
      return rows.map((row) => ({ bucket: row.bucket, surface: row.surface, ...tokenSums(row) }));
    },
    async chatTokensBySubject(filter) {
      const rows = await turns(filter)
        .select([
          'c.owner_subject as subject',
          sumOf('ct.input_tokens').as('input_tokens'),
          sumOf('ct.output_tokens').as('output_tokens'),
        ])
        .groupBy('c.owner_subject')
        .orderBy('c.owner_subject')
        .execute();
      return rows.map((row) => ({ subject: row.subject, ...tokenSums(row) }));
    },

    async imageTotals(filter) {
      const row = await images(filter).select(imageColumns).executeTakeFirst();
      return row ? imageSums(row) : { images: 0, bytes: 0, inputTokens: 0, outputTokens: 0 };
    },
    async imageSeries(filter, bucketing) {
      const rows = await images(filter)
        .select([bucketSql('image_usage.created_at', bucketing).as('bucket'), ...imageColumns])
        .groupBy(sql`bucket`)
        .orderBy(sql`bucket`)
        .execute();
      return rows.map((row) => ({ bucket: row.bucket, ...imageSums(row) }));
    },
    async imageBySubject(filter) {
      const rows = await images(filter)
        .select(['image_usage.subject as subject', ...imageColumns])
        .groupBy('image_usage.subject')
        .orderBy('image_usage.subject')
        .execute();
      return rows.map((row) => ({ subject: row.subject, ...imageSums(row) }));
    },

    async voiceByKind(filter) {
      const rows = await voice(filter)
        .select([
          'voice_usage.kind as kind',
          COUNT.as('calls'),
          sumOf('voice_usage.characters').as('characters'),
          sumOf('voice_usage.audio_ms').as('audio_ms'),
        ])
        .groupBy('voice_usage.kind')
        .orderBy('voice_usage.kind')
        .execute();
      return rows.map((row) => ({
        kind: row.kind,
        calls: n(row.calls),
        characters: n(row.characters),
        audioMs: n(row.audio_ms),
      }));
    },
    async voiceBySubjectKind(filter) {
      const rows = await voice(filter)
        .select([
          'voice_usage.subject as subject',
          'voice_usage.kind as kind',
          COUNT.as('calls'),
          sumOf('voice_usage.characters').as('characters'),
          sumOf('voice_usage.audio_ms').as('audio_ms'),
        ])
        .groupBy(['voice_usage.subject', 'voice_usage.kind'])
        .orderBy('voice_usage.subject')
        .orderBy('voice_usage.kind')
        .execute();
      return rows.map((row) => ({
        subject: row.subject,
        kind: row.kind,
        calls: n(row.calls),
        characters: n(row.characters),
        audioMs: n(row.audio_ms),
      }));
    },

    async documentByKind(filter) {
      const rows = await documents(filter)
        .select([
          'document_usage.kind as kind',
          COUNT.as('count'),
          sumOf('document_usage.pages').as('pages'),
          sumOf('document_usage.input_tokens').as('input_tokens'),
          sumOf('document_usage.output_tokens').as('output_tokens'),
        ])
        .groupBy('document_usage.kind')
        .orderBy('document_usage.kind')
        .execute();
      return rows.map((row) => ({
        kind: row.kind,
        count: n(row.count),
        pages: n(row.pages),
        ...tokenSums(row),
      }));
    },
    async documentSeries(filter, bucketing) {
      const rows = await documents(filter)
        .select([
          bucketSql('document_usage.created_at', bucketing).as('bucket'),
          sumOf('document_usage.input_tokens').as('input_tokens'),
          sumOf('document_usage.output_tokens').as('output_tokens'),
        ])
        .groupBy(sql`bucket`)
        .orderBy(sql`bucket`)
        .execute();
      return rows.map((row) => ({ bucket: row.bucket, ...tokenSums(row) }));
    },
    async insertDocumentUsage(input) {
      await db()
        .insertInto('document_usage')
        .values({
          subject: input.subject,
          artifact_id: input.artifactId,
          kind: input.kind,
          pages: input.pages,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
        })
        .execute();
    },

    async ownedAgents(subject) {
      return db()
        .selectFrom('agents')
        .select(['id', 'name', 'enabled'])
        .where('owner_subject', '=', subject)
        .orderBy('name')
        .orderBy('id')
        .execute();
    },
    async countPeople() {
      const row = await db()
        .selectFrom('identities')
        .select(sql<string>`count(DISTINCT subject)`.as('n'))
        .executeTakeFirst();
      return n(row?.n);
    },
  };
}
