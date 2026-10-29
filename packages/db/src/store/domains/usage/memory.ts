import { groupBy, orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { emptyDay, emptyUtilizationDay, foldChatBucket } from './record';
import type {
  OrgDay,
  SurfaceTokens,
  UsageGranularity,
  UsageStore,
  UsageWindow,
  UtilizationDay,
} from './types';
import { bucketKey, inWindow } from './zone';

const sum = <T>(rows: readonly T[], value: (row: T) => number | string | null) =>
  rows.reduce((total, row) => total + Number(value(row) ?? 0), 0);

const tokens = <T extends { input_tokens: number; output_tokens: number }>(
  rows: readonly T[]
): SurfaceTokens => ({
  input: sum(rows, (r) => r.input_tokens),
  output: sum(rows, (r) => r.output_tokens),
});

/** A `Map` keyed by bucket, filled on first touch. */
function buckets<D>(fresh: (day: string) => D) {
  const byDay = new Map<string, D>();
  return {
    of(day: string): D {
      let point = byDay.get(day);
      if (!point) {
        point = fresh(day);
        byDay.set(day, point);
      }
      return point;
    },
    sorted(key: (point: D) => string): D[] {
      return [...byDay.values()].sort((a, b) => key(a).localeCompare(key(b)));
    },
  };
}

export function memoryUsage(tables: MemoryTables): UsageStore {
  const owned = (owner: string | null) => (subject: string | null) =>
    owner === null || subject === owner;

  /** chat_turns ⋈ chats ⟕ chat_projects, in the window, with the surface each turn counts to. */
  function chatTurns(window: UsageWindow, owner: string | null) {
    const inside = inWindow(window);
    const mine = owned(owner);
    const chats = new Map(tables.select('chats').map((c) => [c.id, c]));
    const projects = new Map(tables.select('chat_projects').map((p) => [p.id, p]));
    return tables
      .select('chat_turns', (t) => inside(t.started_at))
      .flatMap((turn) => {
        const chat = chats.get(turn.chat_id);
        if (!chat || !mine(chat.owner_subject)) return [];
        const project = chat.project_id === null ? undefined : projects.get(chat.project_id);
        const bucket =
          chat.project_id === null ? 'chat' : project?.kind === 'code' ? 'code' : 'chat_project';
        return [{ turn, chat, bucket }];
      });
  }

  const llmCalls = (window: UsageWindow, owner: string | null) => {
    const inside = inWindow(window);
    const mine = owned(owner);
    return tables.select('llm_calls', (r) => inside(r.created_at) && mine(r.subject));
  };
  const runLog = (window: UsageWindow, owner: string | null) => {
    const inside = inWindow(window);
    const mine = owned(owner);
    return tables.select('agent_run_log', (r) => inside(r.created_at) && mine(r.owner_subject));
  };
  const toolCalls = (window: UsageWindow, owner: string | null) => {
    const inside = inWindow(window);
    const mine = owned(owner);
    return tables.select('tool_calls', (r) => inside(r.started_at) && mine(r.subject));
  };
  const scope = (window: UsageWindow, owner: string | null) => {
    const inside = inWindow(window);
    const mine = owned(owner);
    return (at: Date, subject: string) => inside(at) && mine(subject);
  };
  const ledgers = {
    image_usage: (w: UsageWindow, o: string | null) => {
      const hit = scope(w, o);
      return tables.select('image_usage', (r) => hit(r.created_at, r.subject));
    },
    document_usage: (w: UsageWindow, o: string | null) => {
      const hit = scope(w, o);
      return tables.select('document_usage', (r) => hit(r.created_at, r.subject));
    },
    voice_usage: (w: UsageWindow, o: string | null) => {
      const hit = scope(w, o);
      return tables.select('voice_usage', (r) => hit(r.created_at, r.subject));
    },
  };
  const agentsById = () => new Map(tables.select('agents').map((a) => [a.id, a]));
  const failed = (r: Row<'agent_run_log'>) => r.status === 'failed';
  const errored = (r: Row<'tool_calls'>) => r.status !== 'ok';

  return {
    async surfaceTokens(window, owner) {
      const turns = chatTurns(window, owner);
      const of = (bucket: string) =>
        tokens(turns.filter((t) => t.bucket === bucket).map((t) => t.turn));
      return {
        chat: of('chat'),
        chatProjects: of('chat_project'),
        codeProjects: of('code'),
        agents: tokens(llmCalls(window, owner).filter((r) => r.agent_id !== null)),
        images: tokens(ledgers.image_usage(window, owner)),
        documents: tokens(ledgers.document_usage(window, owner)),
      };
    },

    async activityTotals(window, owner) {
      const runs = runLog(window, owner);
      const calls = toolCalls(window, owner);
      return {
        runs: runs.length,
        failures: runs.filter(failed).length,
        toolCalls: calls.length,
        toolErrors: calls.filter(errored).length,
        activeUsers:
          owner === null ? new Set(llmCalls(window, null).map((r) => r.subject)).size : 0,
        totalUsers:
          owner === null ? new Set(tables.select('identities').map((r) => r.subject)).size : 0,
      };
    },

    async dailySeries(window, owner, granularity) {
      const { timeZone } = window;
      const key = (at: Date) => bucketKey(at, timeZone, granularity);
      const days = buckets<OrgDay>(emptyDay);
      for (const { turn, bucket } of chatTurns(window, owner)) {
        foldChatBucket(
          days.of(key(turn.started_at)),
          bucket,
          turn.input_tokens,
          turn.output_tokens
        );
      }
      for (const row of llmCalls(window, owner)) {
        if (row.agent_id === null) continue;
        const point = days.of(key(row.created_at));
        point.agentInputTokens += row.input_tokens;
        point.agentOutputTokens += row.output_tokens;
      }
      for (const row of ledgers.image_usage(window, owner)) {
        const point = days.of(key(row.created_at));
        point.imageInputTokens += row.input_tokens;
        point.imageOutputTokens += row.output_tokens;
        point.images += row.images;
        point.imageBytes += Number(row.image_bytes);
      }
      for (const row of ledgers.document_usage(window, owner)) {
        const point = days.of(key(row.created_at));
        point.documentInputTokens += row.input_tokens;
        point.documentOutputTokens += row.output_tokens;
      }
      for (const row of runLog(window, owner)) {
        const point = days.of(key(row.created_at));
        point.runs += 1;
        if (failed(row)) point.failures += 1;
      }
      for (const row of toolCalls(window, owner)) {
        const point = days.of(key(row.started_at));
        point.toolCalls += 1;
        if (errored(row)) point.toolErrors += 1;
      }
      return days.sorted((d) => d.day);
    },

    async spendBySubject(window) {
      const bySubject = new Map<string, { chatTokens: number; agentTokens: number }>();
      const entry = (subject: string) => {
        const found = bySubject.get(subject) ?? { chatTokens: 0, agentTokens: 0 };
        bySubject.set(subject, found);
        return found;
      };
      for (const { turn, chat } of chatTurns(window, null)) {
        entry(chat.owner_subject).chatTokens += turn.input_tokens + turn.output_tokens;
      }
      for (const row of llmCalls(window, null)) {
        if (row.agent_id === null) continue;
        entry(row.subject).agentTokens += row.input_tokens + row.output_tokens;
      }
      return [...bySubject.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([subject, spend]) => ({ subject, ...spend }));
    },

    async topAgentsByTokens(window, owner, limit) {
      const agents = agentsById();
      const calls = llmCalls(window, owner).filter(
        (r) => r.agent_id !== null && agents.has(r.agent_id)
      );
      const ranked = page(
        orderBy(
          [...groupBy(calls, (r) => r.agent_id ?? '')].map(([agentId, rows]) => ({
            agentId,
            inputTokens: sum(rows, (r) => r.input_tokens),
            outputTokens: sum(rows, (r) => r.output_tokens),
          })),
          [(r) => r.inputTokens + r.outputTokens, 'desc'],
          [(r) => r.agentId]
        ),
        limit
      );
      const runs = runLog(window, owner);
      return ranked.map((row) => {
        const agent = agents.get(row.agentId);
        return {
          agentId: row.agentId,
          name: agent?.name ?? '',
          enabled: agent?.enabled ?? false,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          runs: runs.filter((r) => r.agent_id === row.agentId).length,
        };
      });
    },

    async succeededAgentRuns(window, owner, minSucceededRuns) {
      const agents = agentsById();
      const runs = runLog(window, owner).filter(
        (r) => r.status === 'succeeded' && agents.has(r.agent_id)
      );
      const rows = [...groupBy(runs, (r) => r.agent_id)]
        .filter(([, group]) => group.length >= minSucceededRuns)
        .map(([agentId, group]) => ({
          agentId,
          name: agents.get(agentId)?.name ?? '',
          succeededRuns: group.length,
          inputTokens: sum(group, (r) => r.input_tokens),
          outputTokens: sum(group, (r) => r.output_tokens),
          toolCalls: sum(group, (r) => r.tool_calls),
        }));
      return orderBy(rows, [(r) => r.agentId]);
    },

    async topTools(window, owner, limit) {
      const calls = toolCalls(window, owner);
      const rows = [...groupBy(calls, (r) => JSON.stringify([r.tool, r.connector]))].map(
        ([, group]) => ({
          tool: group[0].tool,
          connector: group[0].connector,
          calls: group.length,
          errors: group.filter(errored).length,
        })
      );
      return page(
        orderBy(rows, [(r) => r.calls, 'desc'], [(r) => r.tool], [(r) => r.connector]),
        limit
      );
    },

    async tokensByModel(window, owner, limit) {
      const calls = llmCalls(window, owner);
      const rows = [...groupBy(calls, (r) => JSON.stringify([r.provider, r.model]))].map(
        ([, group]) => ({
          provider: group[0].provider,
          model: group[0].model,
          inputTokens: sum(group, (r) => r.input_tokens),
          outputTokens: sum(group, (r) => r.output_tokens),
          cachedInputTokens: sum(group, (r) => r.cache_read_input_tokens),
          calls: group.length,
        })
      );
      return page(
        orderBy(
          rows,
          [(r) => r.inputTokens + r.outputTokens, 'desc'],
          [(r) => r.provider],
          [(r) => r.model]
        ),
        limit
      );
    },

    async voiceByKind(window, owner) {
      const rows = [...groupBy(ledgers.voice_usage(window, owner), (r) => r.kind)].map(
        ([kind, group]) => ({
          kind,
          calls: group.length,
          characters: sum(group, (r) => r.characters),
          audioMs: sum(group, (r) => r.audio_ms),
        })
      );
      return orderBy(rows, [(r) => r.kind]);
    },

    async voiceBySubject(window) {
      const usage = ledgers.voice_usage(window, null);
      const rows = [...groupBy(usage, (r) => JSON.stringify([r.subject, r.kind]))].map(
        ([, group]) => ({
          subject: group[0].subject,
          kind: group[0].kind,
          calls: group.length,
          characters: sum(group, (r) => r.characters),
          audioMs: sum(group, (r) => r.audio_ms),
        })
      );
      return orderBy(rows, [(r) => r.subject], [(r) => r.kind]);
    },

    async imageTotals(window, owner) {
      const rows = ledgers.image_usage(window, owner);
      return {
        images: sum(rows, (r) => r.images),
        bytes: sum(rows, (r) => r.image_bytes),
        inputTokens: sum(rows, (r) => r.input_tokens),
        outputTokens: sum(rows, (r) => r.output_tokens),
      };
    },

    async imageBySubject(window) {
      const rows = [...groupBy(ledgers.image_usage(window, null), (r) => r.subject)].map(
        ([subject, group]) => ({
          subject,
          images: sum(group, (r) => r.images),
          bytes: sum(group, (r) => r.image_bytes),
          inputTokens: sum(group, (r) => r.input_tokens),
          outputTokens: sum(group, (r) => r.output_tokens),
        })
      );
      return orderBy(rows, [(r) => r.subject]);
    },

    async documentByKind(window, owner) {
      const rows = [...groupBy(ledgers.document_usage(window, owner), (r) => r.kind)].map(
        ([kind, group]) => ({
          kind,
          count: group.length,
          pages: sum(group, (r) => r.pages),
          inputTokens: sum(group, (r) => r.input_tokens),
          outputTokens: sum(group, (r) => r.output_tokens),
        })
      );
      return orderBy(rows, [(r) => r.kind]);
    },

    async recordLlmCall(call) {
      tables.insert('llm_calls', {
        subject: call.subject,
        agent_id: call.agentId,
        run_id: call.runId,
        step_id: call.stepId,
        purpose: call.purpose,
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
        cache_read_input_tokens: call.cacheReadInputTokens,
        cache_write_input_tokens: call.cacheWriteInputTokens,
        llm_model_id: call.llmModelId,
        provider: call.provider,
        model: call.model,
        duration_ms: call.durationMs,
        id: globalThis.crypto.randomUUID(),
        created_at: new Date(),
      });
    },

    async recordDocument(usage) {
      tables.insert('document_usage', {
        subject: usage.subject,
        artifact_id: usage.artifactId,
        kind: usage.kind,
        pages: usage.pages,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        id: globalThis.crypto.randomUUID(),
        created_at: new Date(),
      });
    },

    async recordImage(usage) {
      tables.insert('image_usage', {
        subject: usage.subject,
        surface: usage.surface,
        provider: usage.provider,
        model: usage.model,
        images: 1,
        image_bytes: String(usage.imageBytes),
        width: usage.width,
        height: usage.height,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        id: globalThis.crypto.randomUUID(),
        created_at: new Date(),
      });
    },

    async recordVoice(usage) {
      tables.insert('voice_usage', {
        subject: usage.subject,
        kind: usage.kind,
        characters: usage.characters,
        audio_ms: usage.audioMs,
        provider: usage.provider,
        voice: usage.voice,
        locale: usage.locale,
        id: globalThis.crypto.randomUUID(),
        created_at: new Date(),
      });
    },

    async personTotals(subject, window) {
      const calls = llmCalls(window, subject);
      const chat = calls.filter((r) => r.purpose === 'chat');
      const runs = runLog(window, subject);
      const tools = toolCalls(window, subject);
      return {
        inputTokens: sum(calls, (r) => r.input_tokens),
        outputTokens: sum(calls, (r) => r.output_tokens),
        chatInputTokens: sum(chat, (r) => r.input_tokens),
        chatOutputTokens: sum(chat, (r) => r.output_tokens),
        runs: runs.length,
        failures: runs.filter(failed).length,
        toolCalls: tools.length,
        toolErrors: tools.filter(errored).length,
      };
    },

    async personSeries(subject, window, granularity: UsageGranularity) {
      const key = (at: Date) => bucketKey(at, window.timeZone, granularity);
      const days = buckets<UtilizationDay>(emptyUtilizationDay);
      for (const row of llmCalls(window, subject)) {
        const point = days.of(key(row.created_at));
        point.inputTokens += row.input_tokens;
        point.outputTokens += row.output_tokens;
      }
      for (const row of runLog(window, subject)) {
        const point = days.of(key(row.created_at));
        point.runs += 1;
        if (failed(row)) point.failures += 1;
      }
      for (const row of toolCalls(window, subject)) {
        const point = days.of(key(row.started_at));
        point.toolCalls += 1;
        if (errored(row)) point.toolErrors += 1;
      }
      return days.sorted((d) => d.day);
    },

    async personAgents(subject, window) {
      const agents = orderBy(
        tables.select('agents', (a) => a.owner_subject === subject),
        [(a) => a.name],
        [(a) => a.id]
      );
      const runs = runLog(window, subject);
      const calls = llmCalls(window, subject);
      const tools = toolCalls(window, subject);
      return agents.map((agent) => {
        const mine = runs.filter((r) => r.agent_id === agent.id);
        const spent = calls.filter((r) => r.agent_id === agent.id);
        const lastFailure = orderBy(
          mine.filter(failed),
          [(r) => r.created_at, 'desc'],
          [(r) => r.run_id, 'desc']
        )[0];
        return {
          agentId: agent.id,
          name: agent.name,
          enabled: agent.enabled,
          runs: mine.length,
          failures: mine.filter(failed).length,
          inputTokens: sum(spent, (r) => r.input_tokens),
          outputTokens: sum(spent, (r) => r.output_tokens),
          toolCalls: tools.filter((r) => r.agent_id === agent.id).length,
          lastFailureAt: lastFailure ? lastFailure.created_at.toISOString() : null,
          lastFailureStep: lastFailure?.step_name ?? null,
          lastFailureKind: lastFailure?.error_kind ?? null,
        };
      });
    },

    async failureSignatures(subject, window, limit) {
      const agents = agentsById();
      const runs = runLog(window, subject).filter(
        (r) => failed(r) && agents.get(r.agent_id)?.enabled === true
      );
      const groups = groupBy(runs, (r) =>
        JSON.stringify([r.agent_id, r.step_name, r.error_kind, r.outcome_code])
      );
      const rows = [...groups.values()].map((group) => {
        const newest = orderBy(group, [(r) => r.created_at, 'desc'], [(r) => r.run_id, 'desc'])[0];
        return {
          agentId: newest.agent_id,
          agentName: agents.get(newest.agent_id)?.name ?? '',
          stepName: newest.step_name,
          errorKind: newest.error_kind,
          outcomeCode: newest.outcome_code,
          count: group.length,
          lastAt: newest.created_at,
          lastError: newest.error,
        };
      });
      return page(
        orderBy(
          rows,
          [(r) => r.count, 'desc'],
          [(r) => r.lastAt, 'desc'],
          [(r) => r.agentId],
          [(r) => r.stepName],
          [(r) => r.errorKind],
          [(r) => r.outcomeCode]
        ),
        limit
      ).map((row) => ({ ...row, lastAt: row.lastAt.toISOString() }));
    },
  };
}
