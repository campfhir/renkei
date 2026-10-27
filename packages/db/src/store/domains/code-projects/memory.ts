import { orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { sizeRequestFromRow } from './postgres';
import type { CodeProjectStore, PrSubscriptionKey } from './types';

function matchesKey(row: Row<'pr_subscriptions'>, key: PrSubscriptionKey): boolean {
  return (
    row.provider === key.provider &&
    row.repo_full_name === key.repoFullName &&
    row.pr_number === key.prNumber &&
    row.subscriber_subject === key.subscriberSubject
  );
}

export function memoryCodeProjects(tables: MemoryTables): CodeProjectStore {
  const requestsOf = (subject: string) =>
    orderBy(
      tables.select('sandbox_size_requests', (r) => r.subject === subject),
      [(r) => r.created_at, 'desc'],
      [(r) => r.id]
    );

  return {
    async workspaceBranches(workspaceIds) {
      if (workspaceIds.length === 0) return [];
      const ids = new Set(workspaceIds.map((id) => tables.param('sandbox_workspaces', 'id', id)));
      return orderBy(
        tables.select(
          'sandbox_workspaces',
          (r) => ids.has(r.id) && r.status === 'ready' && r.branch !== ''
        ),
        [(r) => r.id]
      ).map((r) => ({ id: r.id, branch: r.branch }));
    },
    async usageByChat(projectId) {
      const project = tables.param('chats', 'project_id', projectId);
      const chats = new Set(
        tables.select('chats', (c) => c.project_id === project).map((c) => c.id)
      );
      const totals = new Map<string, { input: number; output: number }>();
      for (const turn of tables.select('chat_turns', (t) => chats.has(t.chat_id))) {
        const total = totals.get(turn.chat_id) ?? { input: 0, output: 0 };
        total.input += turn.input_tokens;
        total.output += turn.output_tokens;
        totals.set(turn.chat_id, total);
      }
      return orderBy([...totals], [([chatId]) => chatId]).map(([chatId, total]) => ({
        chatId,
        inputTokens: total.input,
        outputTokens: total.output,
      }));
    },
    async latestSizeRequest(subject) {
      const [row] = requestsOf(subject);
      return row ? sizeRequestFromRow(row) : null;
    },
    async approvedSizes(subject) {
      return tables
        .select('sandbox_size_requests', (r) => r.subject === subject && r.status === 'approved')
        .map((row) => Number(row.requested_bytes))
        .sort((a, b) => a - b);
    },
    async createSizeRequest(request) {
      // The partial unique index (subject) WHERE status = 'pending'.
      if (
        tables.first(
          'sandbox_size_requests',
          (r) => r.subject === request.subject && r.status === 'pending'
        )
      ) {
        return null;
      }
      return sizeRequestFromRow(
        tables.insert('sandbox_size_requests', {
          subject: request.subject,
          requested_by: request.requestedBy,
          requested_bytes: request.requestedBytes,
          reason: request.reason,
        })
      );
    },
    async listSizeRequests(projectPrefix, limit) {
      const projects = tables.select('chat_projects');
      const rows = orderBy(
        tables.select('sandbox_size_requests'),
        [(r) => (r.status === 'pending' ? 0 : 1)],
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return page(rows, limit).map((row) => ({
        ...sizeRequestFromRow(row),
        projectName: projects.find((p) => `${projectPrefix}${p.id}` === row.subject)?.name ?? null,
      }));
    },
    async decideSizeRequest(decision) {
      const id = tables.param('sandbox_size_requests', 'id', decision.id);
      const [row] = tables.update(
        'sandbox_size_requests',
        (r) => r.id === id && r.status === 'pending',
        {
          status: decision.status,
          decided_by: decision.decidedBy,
          decided_at: new Date(),
          decision_note: decision.note,
          ...(decision.status === 'approved' && decision.approvedBytes !== undefined
            ? { requested_bytes: decision.approvedBytes }
            : {}),
        }
      );
      return row ? sizeRequestFromRow(row) : null;
    },
    async providerGrantScopes(subject, provider) {
      const [row] = orderBy(
        tables.select('provider_grants', (r) => r.provider === provider && r.subject === subject),
        [(r) => r.updated_at, 'desc'],
        [(r) => r.provider_account_id]
      );
      return row
        ? { requestedScopes: row.requested_scopes, grantedScopes: row.granted_scopes }
        : null;
    },
    async noteLanguageGap(gap) {
      tables.upsert(
        'code_language_gaps',
        {
          extension: gap.extension,
          language: gap.language,
          reason: gap.reason,
          sample_path: gap.samplePath,
        },
        ['extension', 'language', 'reason'],
        (existing) => ({
          open_count: existing.open_count + 1,
          last_seen_at: new Date(),
          sample_path: gap.samplePath,
        })
      );
    },
    async listLanguageGaps() {
      return orderBy(
        tables.select('code_language_gaps'),
        [(r) => r.open_count, 'desc'],
        [(r) => r.extension],
        [(r) => r.language],
        [(r) => r.reason]
      ).map((row) => ({
        extension: row.extension,
        language: row.language,
        reason: row.reason,
        samplePath: row.sample_path,
        openCount: row.open_count,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }));
    },
    async getActivePrSubscription(key) {
      const row = tables.first(
        'pr_subscriptions',
        (r) => matchesKey(r, key) && r.status === 'active'
      );
      return row
        ? {
            id: row.id,
            projectId: row.project_id,
            chatId: row.chat_id,
            watchPipelines: row.watch_pipelines,
            autoFix: row.auto_fix,
            autoMerge: row.auto_merge,
            status: row.status,
          }
        : null;
    },
    async latestPrPipelineEvent(subscriptionId) {
      const id = tables.param('pr_pipeline_events', 'subscription_id', subscriptionId);
      const [row] = orderBy(
        tables.select('pr_pipeline_events', (r) => r.subscription_id === id),
        [(r) => r.observed_at, 'desc'],
        [(r) => r.id]
      );
      return row
        ? { conclusion: row.conclusion, actionTaken: row.action_taken, observedAt: row.observed_at }
        : null;
    },
    async savePrSubscription(subscription) {
      tables.upsert(
        'pr_subscriptions',
        {
          project_id: subscription.projectId,
          chat_id: subscription.chatId,
          subscriber_subject: subscription.subscriberSubject,
          provider: subscription.provider,
          repo_full_name: subscription.repoFullName,
          pr_number: subscription.prNumber,
          watch_pipelines: subscription.watchPipelines,
          auto_fix: subscription.autoFix,
          auto_merge: subscription.autoMerge,
          status: 'active',
        },
        ['provider', 'repo_full_name', 'pr_number', 'subscriber_subject'],
        {
          chat_id: subscription.chatId,
          watch_pipelines: subscription.watchPipelines,
          auto_fix: subscription.autoFix,
          auto_merge: subscription.autoMerge,
          status: 'active',
          updated_at: new Date(),
        }
      );
    },
    async cancelPrSubscription(key) {
      tables.update('pr_subscriptions', (r) => matchesKey(r, key), {
        status: 'canceled',
        updated_at: new Date(),
      });
    },
  };
}
