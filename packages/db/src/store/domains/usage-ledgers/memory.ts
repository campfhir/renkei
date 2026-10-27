import { compareAsc, groupBy, orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import type { ChatSurface, LedgerFilter, UsageLedgerStore } from './types';
import { bucketOf, inWindow, sum } from './window';

type LlmCall = Row<'llm_calls'>;
type Turn = Row<'chat_turns'> & { owner: string; surface: ChatSurface };
type Image = Row<'image_usage'>;

const scoped = (filter: LedgerFilter) => filter.subject !== undefined && filter.subject !== null;
const tokenSums = <T extends { input_tokens: number; output_tokens: number }>(rows: T[]) => ({
  inputTokens: sum(rows, (r) => r.input_tokens),
  outputTokens: sum(rows, (r) => r.output_tokens),
});
const imageSums = (rows: Image[]) => ({
  images: sum(rows, (r) => r.images),
  bytes: sum(rows, (r) => r.image_bytes),
  ...tokenSums(rows),
});
const byKey = <K extends string, T>(groups: Map<K, T[]>): [K, T[]][] =>
  [...groups].sort((left, right) => compareAsc(left[0], right[0]));

export function memoryUsageLedgers(tables: MemoryTables): UsageLedgerStore {
  const ids = (agentIds: string[]) =>
    new Set(agentIds.map((id) => tables.param('llm_calls', 'agent_id', id)));
  const llm = (filter: LedgerFilter & { agentsOnly?: boolean }): LlmCall[] =>
    tables.select(
      'llm_calls',
      (r) =>
        inWindow(r.created_at, filter.window) &&
        (!scoped(filter) || r.subject === filter.subject) &&
        (!filter.agentsOnly || r.agent_id !== null)
    );
  const runs = (filter: LedgerFilter) =>
    tables.select(
      'agent_run_log',
      (r) =>
        inWindow(r.created_at, filter.window) &&
        (!scoped(filter) || r.owner_subject === filter.subject)
    );
  const turns = (filter: LedgerFilter): Turn[] => {
    const chats = new Map(tables.select('chats').map((c) => [c.id, c]));
    const projects = new Map(tables.select('chat_projects').map((p) => [p.id, p]));
    return tables
      .select('chat_turns', (r) => inWindow(r.started_at, filter.window))
      .flatMap((turn) => {
        const chat = chats.get(turn.chat_id);
        if (!chat || (scoped(filter) && chat.owner_subject !== filter.subject)) return [];
        const project = chat.project_id === null ? undefined : projects.get(chat.project_id);
        const surface: ChatSurface =
          chat.project_id === null ? 'chat' : project?.kind === 'code' ? 'code' : 'chat_project';
        return [{ ...turn, owner: chat.owner_subject, surface }];
      });
  };
  const images = (filter: LedgerFilter) =>
    tables.select(
      'image_usage',
      (r) =>
        inWindow(r.created_at, filter.window) && (!scoped(filter) || r.subject === filter.subject)
    );
  const voice = (filter: LedgerFilter) =>
    tables.select(
      'voice_usage',
      (r) =>
        inWindow(r.created_at, filter.window) && (!scoped(filter) || r.subject === filter.subject)
    );
  const documents = (filter: LedgerFilter) =>
    tables.select(
      'document_usage',
      (r) =>
        inWindow(r.created_at, filter.window) && (!scoped(filter) || r.subject === filter.subject)
    );
  const agentById = (id: string) => tables.first('agents', (a) => a.id === id);

  return {
    async llmTotals(filter) {
      const rows = llm(filter);
      const chat = rows.filter((r) => r.purpose === 'chat');
      return {
        ...tokenSums(rows),
        chatInputTokens: sum(chat, (r) => r.input_tokens),
        chatOutputTokens: sum(chat, (r) => r.output_tokens),
      };
    },
    async llmSeries(filter, bucketing) {
      return byKey(groupBy(llm(filter), (r) => bucketOf(r.created_at, bucketing))).map(
        ([bucket, group]) => ({ bucket, ...tokenSums(group) })
      );
    },
    async llmByAgent(filter) {
      const wanted = ids(filter.agentIds);
      const rows = llm(filter).filter((r) => r.agent_id !== null && wanted.has(r.agent_id));
      return byKey(groupBy(rows, (r) => r.agent_id ?? '')).map(([agentId, group]) => ({
        agentId,
        ...tokenSums(group),
      }));
    },
    async agentLlmBySubject(filter) {
      return byKey(groupBy(llm({ ...filter, agentsOnly: true }), (r) => r.subject)).map(
        ([subject, group]) => ({ subject, ...tokenSums(group) })
      );
    },
    async topAgentsByTokens(filter, limit) {
      const rows = byKey(
        groupBy(llm({ ...filter, agentsOnly: true }), (r) => r.agent_id ?? '')
      ).flatMap(([agentId, group]) => {
        const agent = agentById(agentId);
        return agent
          ? [{ agentId, name: agent.name, enabled: agent.enabled, ...tokenSums(group) }]
          : [];
      });
      return page(
        orderBy(rows, [(r) => r.inputTokens + r.outputTokens, 'desc'], [(r) => r.agentId]),
        limit
      );
    },
    async tokensByModel(filter, limit) {
      const groups = [
        ...groupBy(
          llm(filter),
          (r) => `${r.provider ?? '\u0001'}\u0000${r.model ?? '\u0001'}`
        ).values(),
      ];
      const rows = groups.map((group) => ({
        provider: group[0].provider,
        model: group[0].model,
        ...tokenSums(group),
        cachedInputTokens: sum(group, (r) => r.cache_read_input_tokens),
        calls: group.length,
      }));
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
    async countActiveSubjects(window) {
      return new Set(llm({ window }).map((r) => r.subject)).size;
    },

    async runTotals(filter) {
      const rows = runs(filter);
      return { runs: rows.length, failures: rows.filter((r) => r.status === 'failed').length };
    },
    async runSeries(filter, bucketing) {
      return byKey(groupBy(runs(filter), (r) => bucketOf(r.created_at, bucketing))).map(
        ([bucket, group]) => ({
          bucket,
          runs: group.length,
          failures: group.filter((r) => r.status === 'failed').length,
        })
      );
    },
    async runsByAgent(filter) {
      const wanted = ids(filter.agentIds);
      return byKey(
        groupBy(
          runs(filter).filter((r) => wanted.has(r.agent_id)),
          (r) => r.agent_id
        )
      ).map(([agentId, group]) => ({
        agentId,
        runs: group.length,
        failures: group.filter((r) => r.status === 'failed').length,
      }));
    },
    async lastFailureByAgent(filter) {
      const wanted = ids(filter.agentIds);
      const failed = runs(filter).filter((r) => wanted.has(r.agent_id) && r.status === 'failed');
      return byKey(groupBy(failed, (r) => r.agent_id)).map(([agentId, group]) => {
        const [newest] = orderBy(group, [(r) => r.created_at, 'desc'], [(r) => r.run_id]);
        return {
          agentId,
          at: newest.created_at,
          stepName: newest.step_name,
          errorKind: newest.error_kind,
        };
      });
    },
    async failureSignatures(filter, limit) {
      const failed = runs(filter).filter(
        (r) => r.status === 'failed' && agentById(r.agent_id)?.enabled === true
      );
      const groups = [
        ...groupBy(failed, (r) =>
          JSON.stringify([r.agent_id, r.step_name, r.error_kind, r.outcome_code])
        ).values(),
      ];
      const rows = groups.map((group) => {
        const [newest] = orderBy(group, [(r) => r.created_at, 'desc'], [(r) => r.run_id]);
        return {
          agentId: newest.agent_id,
          agentName: agentById(newest.agent_id)?.name ?? '',
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
      );
    },
    async succeededRunStats(filter, minRuns) {
      const succeeded = runs(filter).filter((r) => r.status === 'succeeded');
      return byKey(groupBy(succeeded, (r) => r.agent_id)).flatMap(([agentId, group]) => {
        const agent = agentById(agentId);
        if (!agent || group.length < minRuns) return [];
        return [
          {
            agentId,
            name: agent.name,
            runs: group.length,
            toolCalls: sum(group, (r) => r.tool_calls),
            ...tokenSums(group),
          },
        ];
      });
    },

    async chatTokensBySurface(filter) {
      return byKey(groupBy(turns(filter), (r) => r.surface)).map(([surface, group]) => ({
        surface,
        ...tokenSums(group),
      }));
    },
    async chatSeriesBySurface(filter, bucketing) {
      const rows = turns(filter);
      const groups = [
        ...groupBy(rows, (r) => `${bucketOf(r.started_at, bucketing)} ${r.surface}`).values(),
      ];
      return orderBy(
        groups.map((group) => ({
          bucket: bucketOf(group[0].started_at, bucketing),
          surface: group[0].surface,
          ...tokenSums(group),
        })),
        [(r) => r.bucket],
        [(r) => r.surface]
      );
    },
    async chatTokensBySubject(filter) {
      return byKey(groupBy(turns(filter), (r) => r.owner)).map(([subject, group]) => ({
        subject,
        ...tokenSums(group),
      }));
    },

    async imageTotals(filter) {
      return imageSums(images(filter));
    },
    async imageSeries(filter, bucketing) {
      return byKey(groupBy(images(filter), (r) => bucketOf(r.created_at, bucketing))).map(
        ([bucket, group]) => ({ bucket, ...imageSums(group) })
      );
    },
    async imageBySubject(filter) {
      return byKey(groupBy(images(filter), (r) => r.subject)).map(([subject, group]) => ({
        subject,
        ...imageSums(group),
      }));
    },

    async voiceByKind(filter) {
      return byKey(groupBy(voice(filter), (r) => r.kind)).map(([kind, group]) => ({
        kind,
        calls: group.length,
        characters: sum(group, (r) => r.characters),
        audioMs: sum(group, (r) => r.audio_ms),
      }));
    },
    async voiceBySubjectKind(filter) {
      const groups = [
        ...groupBy(voice(filter), (r) => JSON.stringify([r.subject, r.kind])).values(),
      ];
      return orderBy(
        groups.map((group) => ({
          subject: group[0].subject,
          kind: group[0].kind,
          calls: group.length,
          characters: sum(group, (r) => r.characters),
          audioMs: sum(group, (r) => r.audio_ms),
        })),
        [(r) => r.subject],
        [(r) => r.kind]
      );
    },

    async documentByKind(filter) {
      return byKey(groupBy(documents(filter), (r) => r.kind)).map(([kind, group]) => ({
        kind,
        count: group.length,
        pages: sum(group, (r) => r.pages),
        ...tokenSums(group),
      }));
    },
    async documentSeries(filter, bucketing) {
      return byKey(groupBy(documents(filter), (r) => bucketOf(r.created_at, bucketing))).map(
        ([bucket, group]) => ({ bucket, ...tokenSums(group) })
      );
    },
    async insertDocumentUsage(input) {
      tables.insert('document_usage', {
        subject: input.subject,
        artifact_id: input.artifactId,
        kind: input.kind,
        pages: input.pages,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
      });
    },

    async ownedAgents(subject) {
      const rows = tables.select('agents', (r) => r.owner_subject === subject);
      return orderBy(rows, [(r) => r.name], [(r) => r.id]).map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
      }));
    },
    async countPeople() {
      return new Set(tables.select('identities').map((r) => r.subject)).size;
    },
  };
}
