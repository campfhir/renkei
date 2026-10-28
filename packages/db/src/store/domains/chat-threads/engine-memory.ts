import { orderBy } from '../../memory/order';
import { toJson, uniqueViolation, type MemoryTables, type Row } from '../../memory/tables';
import { messageFromRow, subagentRunFromRow, turnFromRow } from './record';
import type {
  ChatMessageInsert,
  ChatTurnEngineStore,
  ChatTurnInsert,
  InsertedChatMessage,
} from './engine-types';

/**
 * The turn engine over the memory tables. What Postgres gets from its
 * partial unique index (one running turn per chat), its row locks and its
 * transactions, a single synchronous process gets from checking first and
 * undoing what a failed multi-row write already did.
 */
export function memoryChatTurnEngine(tables: MemoryTables): ChatTurnEngineStore {
  const insertTurn = (turn: ChatTurnInsert): string => {
    const chatId = turn.chatId;
    if (tables.first('chat_turns', (r) => r.chat_id === chatId && r.status === 'running')) {
      // The duplicate-turn tripwire the chat's start-turn flow answers.
      throw uniqueViolation('chat_turns', 'chat_turns_one_running');
    }
    const now = new Date();
    return tables.insert('chat_turns', {
      id: globalThis.crypto.randomUUID(),
      chat_id: turn.chatId,
      status: 'running',
      kind: turn.kind,
      llm_model_id: turn.llmModelId,
      thinking_budget: turn.thinkingBudget,
      runner: turn.runner === null || turn.runner === undefined ? null : toJson(turn.runner),
      error: null,
      stage: null,
      stage_at: null,
      tool_permission: null,
      input_tokens: 0,
      output_tokens: 0,
      iterations: 0,
      resume_count: 0,
      cancel_requested_at: null,
      suspended_at: null,
      finished_at: null,
      started_at: now,
      updated_at: now,
    }).id;
  };

  const insertMessage = (message: ChatMessageInsert): InsertedChatMessage => {
    const chatId = message.chatId;
    const seq =
      tables
        .select('chat_messages', (r) => r.chat_id === chatId)
        .reduce((max, r) => Math.max(max, r.seq), 0) + 1;
    const row = tables.insert('chat_messages', {
      chat_id: message.chatId,
      turn_id: message.turnId,
      seq,
      role: message.role,
      kind: message.kind,
      status: message.status,
      content: message.content,
      llm_model_id: message.llmModelId ?? null,
      provider: message.provider ?? null,
      model: message.model ?? null,
      id: globalThis.crypto.randomUUID(),
      error: null,
      stop_reason: null,
      summary_id: null,
      timing: null,
      usage: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    return { id: row.id, seq: row.seq, createdAt: row.created_at };
  };

  const runningTurn = (turnId: string) => {
    const id = turnId;
    return (r: Row<'chat_turns'>) => r.id === id && r.status === 'running';
  };

  const orphaned = (staleSeconds: number) => {
    const cutoff = Date.now() - staleSeconds * 1000;
    return (r: Row<'chat_turns'>) =>
      r.status === 'running' &&
      r.kind === 'reply' &&
      (r.suspended_at !== null || r.updated_at.getTime() < cutoff);
  };

  return {
    async createTurn(turn) {
      return insertTurn(turn);
    },
    async openTurn(input) {
      const turnId = insertTurn(input.turn);
      const messages: InsertedChatMessage[] = [];
      try {
        for (const message of input.messages) {
          messages.push(insertMessage({ ...message, chatId: input.turn.chatId, turnId }));
        }
        const link = input.link;
        const target = link ? messages[link.messageIndex] : undefined;
        if (link && target && link.artifactIds.length > 0) {
          const chatId = input.turn.chatId;
          const ids = link.artifactIds.map((id) => id);
          tables.update(
            'artifacts',
            (r) =>
              r.chat_id === chatId && r.owner_subject === link.ownerSubject && ids.includes(r.id),
            { message_id: target.id }
          );
        }
      } catch (error) {
        // All or nothing, as the Postgres transaction is.
        const written = new Set(messages.map((message) => message.id));
        tables.delete('chat_messages', (r) => written.has(r.id));
        tables.delete('chat_turns', (r) => r.id === turnId);
        throw error;
      }
      return { turnId, messages };
    },
    async insertMessage(message) {
      return insertMessage(message);
    },
    async insertMessageWhenIdle(message) {
      const chatId = message.chatId;
      if (tables.first('chat_turns', (r) => r.chat_id === chatId && r.status === 'running')) {
        return null;
      }
      return insertMessage(message);
    },
    async getMessage(chatId, messageId) {
      const chat = chatId;
      const id = messageId;
      const row = tables.first('chat_messages', (r) => r.chat_id === chat && r.id === id);
      return row ? messageFromRow(row) : null;
    },
    async updateMessage(messageId, patch) {
      const id = messageId;
      tables.update('chat_messages', (r) => r.id === id, {
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.stopReason !== undefined ? { stop_reason: patch.stopReason } : {}),
        ...(patch.usage !== undefined
          ? { usage: patch.usage === null ? null : toJson(patch.usage) }
          : {}),
        ...(patch.timing !== undefined
          ? { timing: patch.timing === null ? null : toJson(patch.timing) }
          : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        updated_at: new Date(),
      });
    },
    async deleteMessage(messageId) {
      const id = messageId;
      tables.delete('chat_messages', (r) => r.id === id);
      // A file the message carried stays in the chat, unattached.
      tables.update('artifacts', (r) => r.message_id === id, { message_id: null });
    },
    async settleStreamingMessages(turnId, status) {
      const id = turnId;
      tables.update('chat_messages', (r) => r.turn_id === id && r.status === 'streaming', {
        status,
        updated_at: new Date(),
      });
    },
    async truncateFrom(chatId, fromSeq) {
      const chat = chatId;
      const doomed = tables.select('chat_messages', (r) => r.chat_id === chat && r.seq >= fromSeq);
      const messageIds = new Set(doomed.map((row) => row.id));
      const turnIds = new Set(doomed.flatMap((row) => (row.turn_id ? [row.turn_id] : [])));
      const artifacts = orderBy(
        tables.select(
          'artifacts',
          (r) =>
            r.chat_id === chat &&
            r.origin === 'model' &&
            r.message_id !== null &&
            messageIds.has(r.message_id)
        ),
        [(r) => r.id]
      );
      const artifactIds = new Set(artifacts.map((row) => row.id));
      tables.delete('artifacts', (r) => artifactIds.has(r.id));
      tables.delete('chat_messages', (r) => messageIds.has(r.id));
      tables.delete('chat_turns', (r) => r.chat_id === chat && turnIds.has(r.id));
      // Uploads the cut messages carried stay, unattached; the cut turns' subagents go.
      tables.update('artifacts', (r) => r.message_id !== null && messageIds.has(r.message_id), {
        message_id: null,
      });
      tables.delete('chat_subagent_runs', (r) => turnIds.has(r.turn_id));
      return artifacts.map((row) => ({ id: row.id, blobKey: row.blob_key }));
    },
    async heartbeatTurn(turnId, iterations, stage) {
      const now = new Date();
      const [row] = tables.update('chat_turns', runningTurn(turnId), (r) => ({
        updated_at: now,
        iterations,
        stage,
        stage_at: r.stage !== stage ? now : r.stage_at,
      }));
      return row !== undefined && row.cancel_requested_at !== null;
    },
    async finishTurn(turnId, outcome) {
      const now = new Date();
      tables.update('chat_turns', runningTurn(turnId), {
        status: outcome.status,
        error: outcome.error,
        iterations: outcome.iterations,
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
        tool_permission: null,
        updated_at: now,
        finished_at: now,
      });
    },
    async suspendTurn(turnId, iterations) {
      const now = new Date();
      tables.update('chat_turns', runningTurn(turnId), {
        suspended_at: now,
        iterations,
        stage: null,
        stage_at: null,
        updated_at: now,
      });
    },
    async claimResumableTurns(options) {
      const isOrphan = orphaned(options.staleSeconds);
      const due = orderBy(
        tables.select('chat_turns', (r) => isOrphan(r) && r.resume_count < options.maxResumes),
        [(r) => r.updated_at]
      ).slice(0, Math.max(0, options.limit));
      const ids = new Set(due.map((row) => row.id));
      const now = new Date();
      const claimed = tables.update(
        'chat_turns',
        (r) => ids.has(r.id),
        (r) => ({
          suspended_at: null,
          resume_count: r.resume_count + 1,
          tool_permission: null,
          stage: null,
          stage_at: null,
          updated_at: now,
        })
      );
      return orderBy(claimed, [(r) => r.started_at], [(r) => r.id]).map(turnFromRow);
    },
    async interruptExhaustedTurns(options) {
      const isOrphan = orphaned(options.staleSeconds);
      const now = new Date();
      const ended = tables.update(
        'chat_turns',
        (r) => isOrphan(r) && r.resume_count >= options.maxResumes,
        {
          status: 'interrupted',
          error: options.error,
          tool_permission: null,
          suspended_at: null,
          finished_at: now,
          updated_at: now,
        }
      );
      const ids = ended.map((row) => row.id).sort();
      const idSet = new Set(ids);
      tables.update(
        'chat_messages',
        (r) => r.turn_id !== null && idSet.has(r.turn_id) && r.status === 'streaming',
        { status: 'interrupted', updated_at: now }
      );
      return ids;
    },
    async requestTurnCancel(chatId, turnId) {
      const chat = chatId;
      const id = turnId;
      const updated = tables.update(
        'chat_turns',
        (r) => r.chat_id === chat && r.id === id && r.status === 'running',
        { cancel_requested_at: new Date() }
      );
      return updated.length > 0;
    },
    async setToolPermission(turnId, ask) {
      tables.update('chat_turns', runningTurn(turnId), {
        tool_permission: toJson(ask),
        updated_at: new Date(),
      });
    },
    async decideToolPermission(chatId, turnId, toolUseId, answer) {
      const chat = chatId;
      const id = turnId;
      const pendingFor = (value: unknown): Record<string, unknown> | null => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        const record: Record<string, unknown> = { ...value };
        const asked = record.toolUseId;
        const askedText =
          typeof asked === 'string'
            ? asked
            : asked === undefined || asked === null
              ? null
              : JSON.stringify(asked);
        if (askedText !== toolUseId) return null;
        return record.decision === undefined || record.decision === null ? record : null;
      };
      const updated = tables.update(
        'chat_turns',
        (r) =>
          r.chat_id === chat &&
          r.id === id &&
          r.status === 'running' &&
          pendingFor(r.tool_permission) !== null,
        (r) => ({
          tool_permission: toJson({
            ...pendingFor(r.tool_permission),
            decision: answer.decision,
            decidedAt: answer.decidedAt,
          }),
        })
      );
      return updated.length > 0;
    },
    async getToolPermission(turnId) {
      const id = turnId;
      return tables.first('chat_turns', (r) => r.id === id)?.tool_permission ?? null;
    },
    async clearToolPermission(turnId) {
      const id = turnId;
      tables.update('chat_turns', (r) => r.id === id, { tool_permission: null });
    },
    async insertSummary(summary) {
      const inserted = tables.insert('chat_summaries', {
        chat_id: summary.chatId,
        content: summary.content,
        through_seq: summary.throughSeq,
        folded_count: summary.foldedCount,
        created_by: summary.createdBy,
        id: globalThis.crypto.randomUUID(),
        created_at: new Date(),
      });
      const ids = new Set(summary.messageIds.map((id) => id));
      tables.update('chat_messages', (r) => ids.has(r.id), { summary_id: inserted.id });
      return inserted.id;
    },
    async recordWidgetDecision(decision) {
      tables.upsert(
        'chat_widget_decisions',
        {
          chat_id: decision.chatId,
          state_key: decision.stateKey,
          decision: decision.decision,
          state: toJson(decision.state),
          decided_by: decision.decidedBy,
          decided_at: new Date(),
        },
        ['state_key']
      );
    },
    async searchMessages(chatIds, options) {
      if (chatIds.length === 0 || options.kinds.length === 0) return [];
      const ids = new Set(chatIds);
      const chats = new Map(
        tables.select('chats', (r) => ids.has(r.id)).map((row) => [row.id, row])
      );
      const rows = tables
        .select('chat_messages', (r) => chats.has(r.chat_id) && options.kinds.includes(r.kind))
        .map((row) => ({ row, chat: chats.get(row.chat_id) }));
      return orderBy(
        rows,
        [(r) => r.chat?.updated_at, 'desc'],
        [(r) => r.row.chat_id],
        [(r) => r.row.seq, 'desc']
      )
        .slice(options.offset, options.offset + options.limit)
        .map(({ row }) => ({ id: row.id, chatId: row.chat_id, content: row.content }));
    },
    async startSubagentRun(run) {
      const now = new Date();
      const row = tables.upsert(
        'chat_subagent_runs',
        {
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
          id: globalThis.crypto.randomUUID(),
          status: 'running',
          steps: 0,
          tool_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          last_tool: null,
          report: null,
          transcript: null,
          error: null,
          finished_at: null,
          started_at: now,
          updated_at: now,
        },
        ['chat_id', 'tool_use_id'],
        {
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
          started_at: now,
          updated_at: now,
          finished_at: null,
        }
      );
      if (!row) throw new Error('chat_subagent_runs upsert returned nothing');
      return row.id;
    },
    async progressSubagentRun(runId, state) {
      const id = runId;
      tables.update(
        'chat_subagent_runs',
        (r) => r.id === id && r.status === 'running',
        (r) => ({
          steps: state.steps,
          tool_calls: state.toolCalls,
          last_tool: state.lastTool,
          input_tokens: r.input_tokens + state.inputTokens,
          output_tokens: r.output_tokens + state.outputTokens,
          updated_at: new Date(),
        })
      );
    },
    async finishSubagentRun(runId, outcome) {
      const id = runId;
      const now = new Date();
      tables.update('chat_subagent_runs', (r) => r.id === id, {
        status: outcome.status,
        steps: outcome.steps,
        tool_calls: outcome.toolCalls,
        transcript: outcome.transcript,
        report: outcome.report,
        error: outcome.error,
        updated_at: now,
        finished_at: now,
      });
    },
    async interruptSubagentRuns(turnId, error) {
      const id = turnId;
      const now = new Date();
      tables.update('chat_subagent_runs', (r) => r.turn_id === id && r.status === 'running', {
        status: 'interrupted',
        error,
        updated_at: now,
        finished_at: now,
      });
    },
    async getSubagentRunByCall(chatId, toolUseId) {
      const chat = chatId;
      const row = tables.first(
        'chat_subagent_runs',
        (r) => r.chat_id === chat && r.tool_use_id === toolUseId
      );
      if (!row) return null;
      const config = row.llm_model_id
        ? tables.first('llm_model_configs', (r) => r.id === row.llm_model_id)
        : undefined;
      return subagentRunFromRow({ ...row, model_label: config?.label ?? null });
    },
  };
}
