import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { messageFromRow, subagentRunFromRow, turnFromRow } from './record';
import type {
  ChatMessageInsert,
  ChatTurnEngineStore,
  ChatTurnInsert,
  InsertedChatMessage,
} from './engine-types';

const date = (value: Date | string) => new Date(value);

async function insertTurn(db: Kysely<DB>, turn: ChatTurnInsert): Promise<string> {
  const inserted = await db
    .insertInto('chat_turns')
    .values({
      chat_id: turn.chatId,
      status: 'running',
      kind: turn.kind,
      llm_model_id: turn.llmModelId,
      thinking_budget: turn.thinkingBudget,
      runner:
        turn.runner === null || turn.runner === undefined ? null : JSON.stringify(turn.runner),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

async function insertMessage(
  db: Kysely<DB>,
  message: ChatMessageInsert
): Promise<InsertedChatMessage> {
  const inserted = await db
    .insertInto('chat_messages')
    .values({
      chat_id: message.chatId,
      turn_id: message.turnId,
      seq: sql<number>`(SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE chat_id = ${message.chatId})`,
      role: message.role,
      kind: message.kind,
      status: message.status,
      content: message.content,
      llm_model_id: message.llmModelId ?? null,
      provider: message.provider ?? null,
      model: message.model ?? null,
    })
    .returning(['id', 'seq', 'created_at'])
    .executeTakeFirstOrThrow();
  return { id: inserted.id, seq: inserted.seq, createdAt: date(inserted.created_at) };
}

export function postgresChatTurnEngine(db: () => Kysely<DB>): ChatTurnEngineStore {
  return {
    createTurn: (turn) => insertTurn(db(), turn),
    async openTurn(input) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const turnId = await insertTurn(trx, input.turn);
          const messages: InsertedChatMessage[] = [];
          for (const message of input.messages) {
            messages.push(
              await insertMessage(trx, { ...message, chatId: input.turn.chatId, turnId })
            );
          }
          const link = input.link;
          const target = link ? messages[link.messageIndex] : undefined;
          if (link && target && link.artifactIds.length > 0) {
            await trx
              .updateTable('artifacts')
              .set({ message_id: target.id })
              .where('chat_id', '=', input.turn.chatId)
              .where('owner_subject', '=', link.ownerSubject)
              .where('id', 'in', link.artifactIds)
              .execute();
          }
          return { turnId, messages };
        });
    },
    insertMessage: (message) => insertMessage(db(), message),
    async insertMessageWhenIdle(message) {
      return db()
        .transaction()
        .execute(async (trx) => {
          await trx
            .selectFrom('chats')
            .select('id')
            .where('id', '=', message.chatId)
            .forUpdate()
            .executeTakeFirst();
          const running = await trx
            .selectFrom('chat_turns')
            .select('id')
            .where('chat_id', '=', message.chatId)
            .where('status', '=', 'running')
            .executeTakeFirst();
          if (running) return null;
          return insertMessage(trx, message);
        });
    },
    async getMessage(chatId, messageId) {
      const row = await db()
        .selectFrom('chat_messages')
        .selectAll()
        .where('chat_id', '=', chatId)
        .where('id', '=', messageId)
        .executeTakeFirst();
      return row ? messageFromRow(row) : null;
    },
    async updateMessage(messageId, patch) {
      await db()
        .updateTable('chat_messages')
        .set({
          ...(patch.content !== undefined ? { content: patch.content } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.stopReason !== undefined ? { stop_reason: patch.stopReason } : {}),
          ...(patch.usage !== undefined
            ? { usage: patch.usage === null ? null : JSON.stringify(patch.usage) }
            : {}),
          ...(patch.timing !== undefined
            ? { timing: patch.timing === null ? null : JSON.stringify(patch.timing) }
            : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          updated_at: sql<Date>`NOW()`,
        })
        .where('id', '=', messageId)
        .execute();
    },
    async deleteMessage(messageId) {
      await db().deleteFrom('chat_messages').where('id', '=', messageId).execute();
    },
    async settleStreamingMessages(turnId, status) {
      await db()
        .updateTable('chat_messages')
        .set({ status, updated_at: sql<Date>`NOW()` })
        .where('turn_id', '=', turnId)
        .where('status', '=', 'streaming')
        .execute();
    },
    async truncateFrom(chatId, fromSeq) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const doomed = await trx
            .selectFrom('chat_messages')
            .select(['id', 'turn_id'])
            .where('chat_id', '=', chatId)
            .where('seq', '>=', fromSeq)
            .execute();
          const messageIds = doomed.map((row) => row.id);
          const turnIds = [...new Set(doomed.flatMap((row) => (row.turn_id ? [row.turn_id] : [])))];
          const removed: { id: string; blobKey: string }[] = [];
          if (messageIds.length > 0) {
            const artifacts = await trx
              .selectFrom('artifacts')
              .select(['id', 'blob_key'])
              .where('chat_id', '=', chatId)
              .where('origin', '=', 'model')
              .where('message_id', 'in', messageIds)
              .orderBy('id')
              .execute();
            if (artifacts.length > 0) {
              await trx
                .deleteFrom('artifacts')
                .where(
                  'id',
                  'in',
                  artifacts.map((row) => row.id)
                )
                .execute();
              removed.push(...artifacts.map((row) => ({ id: row.id, blobKey: row.blob_key })));
            }
            await trx.deleteFrom('chat_messages').where('id', 'in', messageIds).execute();
          }
          if (turnIds.length > 0) {
            await trx
              .deleteFrom('chat_turns')
              .where('chat_id', '=', chatId)
              .where('id', 'in', turnIds)
              .execute();
          }
          return removed;
        });
    },
    async heartbeatTurn(turnId, iterations, stage) {
      const row = await db()
        .updateTable('chat_turns')
        .set({
          updated_at: sql<Date>`NOW()`,
          iterations,
          stage,
          stage_at: sql<Date>`CASE WHEN stage IS DISTINCT FROM ${stage} THEN NOW() ELSE stage_at END`,
        })
        .where('id', '=', turnId)
        .where('status', '=', 'running')
        .returning('cancel_requested_at')
        .executeTakeFirst();
      return row?.cancel_requested_at !== null && row?.cancel_requested_at !== undefined;
    },
    async finishTurn(turnId, outcome) {
      await db()
        .updateTable('chat_turns')
        .set({
          status: outcome.status,
          error: outcome.error,
          iterations: outcome.iterations,
          input_tokens: outcome.inputTokens,
          output_tokens: outcome.outputTokens,
          tool_permission: null,
          updated_at: sql<Date>`NOW()`,
          finished_at: sql<Date>`NOW()`,
        })
        .where('id', '=', turnId)
        .where('status', '=', 'running')
        .execute();
    },
    async suspendTurn(turnId, iterations) {
      await db()
        .updateTable('chat_turns')
        .set({
          suspended_at: sql<Date>`NOW()`,
          iterations,
          stage: null,
          stage_at: null,
          updated_at: sql<Date>`NOW()`,
        })
        .where('id', '=', turnId)
        .where('status', '=', 'running')
        .execute();
    },
    async claimResumableTurns(options) {
      // The claim is the UPDATE itself — row-locked, skipping rows another
      // replica's sweep holds — so two replicas never resume one turn.
      const result = await sql<{ id: string }>`
        UPDATE chat_turns t
           SET suspended_at = NULL,
               resume_count = t.resume_count + 1,
               tool_permission = NULL,
               stage = NULL,
               stage_at = NULL,
               updated_at = NOW()
          FROM (
            SELECT id FROM chat_turns
             WHERE status = 'running'
               AND kind = 'reply'
               AND resume_count < ${options.maxResumes}
               AND (suspended_at IS NOT NULL
                    OR updated_at < NOW() - make_interval(secs => ${options.staleSeconds}))
             ORDER BY updated_at
             LIMIT ${options.limit}
             FOR UPDATE SKIP LOCKED
          ) due
         WHERE t.id = due.id
        RETURNING t.id
      `.execute(db());
      if (result.rows.length === 0) return [];
      const rows = await db()
        .selectFrom('chat_turns')
        .selectAll()
        .where(
          'id',
          'in',
          result.rows.map((row) => row.id)
        )
        .orderBy('started_at')
        .orderBy('id')
        .execute();
      return rows.map(turnFromRow);
    },
    async interruptExhaustedTurns(options) {
      const result = await sql<{ id: string }>`
        UPDATE chat_turns
           SET status = 'interrupted',
               error = ${options.error},
               tool_permission = NULL,
               suspended_at = NULL,
               finished_at = NOW(),
               updated_at = NOW()
         WHERE status = 'running'
           AND kind = 'reply'
           AND resume_count >= ${options.maxResumes}
           AND (suspended_at IS NOT NULL
                OR updated_at < NOW() - make_interval(secs => ${options.staleSeconds}))
        RETURNING id
      `.execute(db());
      const ids = result.rows.map((row) => row.id).sort();
      if (ids.length > 0) {
        await db()
          .updateTable('chat_messages')
          .set({ status: 'interrupted', updated_at: sql<Date>`NOW()` })
          .where('turn_id', 'in', ids)
          .where('status', '=', 'streaming')
          .execute();
      }
      return ids;
    },
    async requestTurnCancel(chatId, turnId) {
      const result = await db()
        .updateTable('chat_turns')
        .set({ cancel_requested_at: sql<Date>`NOW()` })
        .where('chat_id', '=', chatId)
        .where('id', '=', turnId)
        .where('status', '=', 'running')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async setToolPermission(turnId, ask) {
      await db()
        .updateTable('chat_turns')
        .set({ tool_permission: JSON.stringify(ask), updated_at: sql<Date>`NOW()` })
        .where('id', '=', turnId)
        .where('status', '=', 'running')
        .execute();
    },
    async decideToolPermission(chatId, turnId, toolUseId, answer) {
      const result = await db()
        .updateTable('chat_turns')
        .set({
          tool_permission: sql`tool_permission || ${JSON.stringify({
            decision: answer.decision,
            decidedAt: answer.decidedAt,
          })}::jsonb`,
        })
        .where('chat_id', '=', chatId)
        .where('id', '=', turnId)
        .where('status', '=', 'running')
        .where(sql`tool_permission->>'toolUseId'`, '=', toolUseId)
        .where(sql`tool_permission->>'decision'`, 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async getToolPermission(turnId) {
      const row = await db()
        .selectFrom('chat_turns')
        .select('tool_permission')
        .where('id', '=', turnId)
        .executeTakeFirst();
      return row?.tool_permission ?? null;
    },
    async clearToolPermission(turnId) {
      await db()
        .updateTable('chat_turns')
        .set({ tool_permission: null })
        .where('id', '=', turnId)
        .execute();
    },
    async insertSummary(summary) {
      const inserted = await db()
        .insertInto('chat_summaries')
        .values({
          chat_id: summary.chatId,
          content: summary.content,
          through_seq: summary.throughSeq,
          folded_count: summary.foldedCount,
          created_by: summary.createdBy,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      // Summary first, then the attribution: a crash between the two
      // leaves the folded messages present AND summarized — sent again
      // once, harmlessly — never dropped from the conversation.
      if (summary.messageIds.length > 0) {
        await db()
          .updateTable('chat_messages')
          .set({ summary_id: inserted.id })
          .where('id', 'in', summary.messageIds)
          .execute();
      }
      return inserted.id;
    },
    async recordWidgetDecision(decision) {
      await db()
        .insertInto('chat_widget_decisions')
        .values({
          chat_id: decision.chatId,
          state_key: decision.stateKey,
          decision: decision.decision,
          state: JSON.stringify(decision.state),
          decided_by: decision.decidedBy,
        })
        .onConflict((oc) => oc.columns(['state_key']).doNothing())
        .execute();
    },
    async searchMessages(chatIds, options) {
      if (chatIds.length === 0 || options.kinds.length === 0) return [];
      const rows = await db()
        .selectFrom('chat_messages')
        .innerJoin('chats', 'chats.id', 'chat_messages.chat_id')
        .select([
          'chat_messages.id as id',
          'chat_messages.chat_id as chat_id',
          'chat_messages.content as content',
        ])
        .where('chat_messages.chat_id', 'in', chatIds)
        .where('chat_messages.kind', 'in', options.kinds)
        .orderBy('chats.updated_at', 'desc')
        .orderBy('chats.id')
        .orderBy('chat_messages.seq', 'desc')
        .limit(options.limit)
        .offset(options.offset)
        .execute();
      return rows.map((row) => ({ id: row.id, chatId: row.chat_id, content: row.content }));
    },
    async startSubagentRun(run) {
      const inserted = await db()
        .insertInto('chat_subagent_runs')
        .values({
          chat_id: run.chatId,
          turn_id: run.turnId,
          tool_use_id: run.toolUseId,
          task: run.task,
          instructions: run.instructions,
          read_only: run.readOnly,
          max_steps: run.maxSteps,
          llm_model_id: run.llmModelId,
          provider: run.provider,
          model: run.model,
        })
        // A tool_use id is unique per chat; a retry of the same call replaces its row.
        .onConflict((oc) =>
          oc.columns(['chat_id', 'tool_use_id']).doUpdateSet({
            turn_id: run.turnId,
            status: 'running',
            task: run.task,
            instructions: run.instructions,
            read_only: run.readOnly,
            max_steps: run.maxSteps,
            llm_model_id: run.llmModelId,
            provider: run.provider,
            model: run.model,
            steps: 0,
            tool_calls: 0,
            last_tool: null,
            transcript: null,
            report: null,
            error: null,
            input_tokens: 0,
            output_tokens: 0,
            started_at: sql<Date>`NOW()`,
            updated_at: sql<Date>`NOW()`,
            finished_at: null,
          })
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      return inserted.id;
    },
    async progressSubagentRun(runId, state) {
      await db()
        .updateTable('chat_subagent_runs')
        .set({
          steps: state.steps,
          tool_calls: state.toolCalls,
          last_tool: state.lastTool,
          input_tokens: sql<number>`input_tokens + ${state.inputTokens}`,
          output_tokens: sql<number>`output_tokens + ${state.outputTokens}`,
          updated_at: sql<Date>`NOW()`,
        })
        .where('id', '=', runId)
        .where('status', '=', 'running')
        .execute();
    },
    async finishSubagentRun(runId, outcome) {
      await db()
        .updateTable('chat_subagent_runs')
        .set({
          status: outcome.status,
          steps: outcome.steps,
          tool_calls: outcome.toolCalls,
          transcript: outcome.transcript,
          report: outcome.report,
          error: outcome.error,
          updated_at: sql<Date>`NOW()`,
          finished_at: sql<Date>`NOW()`,
        })
        .where('id', '=', runId)
        .execute();
    },
    async interruptSubagentRuns(turnId, error) {
      await db()
        .updateTable('chat_subagent_runs')
        .set({
          status: 'interrupted',
          error,
          updated_at: sql<Date>`NOW()`,
          finished_at: sql<Date>`NOW()`,
        })
        .where('turn_id', '=', turnId)
        .where('status', '=', 'running')
        .execute();
    },
    async getSubagentRunByCall(chatId, toolUseId) {
      const row = await db()
        .selectFrom('chat_subagent_runs')
        // The config's label as it reads today; the name columns are the
        // record, and stand alone once the config is gone.
        .leftJoin('llm_model_configs', 'llm_model_configs.id', 'chat_subagent_runs.llm_model_id')
        .selectAll('chat_subagent_runs')
        .select('llm_model_configs.label as model_label')
        .where('chat_subagent_runs.chat_id', '=', chatId)
        .where('chat_subagent_runs.tool_use_id', '=', toolUseId)
        .executeTakeFirst();
      return row ? subagentRunFromRow({ ...row, model_label: row.model_label ?? null }) : null;
    },
  };
}
