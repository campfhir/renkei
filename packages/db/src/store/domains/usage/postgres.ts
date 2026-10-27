import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { emptyDay, emptyUtilizationDay, foldChatBucket } from './record';
import { bucketPattern, inSpan, localBucketOf, ownedBy, spanEnd, spanStart } from './span';
import type { OrgDay, SurfaceTokens, UsageStore, UtilizationDay } from './types';

interface ChatBucketRow {
  bucket: string;
  input_tokens: string;
  output_tokens: string;
}

/** A chat with no project is 'chat', a code project's 'code', any other project's 'chat_project'. */
// Built on use, not at import: the store barrel is imported everywhere,
// including tests that stub kysely.
const CHAT_BUCKET_CASE = () =>
  sql`
  CASE
    WHEN c.project_id IS NULL THEN 'chat'
    WHEN cp.kind = 'code' THEN 'code'
    ELSE 'chat_project'
  END
`;

const ZERO: SurfaceTokens = { input: 0, output: 0 };

function surfaceOf(rows: readonly ChatBucketRow[], bucket: string): SurfaceTokens {
  const row = rows.find((candidate) => candidate.bucket === bucket);
  return row
    ? { input: Number(row.input_tokens ?? 0), output: Number(row.output_tokens ?? 0) }
    : ZERO;
}

function sums(row: { input_tokens: string; output_tokens: string } | undefined): SurfaceTokens {
  return { input: Number(row?.input_tokens ?? 0), output: Number(row?.output_tokens ?? 0) };
}

