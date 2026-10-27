import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, SandboxSizeRequests } from '../../../db.types';
import type { CodeProjectStore, SizeRequestRecord } from './types';

export function sizeRequestFromRow(row: Selectable<SandboxSizeRequests>): SizeRequestRecord {
  return {
    id: row.id,
    subject: row.subject,
    requestedBy: row.requested_by,
    requestedBytes: Number(row.requested_bytes),
    reason: row.reason,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    decisionNote: row.decision_note,
    createdAt: new Date(row.created_at),
  };
}

export function postgresCodeProjects(db: () => Kysely<DB>): CodeProjectStore {
  return {
    async workspaceBranches(workspaceIds) {
      if (workspaceIds.length === 0) return [];
      const rows = await db()
        .selectFrom('sandbox_workspaces')
        .select(['id', 'branch'])
        .where('id', 'in', workspaceIds)
        .where('status', '=', 'ready')
        .orderBy('id')
        .execute();
      return rows.filter((row) => row.branch);
    },
    async usageByChat(projectId) {
      const rows = await db()
        .selectFrom('chat_turns')
        .innerJoin('chats', 'chats.id', 'chat_turns.chat_id')
        .select(({ fn }) => [
          'chat_turns.chat_id as chat_id',
          fn.sum<string>('chat_turns.input_tokens').as('input_tokens'),
          fn.sum<string>('chat_turns.output_tokens').as('output_tokens'),
        ])
        .where('chats.project_id', '=', projectId)
        .groupBy('chat_turns.chat_id')
        .orderBy('chat_turns.chat_id')
        .execute();
      return rows.map((row) => ({
        chatId: row.chat_id,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
      }));
    },
    async latestSizeRequest(subject) {
      const row = await db()
        .selectFrom('sandbox_size_requests')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      return row ? sizeRequestFromRow(row) : null;
    },
    async approvedSizes(subject) {
      const rows = await db()
        .selectFrom('sandbox_size_requests')
        .select('requested_bytes')
        .where('subject', '=', subject)
        .where('status', '=', 'approved')
        .execute();
      return rows.map((row) => Number(row.requested_bytes)).sort((a, b) => a - b);
    },
    async createSizeRequest(request) {
      const row = await db()
        .insertInto('sandbox_size_requests')
        .values({
          subject: request.subject,
          requested_by: request.requestedBy,
          requested_bytes: request.requestedBytes,
          reason: request.reason,
        })
        .onConflict((oc) => oc.columns(['subject']).where('status', '=', 'pending').doNothing())
        .returningAll()
        .executeTakeFirst();
      return row ? sizeRequestFromRow(row) : null;
    },
    async listSizeRequests(projectPrefix, limit) {
      const rows = await db()
        .selectFrom('sandbox_size_requests as r')
        .leftJoin('chat_projects as p', (join) =>
          join.on(sql<boolean>`r.subject = ${projectPrefix} || p.id::text`)
        )
        .selectAll('r')
        .select('p.name as project_name')
        .orderBy((eb) => eb.case().when('r.status', '=', 'pending').then(0).else(1).end())
        .orderBy('r.created_at', 'desc')
        .orderBy('r.id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({ ...sizeRequestFromRow(row), projectName: row.project_name }));
    },
    async decideSizeRequest(decision) {
      const row = await db()
        .updateTable('sandbox_size_requests')
        .set({
          status: decision.status,
          decided_by: decision.decidedBy,
          decided_at: new Date().toISOString(),
          decision_note: decision.note,
          ...(decision.status === 'approved' && decision.approvedBytes !== undefined
            ? { requested_bytes: decision.approvedBytes }
            : {}),
        })
        .where('id', '=', decision.id)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      return row ? sizeRequestFromRow(row) : null;
    },
    async providerGrantScopes(subject, provider) {
      const row = await db()
        .selectFrom('provider_grants')
        .select(['requested_scopes', 'granted_scopes'])
        .where('provider', '=', provider)
        .where('subject', '=', subject)
        .orderBy('updated_at', 'desc')
        .orderBy('provider_account_id')
        .limit(1)
        .executeTakeFirst();
      return row
        ? { requestedScopes: row.requested_scopes, grantedScopes: row.granted_scopes }
        : null;
    },
    async noteLanguageGap(gap) {
      await db()
        .insertInto('code_language_gaps')
        .values({
          extension: gap.extension,
          language: gap.language,
          reason: gap.reason,
          sample_path: gap.samplePath,
        })
        .onConflict((conflict) =>
          conflict.columns(['extension', 'language', 'reason']).doUpdateSet({
            open_count: sql`code_language_gaps.open_count + 1`,
            last_seen_at: sql`now()`,
            sample_path: gap.samplePath,
          })
        )
        .execute();
    },
    async listLanguageGaps() {
      const rows = await db()
        .selectFrom('code_language_gaps')
        .selectAll()
        .orderBy('open_count', 'desc')
        .orderBy('extension')
        .orderBy('language')
        .orderBy('reason')
        .execute();
      return rows.map((row) => ({
        extension: row.extension,
        language: row.language,
        reason: row.reason,
        samplePath: row.sample_path,
        openCount: row.open_count,
        firstSeenAt: new Date(row.first_seen_at),
        lastSeenAt: new Date(row.last_seen_at),
      }));
    },
    async getActivePrSubscription(key) {
      const row = await db()
        .selectFrom('pr_subscriptions')
        .select([
          'id',
          'project_id',
          'chat_id',
          'watch_pipelines',
          'auto_fix',
          'auto_merge',
          'status',
        ])
        .where('provider', '=', key.provider)
        .where('repo_full_name', '=', key.repoFullName)
        .where('pr_number', '=', key.prNumber)
        .where('subscriber_subject', '=', key.subscriberSubject)
        .where('status', '=', 'active')
        .executeTakeFirst();
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
      const row = await db()
        .selectFrom('pr_pipeline_events')
        .select(['conclusion', 'action_taken', 'observed_at'])
        .where('subscription_id', '=', subscriptionId)
        .orderBy('observed_at', 'desc')
        .orderBy('id')
        .executeTakeFirst();
      return row
        ? {
            conclusion: row.conclusion,
            actionTaken: row.action_taken,
            observedAt: new Date(row.observed_at),
          }
        : null;
    },
    async savePrSubscription(subscription) {
      await db()
        .insertInto('pr_subscriptions')
        .values({
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
        })
        .onConflict((oc) =>
          oc
            .columns(['provider', 'repo_full_name', 'pr_number', 'subscriber_subject'])
            .doUpdateSet({
              chat_id: subscription.chatId,
              watch_pipelines: subscription.watchPipelines,
              auto_fix: subscription.autoFix,
              auto_merge: subscription.autoMerge,
              status: 'active',
              updated_at: new Date(),
            })
        )
        .execute();
    },
    async cancelPrSubscription(key) {
      await db()
        .updateTable('pr_subscriptions')
        .set({ status: 'canceled', updated_at: new Date() })
        .where('provider', '=', key.provider)
        .where('repo_full_name', '=', key.repoFullName)
        .where('pr_number', '=', key.prNumber)
        .where('subscriber_subject', '=', key.subscriberSubject)
        .execute();
    },
  };
}