export function postgresUsage(db: () => Kysely<DB>): UsageStore {
  return {
    async surfaceTokens(window, owner) {
      const [chatResult, agentRow, imageRow, documentRow] = await Promise.all([
        sql<ChatBucketRow>`
          SELECT
            ${CHAT_BUCKET_CASE()} AS bucket,
            COALESCE(SUM(ct.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(ct.output_tokens), 0) AS output_tokens
          FROM chat_turns ct
          JOIN chats c ON c.id = ct.chat_id
          LEFT JOIN chat_projects cp ON cp.id = c.project_id
          WHERE ${inSpan('ct.started_at', window)}
            ${ownedBy('c.owner_subject', owner)}
          GROUP BY bucket
        `.execute(db()),
        sql<{ input_tokens: string; output_tokens: string }>`
          SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM llm_calls
          WHERE agent_id IS NOT NULL
            AND ${inSpan('created_at', window)}
            ${ownedBy('subject', owner)}
        `.execute(db()),
        sql<{ input_tokens: string; output_tokens: string }>`
          SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM image_usage
          WHERE ${inSpan('created_at', window)}
            ${ownedBy('subject', owner)}
        `.execute(db()),
        sql<{ input_tokens: string; output_tokens: string }>`
          SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM document_usage
          WHERE ${inSpan('created_at', window)}
            ${ownedBy('subject', owner)}
        `.execute(db()),
      ]);
      return {
        chat: surfaceOf(chatResult.rows, 'chat'),
        chatProjects: surfaceOf(chatResult.rows, 'chat_project'),
        codeProjects: surfaceOf(chatResult.rows, 'code'),
        agents: sums(agentRow.rows[0]),
        images: sums(imageRow.rows[0]),
        documents: sums(documentRow.rows[0]),
      };
    },

    async activityTotals(window, owner) {
      let runsQuery = db()
        .selectFrom('agent_run_log')
        .select([
          sql<string>`count(*)`.as('runs'),
          sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
        ])
        .where(inSpan('created_at', window));
      if (owner !== null) runsQuery = runsQuery.where('owner_subject', '=', owner);
      let callsQuery = db()
        .selectFrom('tool_calls')
        .select([
          sql<string>`count(*)`.as('calls'),
          sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
        ])
        .where(inSpan('started_at', window));
      if (owner !== null) callsQuery = callsQuery.where('subject', '=', owner);
      const [runs, calls, active, total] = await Promise.all([
        runsQuery.executeTakeFirst(),
        callsQuery.executeTakeFirst(),
        owner === null
          ? db()
              .selectFrom('llm_calls')
              .select(sql<string>`count(DISTINCT subject)`.as('n'))
              .where(inSpan('created_at', window))
              .executeTakeFirst()
          : Promise.resolve(undefined),
        owner === null
          ? db()
              .selectFrom('identities')
              .select(sql<string>`count(DISTINCT subject)`.as('n'))
              .executeTakeFirst()
          : Promise.resolve(undefined),
      ]);
      return {
        runs: Number(runs?.runs ?? 0),
        failures: Number(runs?.failures ?? 0),
        toolCalls: Number(calls?.calls ?? 0),
        toolErrors: Number(calls?.errors ?? 0),
        activeUsers: Number(active?.n ?? 0),
        totalUsers: Number(total?.n ?? 0),
      };
    },

    async dailySeries(window, owner, granularity) {
      const { timeZone } = window;
      const pattern = bucketPattern(granularity);
      let runsQuery = db()
        .selectFrom('agent_run_log')
        .select([
          localBucketOf('created_at', timeZone, granularity).as('day'),
          sql<string>`count(*)`.as('runs'),
          sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
        ])
        .where(inSpan('created_at', window))
        .groupBy(sql`day`);
      if (owner !== null) runsQuery = runsQuery.where('owner_subject', '=', owner);
      let callsQuery = db()
        .selectFrom('tool_calls')
        .select([
          localBucketOf('started_at', timeZone, granularity).as('day'),
          sql<string>`count(*)`.as('calls'),
          sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
        ])
        .where(inSpan('started_at', window))
        .groupBy(sql`day`);
      if (owner !== null) callsQuery = callsQuery.where('subject', '=', owner);

      const [chatRows, agentRows, runRows, callRows, imageRows, documentRows] = await Promise.all([
        sql<ChatBucketRow & { day: string }>`
          SELECT
            to_char(ct.started_at AT TIME ZONE ${timeZone}, ${pattern}) AS day,
            ${CHAT_BUCKET_CASE()} AS bucket,
            COALESCE(SUM(ct.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(ct.output_tokens), 0) AS output_tokens
          FROM chat_turns ct
          JOIN chats c ON c.id = ct.chat_id
          LEFT JOIN chat_projects cp ON cp.id = c.project_id
          WHERE ${inSpan('ct.started_at', window)}
            ${ownedBy('c.owner_subject', owner)}
          GROUP BY day, bucket
        `.execute(db()),
        sql<{ day: string; input_tokens: string; output_tokens: string }>`
          SELECT to_char(created_at AT TIME ZONE ${timeZone}, ${pattern}) AS day,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM llm_calls
          WHERE agent_id IS NOT NULL
            AND ${inSpan('created_at', window)}
            ${ownedBy('subject', owner)}
          GROUP BY day
        `.execute(db()),
        runsQuery.execute(),
        callsQuery.execute(),
        sql<{
          day: string;
          images: string;
          bytes: string;
          input_tokens: string;
          output_tokens: string;
        }>`
          SELECT to_char(created_at AT TIME ZONE ${timeZone}, ${pattern}) AS day,
                 COALESCE(SUM(images), 0) AS images,
                 COALESCE(SUM(image_bytes), 0) AS bytes,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM image_usage
          WHERE ${inSpan('created_at', window)}
            ${ownedBy('subject', owner)}
          GROUP BY day
        `.execute(db()),
        sql<{ day: string; input_tokens: string; output_tokens: string }>`
          SELECT to_char(created_at AT TIME ZONE ${timeZone}, ${pattern}) AS day,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM document_usage
          WHERE ${inSpan('created_at', window)}
            ${ownedBy('subject', owner)}
          GROUP BY day
        `.execute(db()),
      ]);

      const byDay = new Map<string, OrgDay>();
      const dayOf = (day: string): OrgDay => {
        const existing = byDay.get(day);
        if (existing) return existing;
        const fresh = emptyDay(day);
        byDay.set(day, fresh);
        return fresh;
      };
      for (const row of chatRows.rows) {
        foldChatBucket(
          dayOf(row.day),
          row.bucket,
          Number(row.input_tokens ?? 0),
          Number(row.output_tokens ?? 0)
        );
      }
      for (const row of agentRows.rows) {
        const point = dayOf(row.day);
        point.agentInputTokens += Number(row.input_tokens ?? 0);
        point.agentOutputTokens += Number(row.output_tokens ?? 0);
      }
      for (const row of imageRows.rows) {
        const point = dayOf(row.day);
        point.imageInputTokens += Number(row.input_tokens ?? 0);
        point.imageOutputTokens += Number(row.output_tokens ?? 0);
        point.images += Number(row.images ?? 0);
        point.imageBytes += Number(row.bytes ?? 0);
      }
      for (const row of documentRows.rows) {
        const point = dayOf(row.day);
        point.documentInputTokens += Number(row.input_tokens ?? 0);
        point.documentOutputTokens += Number(row.output_tokens ?? 0);
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
    },

    async spendBySubject(window) {
      const [chatRows, agentRows] = await Promise.all([
        db()
          .selectFrom('chat_turns')
          .innerJoin('chats', 'chats.id', 'chat_turns.chat_id')
          .select(({ fn }) => [
            'chats.owner_subject as subject',
            fn.sum<string>('chat_turns.input_tokens').as('input_tokens'),
            fn.sum<string>('chat_turns.output_tokens').as('output_tokens'),
          ])
          .where(inSpan('chat_turns.started_at', window))
          .groupBy('chats.owner_subject')
          .execute(),
        sql<{ subject: string; input_tokens: string; output_tokens: string }>`
          SELECT subject, COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM llm_calls
          WHERE agent_id IS NOT NULL
            AND ${inSpan('created_at', window)}
          GROUP BY subject
        `.execute(db()),
      ]);
      const bySubject = new Map<string, { chatTokens: number; agentTokens: number }>();
      const entry = (subject: string) => {
        const found = bySubject.get(subject) ?? { chatTokens: 0, agentTokens: 0 };
        bySubject.set(subject, found);
        return found;
      };
      for (const row of chatRows) {
        entry(row.subject).chatTokens +=
          Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
      }
      for (const row of agentRows.rows) {
        entry(row.subject).agentTokens +=
          Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
      }
      return [...bySubject.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([subject, spend]) => ({ subject, ...spend }));
    },

    async topAgentsByTokens(window, owner, limit) {
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
        WHERE l.agent_id IS NOT NULL
          AND ${inSpan('l.created_at', window)}
          ${ownedBy('l.subject', owner)}
        GROUP BY a.id, a.name, a.enabled
        ORDER BY SUM(l.input_tokens) + SUM(l.output_tokens) DESC, a.id
        LIMIT ${limit}
      `.execute(db());
      if (rows.rows.length === 0) return [];

      const ids = rows.rows.map((row) => row.agent_id);
      let runsQuery = db()
        .selectFrom('agent_run_log')
        .select(['agent_id', sql<string>`count(*)`.as('runs')])
        .where('agent_id', 'in', ids)
        .where(inSpan('created_at', window))
        .groupBy('agent_id');
      if (owner !== null) runsQuery = runsQuery.where('owner_subject', '=', owner);
      const runRows = await runsQuery.execute();
      const runsByAgent = new Map(runRows.map((row) => [row.agent_id, Number(row.runs)]));

      return rows.rows.map((row) => ({
        agentId: row.agent_id,
        name: row.name,
        enabled: row.enabled,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        runs: runsByAgent.get(row.agent_id) ?? 0,
      }));
    },

    async succeededAgentRuns(window, owner, minSucceededRuns) {
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
        WHERE f.status = 'succeeded'
          AND ${inSpan('f.created_at', window)}
          ${ownedBy('f.owner_subject', owner)}
        GROUP BY a.id, a.name
        HAVING COUNT(*) >= ${minSucceededRuns}
        ORDER BY a.id
      `.execute(db());
      return rows.rows.map((row) => ({
        agentId: row.agent_id,
        name: row.name,
        succeededRuns: Number(row.succeeded_runs),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        toolCalls: Number(row.tool_calls ?? 0),
      }));
    },

    async topTools(window, owner, limit) {
      let query = db()
        .selectFrom('tool_calls')
        .select([
          'tool',
          'connector',
          sql<string>`count(*)`.as('calls'),
          sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
        ])
        .where(inSpan('started_at', window))
        .groupBy(['tool', 'connector'])
        .orderBy(sql`count(*)`, 'desc')
        .orderBy('tool')
        .orderBy('connector')
        .limit(limit);
      if (owner !== null) query = query.where('subject', '=', owner);
      const rows = await query.execute();
      return rows.map((row) => ({
        tool: row.tool,
        connector: row.connector,
        calls: Number(row.calls),
        errors: Number(row.errors),
      }));
    },

    async tokensByModel(window, owner, limit) {
      const rows = await sql<{
        provider: string | null;
        model: string | null;
        input_tokens: string;
        output_tokens: string;
        cached_input_tokens: string;
        calls: string;
      }>`
        SELECT provider, model,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_read_input_tokens), 0) AS cached_input_tokens,
               COUNT(*) AS calls
        FROM llm_calls
        WHERE ${inSpan('created_at', window)}
          ${ownedBy('subject', owner)}
        GROUP BY provider, model
        ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC, provider, model
        LIMIT ${limit}
      `.execute(db());
      return rows.rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cachedInputTokens: Number(row.cached_input_tokens ?? 0),
        calls: Number(row.calls ?? 0),
      }));
    },

    async voiceByKind(window, owner) {
      const result = await sql<{
        kind: string;
        calls: string;
        characters: string;
        audio_ms: string;
      }>`
        SELECT kind, COUNT(*) AS calls,
               COALESCE(SUM(characters), 0) AS characters,
               COALESCE(SUM(audio_ms), 0) AS audio_ms
        FROM voice_usage
        WHERE ${inSpan('created_at', window)}
          ${ownedBy('subject', owner)}
        GROUP BY kind
        ORDER BY kind
      `.execute(db());
      return result.rows.map((row) => ({
        kind: row.kind,
        calls: Number(row.calls),
        characters: Number(row.characters),
        audioMs: Number(row.audio_ms),
      }));
    },

    async voiceBySubject(window) {
      const result = await sql<{
        subject: string;
        kind: string;
        calls: string;
        characters: string;
        audio_ms: string;
      }>`
        SELECT subject, kind, COUNT(*) AS calls,
               COALESCE(SUM(characters), 0) AS characters,
               COALESCE(SUM(audio_ms), 0) AS audio_ms
        FROM voice_usage
        WHERE ${inSpan('created_at', window)}
        GROUP BY subject, kind
        ORDER BY subject, kind
      `.execute(db());
      return result.rows.map((row) => ({
        subject: row.subject,
        kind: row.kind,
        calls: Number(row.calls),
        characters: Number(row.characters),
        audioMs: Number(row.audio_ms),
      }));
    },

    async imageTotals(window, owner) {
      const result = await sql<{
        images: string;
        bytes: string;
        input_tokens: string;
        output_tokens: string;
      }>`
        SELECT COALESCE(SUM(images), 0) AS images,
               COALESCE(SUM(image_bytes), 0) AS bytes,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM image_usage
        WHERE ${inSpan('created_at', window)}
          ${ownedBy('subject', owner)}
      `.execute(db());
      const row = result.rows[0];
      return {
        images: Number(row?.images ?? 0),
        bytes: Number(row?.bytes ?? 0),
        inputTokens: Number(row?.input_tokens ?? 0),
        outputTokens: Number(row?.output_tokens ?? 0),
      };
    },

    async imageBySubject(window) {
      const result = await sql<{
        subject: string;
        images: string;
        bytes: string;
        input_tokens: string;
        output_tokens: string;
      }>`
        SELECT subject,
               COALESCE(SUM(images), 0) AS images,
               COALESCE(SUM(image_bytes), 0) AS bytes,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM image_usage
        WHERE ${inSpan('created_at', window)}
        GROUP BY subject
        ORDER BY subject
      `.execute(db());
      return result.rows.map((row) => ({
        subject: row.subject,
        images: Number(row.images),
        bytes: Number(row.bytes),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
      }));
    },

    async documentByKind(window, owner) {
      const result = await sql<{
        kind: string;
        count: string;
        pages: string;
        input_tokens: string;
        output_tokens: string;
      }>`
        SELECT kind,
               COUNT(*) AS count,
               COALESCE(SUM(pages), 0) AS pages,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM document_usage
        WHERE ${inSpan('created_at', window)}
          ${ownedBy('subject', owner)}
        GROUP BY kind
        ORDER BY kind
      `.execute(db());
      return result.rows.map((row) => ({
        kind: row.kind,
        count: Number(row.count),
        pages: Number(row.pages),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
      }));
    },

    async recordDocument(usage) {
      await db()
        .insertInto('document_usage')
        .values({
          subject: usage.subject,
          artifact_id: usage.artifactId,
          kind: usage.kind,
          pages: usage.pages,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
        })
        .execute();
    },

    async personTotals(subject, window) {
      const [tokens, runs, calls] = await Promise.all([
        db()
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
          .where('subject', '=', subject)
          .where(inSpan('created_at', window))
          .executeTakeFirst(),
        db()
          .selectFrom('agent_run_log')
          .select([
            sql<string>`count(*)`.as('runs'),
            sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
          ])
          .where('owner_subject', '=', subject)
          .where(inSpan('created_at', window))
          .executeTakeFirst(),
        db()
          .selectFrom('tool_calls')
          .select([
            sql<string>`count(*)`.as('calls'),
            sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
          ])
          .where('subject', '=', subject)
          .where(inSpan('started_at', window))
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
    },

    async personSeries(subject, window, granularity) {
      const { timeZone } = window;
      const [tokenRows, runRows, callRows] = await Promise.all([
        db()
          .selectFrom('llm_calls')
          .select(({ fn }) => [
            localBucketOf('created_at', timeZone, granularity).as('day'),
            fn.sum<string>('input_tokens').as('input_tokens'),
            fn.sum<string>('output_tokens').as('output_tokens'),
          ])
          .where('subject', '=', subject)
          .where(inSpan('created_at', window))
          .groupBy(sql`day`)
          .execute(),
        db()
          .selectFrom('agent_run_log')
          .select([
            localBucketOf('created_at', timeZone, granularity).as('day'),
            sql<string>`count(*)`.as('runs'),
            sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
          ])
          .where('owner_subject', '=', subject)
          .where(inSpan('created_at', window))
          .groupBy(sql`day`)
          .execute(),
        db()
          .selectFrom('tool_calls')
          .select([
            localBucketOf('started_at', timeZone, granularity).as('day'),
            sql<string>`count(*)`.as('calls'),
            sql<string>`count(*) FILTER (WHERE status <> 'ok')`.as('errors'),
          ])
          .where('subject', '=', subject)
          .where(inSpan('started_at', window))
          .groupBy(sql`day`)
          .execute(),
      ]);
      const byDay = new Map<string, UtilizationDay>();
      const dayOf = (day: string): UtilizationDay => {
        const existing = byDay.get(day);
        if (existing) return existing;
        const fresh = emptyUtilizationDay(day);
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
    },

    async personAgents(subject, window) {
      const agents = await db()
        .selectFrom('agents')
        .select(['id', 'name', 'enabled'])
        .where('owner_subject', '=', subject)
        .orderBy('name')
        .orderBy('id')
        .execute();
      if (agents.length === 0) return [];
      const ids = agents.map((agent) => agent.id);
      const since = spanStart(window);
      const end = spanEnd(window);

      const [runRows, tokenRows, callRows, failureRows] = await Promise.all([
        db()
          .selectFrom('agent_run_log')
          .select([
            'agent_id',
            sql<string>`count(*)`.as('runs'),
            sql<string>`count(*) FILTER (WHERE status = 'failed')`.as('failures'),
          ])
          .where('owner_subject', '=', subject)
          .where('agent_id', 'in', ids)
          .where(inSpan('created_at', window))
          .groupBy('agent_id')
          .execute(),
        db()
          .selectFrom('llm_calls')
          .select(({ fn }) => [
            'agent_id',
            fn.sum<string>('input_tokens').as('input_tokens'),
            fn.sum<string>('output_tokens').as('output_tokens'),
          ])
          .where('subject', '=', subject)
          .where('agent_id', 'in', ids)
          .where(inSpan('created_at', window))
          .groupBy('agent_id')
          .execute(),
        db()
          .selectFrom('tool_calls')
          .select(['agent_id', sql<string>`count(*)`.as('calls')])
          .where('subject', '=', subject)
          .where('agent_id', 'in', ids)
          .where(inSpan('started_at', window))
          .groupBy('agent_id')
          .execute(),
        // The newest failure per agent (ties by run id, newest last-written first).
        sql<{
          agent_id: string;
          created_at: Date;
          step_name: string | null;
          error_kind: string | null;
        }>`
          SELECT DISTINCT ON (agent_id) agent_id, created_at, step_name, error_kind
          FROM agent_run_log
          WHERE owner_subject = ${subject}
            AND agent_id IN (${sql.join(ids)})
            AND status = 'failed'
            AND created_at >= ${since}
            ${end === null ? sql`` : sql`AND created_at < ${end}`}
          ORDER BY agent_id, created_at DESC, run_id DESC
        `.execute(db()),
      ]);
      const runs = new Map(runRows.map((row) => [row.agent_id, row]));
      const tokens = new Map(tokenRows.map((row) => [row.agent_id, row]));
      const calls = new Map(callRows.map((row) => [row.agent_id, row]));
      const failures = new Map(failureRows.rows.map((row) => [row.agent_id, row]));

      return agents.map((agent) => {
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
          lastFailureAt: failure ? new Date(failure.created_at).toISOString() : null,
          lastFailureStep: failure?.step_name ?? null,
          lastFailureKind: failure?.error_kind ?? null,
        };
      });
    },

    async failureSignatures(subject, window, limit) {
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
          (ARRAY_AGG(f.error ORDER BY f.created_at DESC, f.run_id DESC))[1] AS last_error
        FROM agent_run_log f
        JOIN agents a ON a.id = f.agent_id
        WHERE f.owner_subject = ${subject}
          AND f.status = 'failed'
          AND a.enabled
          AND ${inSpan('f.created_at', window)}
        GROUP BY f.agent_id, a.name, f.step_name, f.error_kind, f.outcome_code
        ORDER BY count DESC, last_at DESC, f.agent_id, f.step_name, f.error_kind, f.outcome_code
        LIMIT ${limit}
      `.execute(db());
      return rows.rows.map((row) => ({
        agentId: row.agent_id,
        agentName: row.agent_name,
        stepName: row.step_name,
        errorKind: row.error_kind,
        outcomeCode: row.outcome_code,
        count: Number(row.count),
        lastAt: new Date(row.last_at).toISOString(),
        lastError: row.last_error,
      }));
    },
  };
}
