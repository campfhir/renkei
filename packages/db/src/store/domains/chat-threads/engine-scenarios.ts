import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, BOB, CHAT, FUTURE, at, chatWorld, uid } from '../chats/fixtures';
import type { ChatTurnRecord } from './types';

/** Turns, one running per chat at most (the partial unique index holds for the fixture too). */
const T = {
  done: uid(1501),
  live: uid(1502),
  suspended: uid(1503),
  stale: uid(1504),
  exhausted: uid(1505),
  compaction: uid(1506),
  staleOther: uid(1507),
};
const M = {
  donePrompt: uid(1601),
  doneReply: uid(1602),
  livePrompt: uid(1603),
  liveReply: uid(1604),
  exhaustedReply: uid(1605),
  suspendedPrompt: uid(1606),
};
const A = { model: uid(1701), upload: uid(1702), loose: uid(1703), bobs: uid(1704) };
const RUN = { live: uid(1801), done: uid(1802) };
const MODEL = uid(1901);

const ASK = {
  toolUseId: 'tu-1',
  messageId: M.liveReply,
  name: 'jira_create',
  requestedAt: '2026-01-01T00:03:00.000Z',
};

function turn(id: string, chatId: string, extra: Record<string, unknown>) {
  return { id, chat_id: chatId, started_at: at(1), updated_at: at(1), ...extra };
}

function message(id: string, chatId: string, seq: number, turnId: string | null, extra = {}) {
  return {
    id,
    chat_id: chatId,
    turn_id: turnId,
    seq,
    role: 'user',
    kind: 'prompt',
    content: `sealed-${seq}-${chatId.slice(-3)}`,
    created_at: at(seq),
    updated_at: at(seq),
    ...extra,
  };
}

function artifact(id: string, owner: string, extra: Record<string, unknown>) {
  return {
    id,
    owner_subject: owner,
    chat_id: CHAT.annA,
    blob_key: `blob/${id}`,
    filename: `${id.slice(-4)}.txt`,
    content_type: 'text/plain',
    size_bytes: '10',
    created_at: at(1),
    updated_at: at(1),
    ...extra,
  };
}

const fixture = {
  ...chatWorld(),
  llm_model_configs: [
    {
      id: MODEL,
      label: 'Fast',
      provider: 'anthropic',
      model: 'm-fast',
      encrypted_secrets: 'sealed',
    },
  ],
  chat_turns: [
    turn(T.done, CHAT.annA, { status: 'completed', finished_at: at(2), updated_at: at(2) }),
    turn(T.live, CHAT.annA, {
      status: 'running',
      stage: 'model',
      stage_at: at(3),
      iterations: 2,
      tool_permission: ASK,
      runner: { roles: ['renkei-user'], voice: false },
      started_at: at(3),
      updated_at: FUTURE,
    }),
    turn(T.suspended, CHAT.annB, {
      status: 'running',
      suspended_at: at(5),
      updated_at: at(5),
      started_at: at(4),
    }),
    turn(T.stale, CHAT.bobShared, { status: 'running', resume_count: 1, updated_at: at(2) }),
    turn(T.exhausted, CHAT.catPrivate, {
      status: 'running',
      resume_count: 3,
      updated_at: at(1),
      tool_permission: { ...ASK, toolUseId: 'tu-x' },
    }),
    turn(T.compaction, CHAT.annEmpty, { status: 'running', kind: 'compaction' }),
    turn(T.staleOther, CHAT.bobInAnnProject, { status: 'running', updated_at: at(3) }),
  ],
  chat_messages: [
    message(M.donePrompt, CHAT.annA, 1, T.done),
    message(M.doneReply, CHAT.annA, 2, T.done, { role: 'assistant', kind: 'assistant' }),
    message(M.livePrompt, CHAT.annA, 3, T.live),
    message(M.liveReply, CHAT.annA, 4, T.live, {
      role: 'assistant',
      kind: 'assistant',
      status: 'streaming',
    }),
    message(M.exhaustedReply, CHAT.catPrivate, 1, T.exhausted, {
      role: 'assistant',
      kind: 'assistant',
      status: 'streaming',
    }),
    message(M.suspendedPrompt, CHAT.annB, 1, T.suspended),
  ],
  artifacts: [
    artifact(A.model, ANN, { origin: 'model', message_id: M.liveReply }),
    artifact(A.upload, ANN, { origin: 'upload', message_id: M.livePrompt }),
    artifact(A.loose, ANN, { origin: 'upload', chat_id: CHAT.annCode }),
    artifact(A.bobs, BOB, { origin: 'upload', chat_id: CHAT.annCode }),
  ],
  chat_subagent_runs: [
    {
      id: RUN.live,
      chat_id: CHAT.annA,
      turn_id: T.live,
      tool_use_id: 'tu-sub',
      task: 'sealed-task',
      instructions: 'sealed-instr',
      max_steps: 10,
      steps: 2,
      input_tokens: 5,
      output_tokens: 6,
      llm_model_id: MODEL,
      provider: 'anthropic',
      model: 'm-fast',
      started_at: at(3),
      updated_at: at(3),
    },
    {
      id: RUN.done,
      chat_id: CHAT.annA,
      turn_id: T.done,
      tool_use_id: 'tu-old',
      task: 'sealed-old',
      status: 'completed',
      max_steps: 4,
      report: 'sealed-report',
      started_at: at(1),
      updated_at: at(2),
      finished_at: at(2),
    },
  ],
};

/** A turn without what a write stamped "now" (or a default made up). */
function shape(t: ChatTurnRecord | null) {
  if (!t) return null;
  return {
    chatId: t.chatId,
    status: t.status,
    kind: t.kind,
    llmModelId: t.llmModelId,
    thinkingBudget: t.thinkingBudget,
    iterations: t.iterations,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    error: t.error,
    stage: t.stage,
    staged: t.stageAt === null ? null : t.stageAt.getTime() === at(3).getTime() ? 'kept' : 'moved',
    toolPermission: t.toolPermission,
    resumeCount: t.resumeCount,
    runner: t.runner,
    canceled: t.cancelRequestedAt !== null,
    suspended: t.suspendedAt !== null,
    finished: t.finishedAt !== null,
  };
}

const code = (error: { code?: string }) => error.code ?? 'no-code';

/** The chat's messages as (seq, role, kind, status, content, turn) — ids and times left out. */
async function thread(store: DataStore, chatId: string) {
  return (await store.chatThreads.listMessages(chatId)).map((m) => ({
    seq: m.seq,
    role: m.role,
    kind: m.kind,
    status: m.status,
    content: m.content,
    turn: m.turnId === null || Object.values(T).includes(m.turnId) ? m.turnId : 'new',
    summary: m.summaryId,
    usage: m.usage,
    timing: m.timing,
    stopReason: m.stopReason,
    error: m.error,
  }));
}

export const chatTurnEngineScenarios: Scenario<DataStore>[] = [
  {
    method: 'chatThreads.createTurn',
    name: 'a running turn, refused while another runs',
    fixture,
    run: async (store) => {
      const id = await store.chatThreads.createTurn({
        chatId: CHAT.annArchived,
        kind: 'reply',
        llmModelId: MODEL,
        thinkingBudget: 1000,
        runner: { roles: ['a'], voice: true, timeZone: 'UTC' },
      });
      const again = await store.chatThreads
        .createTurn({
          chatId: CHAT.annArchived,
          kind: 'compaction',
          llmModelId: null,
          thinkingBudget: null,
          runner: null,
        })
        .then(() => 'accepted', code);
      return [shape(await store.chatThreads.getTurn(CHAT.annArchived, id)), again];
    },
  },
  {
    method: 'chatThreads.openTurn',
    name: 'turn, messages at the next seqs and the owner’s files linked',
    fixture,
    run: async (store) => {
      const opened = await store.chatThreads
        .openTurn({
          turn: {
            chatId: CHAT.annA,
            kind: 'reply',
            llmModelId: null,
            thinkingBudget: null,
            runner: null,
          },
          messages: [],
        })
        .then(() => 'accepted', code);
      const before = await thread(store, CHAT.annA);
      const done = await store.chatThreads.openTurn({
        turn: {
          chatId: CHAT.annArchived,
          kind: 'reply',
          llmModelId: MODEL,
          thinkingBudget: null,
          runner: { roles: [] },
        },
        messages: [
          { role: 'user', kind: 'prompt', status: 'complete', content: 'p1' },
          { role: 'user', kind: 'prompt', status: 'complete', content: 'p2' },
          {
            role: 'assistant',
            kind: 'assistant',
            status: 'streaming',
            content: 'a',
            llmModelId: MODEL,
            provider: 'anthropic',
            model: 'm-fast',
          },
        ],
      });
      const withFiles = await store.chatThreads.openTurn({
        turn: {
          chatId: CHAT.annCode,
          kind: 'reply',
          llmModelId: null,
          thinkingBudget: null,
          runner: null,
        },
        messages: [{ role: 'user', kind: 'prompt', status: 'complete', content: 'with files' }],
        link: { messageIndex: 0, ownerSubject: ANN, artifactIds: [A.loose, A.bobs] },
      });
      const artifacts = await store.artifacts.listByChat(CHAT.annCode);
      return [
        opened,
        before.length,
        done.messages.map((m) => m.seq),
        await thread(store, CHAT.annArchived),
        shape(await store.chatThreads.getActiveTurn(CHAT.annArchived)),
        withFiles.messages.map((m) => m.seq),
        await thread(store, CHAT.annCode),
        artifacts.map((a) => [a.id, a.messageId === withFiles.messages[0]?.id]),
      ];
    },
  },
  {
    method: 'chatThreads.insertMessage',
    name: 'at the next seq; first in an empty chat',
    fixture,
    run: async (store) => {
      const a = await store.chatThreads.insertMessage({
        chatId: CHAT.annA,
        turnId: T.live,
        role: 'user',
        kind: 'tool_results',
        status: 'complete',
        content: 'r',
      });
      const b = await store.chatThreads.insertMessage({
        chatId: CHAT.annEmpty,
        turnId: null,
        role: 'user',
        kind: 'note',
        status: 'complete',
        content: 'n',
      });
      return [a.seq, b.seq, await thread(store, CHAT.annA), await thread(store, CHAT.annEmpty)];
    },
  },
  {
    method: 'chatThreads.insertMessageWhenIdle',
    name: 'refused while a turn runs, appended otherwise',
    fixture,
    run: async (store) => {
      const busy = await store.chatThreads.insertMessageWhenIdle({
        chatId: CHAT.annA,
        turnId: null,
        role: 'user',
        kind: 'note',
        status: 'complete',
        content: 'n',
      });
      const idle = await store.chatThreads.insertMessageWhenIdle({
        chatId: CHAT.annArchived,
        turnId: null,
        role: 'user',
        kind: 'note',
        status: 'complete',
        content: 'n',
      });
      return [busy, idle?.seq, await thread(store, CHAT.annArchived)];
    },
  },
  {
    method: 'chatThreads.getMessage',
    name: "only the chat's own",
    fixture,
    run: async (store) => [
      await store.chatThreads.getMessage(CHAT.annA, M.livePrompt),
      await store.chatThreads.getMessage(CHAT.annB, M.livePrompt),
      await store.chatThreads.getMessage(CHAT.annA, uid(999)),
    ],
  },
  {
    method: 'chatThreads.updateMessage',
    name: 'only the fields given',
    fixture,
    run: async (store) => {
      await store.chatThreads.updateMessage(M.liveReply, {
        content: 'flushed',
        status: 'complete',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 2 },
        timing: { durationMs: 5, firstTokenMs: null },
      });
      await store.chatThreads.updateMessage(M.doneReply, { error: 'late' });
      await store.chatThreads.updateMessage(M.liveReply, { usage: null });
      return thread(store, CHAT.annA);
    },
  },
  {
    method: 'chatThreads.deleteMessage',
    name: 'that one row',
    fixture,
    run: async (store) => {
      await store.chatThreads.deleteMessage(M.liveReply);
      await store.chatThreads.deleteMessage(uid(999));
      return [await thread(store, CHAT.annA), await store.artifacts.get(A.model)];
    },
  },
  {
    method: 'chatThreads.settleStreamingMessages',
    name: "only the turn's streaming rows",
    fixture,
    run: async (store) => {
      await store.chatThreads.settleStreamingMessages(T.live, 'canceled');
      await store.chatThreads.settleStreamingMessages(T.done, 'failed');
      return [await thread(store, CHAT.annA), await thread(store, CHAT.catPrivate)];
    },
  },
  {
    method: 'chatThreads.truncateFrom',
    name: "messages from the seq on, the model's files on them, and their turns",
    fixture,
    run: async (store) => {
      const none = await store.chatThreads.truncateFrom(CHAT.annA, 9);
      const removed = await store.chatThreads.truncateFrom(CHAT.annA, 3);
      return [
        none,
        removed,
        await thread(store, CHAT.annA),
        (await store.artifacts.listByChat(CHAT.annA)).map((a) => [a.id, a.messageId]),
        await store.chatThreads.getTurn(CHAT.annA, T.live),
        shape(await store.chatThreads.getTurn(CHAT.annA, T.done)),
        await store.chatThreads.getSubagentRunByCall(CHAT.annA, 'tu-sub'),
      ];
    },
  },
  {
    method: 'chatThreads.heartbeatTurn',
    name: 'stage time moves only on a new stage; a cancel shows; a settled turn says no',
    fixture,
    run: async (store) => {
      const first = await store.chatThreads.heartbeatTurn(T.live, 3, 'model');
      const kept = shape(await store.chatThreads.getTurn(CHAT.annA, T.live));
      await store.chatThreads.requestTurnCancel(CHAT.annA, T.live);
      const second = await store.chatThreads.heartbeatTurn(T.live, 4, 'tool:jira');
      const moved = shape(await store.chatThreads.getTurn(CHAT.annA, T.live));
      const settled = await store.chatThreads.heartbeatTurn(T.done, 9, null);
      return [
        first,
        kept,
        second,
        moved,
        settled,
        shape(await store.chatThreads.getTurn(CHAT.annA, T.done)),
      ];
    },
  },
  {
    method: 'chatThreads.finishTurn',
    name: 'a running turn ends, its ask cleared; a settled one stays',
    fixture,
    run: async (store) => {
      const outcome = {
        status: 'failed',
        error: 'boom',
        iterations: 5,
        inputTokens: 7,
        outputTokens: 8,
      };
      await store.chatThreads.finishTurn(T.live, outcome);
      await store.chatThreads.finishTurn(T.done, outcome);
      return [
        shape(await store.chatThreads.getTurn(CHAT.annA, T.live)),
        shape(await store.chatThreads.getTurn(CHAT.annA, T.done)),
        await store.chatThreads.getActiveTurn(CHAT.annA),
      ];
    },
  },
  {
    method: 'chatThreads.suspendTurn',
    name: 'marked, no stage',
    fixture,
    run: async (store) => {
      await store.chatThreads.suspendTurn(T.live, 6);
      await store.chatThreads.suspendTurn(T.done, 6);
      return [
        shape(await store.chatThreads.getTurn(CHAT.annA, T.live)),
        shape(await store.chatThreads.getTurn(CHAT.annA, T.done)),
      ];
    },
  },
  {
    method: 'chatThreads.claimResumableTurns',
    name: 'suspended or stale replies under the budget, oldest heartbeat first, up to the limit',
    fixture,
    run: async (store) => {
      const options = { staleSeconds: 60, maxResumes: 3 };
      const first = await store.chatThreads.claimResumableTurns({ ...options, limit: 2 });
      const rest = await store.chatThreads.claimResumableTurns({ ...options, limit: 10 });
      const none = await store.chatThreads.claimResumableTurns({ ...options, limit: 10 });
      return [
        first.map((t) => [t.id, shape(t)]),
        rest.map((t) => [t.id, shape(t)]),
        none,
        shape(await store.chatThreads.getTurn(CHAT.annA, T.live)),
        shape(await store.chatThreads.getTurn(CHAT.annEmpty, T.compaction)),
        shape(await store.chatThreads.getTurn(CHAT.catPrivate, T.exhausted)),
      ];
    },
  },
  {
    method: 'chatThreads.interruptExhaustedTurns',
    name: 'only orphans past the budget, with their streaming rows',
    fixture,
    run: async (store) => {
      const ended = await store.chatThreads.interruptExhaustedTurns({
        staleSeconds: 60,
        maxResumes: 1,
        error: 'gave up',
      });
      return [
        ended,
        shape(await store.chatThreads.getTurn(CHAT.catPrivate, T.exhausted)),
        shape(await store.chatThreads.getTurn(CHAT.annB, T.suspended)),
        await thread(store, CHAT.catPrivate),
        await store.chatThreads.interruptExhaustedTurns({
          staleSeconds: 60,
          maxResumes: 1,
          error: 'again',
        }),
      ];
    },
  },
  {
    method: 'chatThreads.requestTurnCancel',
    name: "the chat's running turn only",
    fixture,
    run: async (store) => [
      await store.chatThreads.requestTurnCancel(CHAT.annB, T.live),
      await store.chatThreads.requestTurnCancel(CHAT.annA, T.done),
      await store.chatThreads.requestTurnCancel(CHAT.annA, T.live),
      shape(await store.chatThreads.getTurn(CHAT.annA, T.live)),
    ],
  },
  {
    method: 'chatThreads.setToolPermission',
    name: 'on a running turn only',
    fixture,
    run: async (store) => {
      const ask = { ...ASK, toolUseId: 'tu-2', decision: null, decidedAt: null };
      await store.chatThreads.setToolPermission(T.suspended, ask);
      await store.chatThreads.setToolPermission(T.done, ask);
      return [
        await store.chatThreads.getToolPermission(T.suspended),
        await store.chatThreads.getToolPermission(T.done),
      ];
    },
  },
  {
    method: 'chatThreads.decideToolPermission',
    name: 'only the pending ask for that call, once',
    fixture,
    run: async (store) => {
      const answer = { decision: 'once', decidedAt: '2026-01-01T00:04:00.000Z' };
      return [
        await store.chatThreads.decideToolPermission(CHAT.annA, T.live, 'tu-other', answer),
        await store.chatThreads.decideToolPermission(CHAT.annB, T.live, 'tu-1', answer),
        await store.chatThreads.decideToolPermission(CHAT.annA, T.done, 'tu-1', answer),
        await store.chatThreads.decideToolPermission(CHAT.annA, T.live, 'tu-1', answer),
        await store.chatThreads.decideToolPermission(CHAT.annA, T.live, 'tu-1', {
          ...answer,
          decision: 'deny',
        }),
        await store.chatThreads.getToolPermission(T.live),
      ];
    },
  },
  {
    method: 'chatThreads.getToolPermission',
    name: 'the ask as stored, or null',
    fixture,
    run: async (store) => [
      await store.chatThreads.getToolPermission(T.live),
      await store.chatThreads.getToolPermission(T.done),
      await store.chatThreads.getToolPermission(uid(999)),
    ],
  },
  {
    method: 'chatThreads.clearToolPermission',
    name: 'gone',
    fixture,
    run: async (store) => {
      await store.chatThreads.clearToolPermission(T.live);
      return [
        await store.chatThreads.getToolPermission(T.live),
        await store.chatThreads.getToolPermission(T.exhausted),
      ];
    },
  },
  {
    method: 'chatThreads.insertSummary',
    name: 'the newest summary, its messages attributed',
    fixture,
    run: async (store) => {
      const id = await store.chatThreads.insertSummary({
        chatId: CHAT.annA,
        content: 'sealed-summary',
        throughSeq: 2,
        foldedCount: 2,
        createdBy: 'auto',
        messageIds: [M.donePrompt, M.doneReply],
      });
      await store.chatThreads.insertSummary({
        chatId: CHAT.annB,
        content: 'empty',
        throughSeq: 0,
        foldedCount: 0,
        createdBy: 'user',
        messageIds: [],
      });
      const latest = await store.chatThreads.latestSummary(CHAT.annA);
      return [
        latest?.id === id,
        latest?.content,
        latest?.throughSeq,
        (await thread(store, CHAT.annA)).map((m) => m.summary === id),
        (await store.chatThreads.latestSummary(CHAT.annB))?.createdBy,
      ];
    },
  },
  {
    method: 'chatThreads.recordWidgetDecision',
    name: 'the first decision for a key wins',
    fixture,
    run: async (store) => {
      const decision = {
        chatId: CHAT.annA,
        stateKey: 'card-1',
        decision: 'confirmed',
        state: { icon: 'sent', headline: 'Sent' },
        decidedBy: ANN,
      };
      await store.chatThreads.recordWidgetDecision(decision);
      await store.chatThreads.recordWidgetDecision({
        ...decision,
        decision: 'cancelled',
        state: { icon: 'cancelled', headline: 'No' },
      });
      return [
        await store.chatThreads.getWidgetDecision('card-1'),
        await store.chatThreads.listWidgetDecisions(CHAT.annA),
      ];
    },
  },
  {
    method: 'chatThreads.searchMessages',
    name: 'newest chat first (ties by id), newest message first, paged, kinds filtered',
    fixture,
    run: async (store) => {
      const chats = [CHAT.annA, CHAT.annB, CHAT.catPrivate];
      const all = await store.chatThreads.searchMessages(chats, {
        kinds: ['prompt', 'assistant'],
        limit: 50,
        offset: 0,
      });
      const page = await store.chatThreads.searchMessages(chats, {
        kinds: ['prompt'],
        limit: 2,
        offset: 1,
      });
      return [
        all,
        page,
        await store.chatThreads.searchMessages([], { kinds: ['prompt'], limit: 5, offset: 0 }),
        await store.chatThreads.searchMessages(chats, { kinds: [], limit: 5, offset: 0 }),
      ];
    },
  },
  {
    method: 'chatThreads.startSubagentRun',
    name: 'a new run, and a retried call starting its row over',
    fixture,
    run: async (store) => {
      const start = {
        chatId: CHAT.annA,
        turnId: T.live,
        task: 'sealed-new',
        instructions: null,
        readOnly: true,
        maxSteps: 3,
        llmModelId: null,
        provider: null,
        model: null,
      };
      await store.chatThreads.startSubagentRun({ ...start, toolUseId: 'tu-new' });
      const again = await store.chatThreads.startSubagentRun({ ...start, toolUseId: 'tu-old' });
      const strip = (run: Awaited<ReturnType<DataStore['chatThreads']['getSubagentRunByCall']>>) =>
        run && {
          ...run,
          id: undefined,
          startedAt: undefined,
          updatedAt: undefined,
        };
      return [
        strip(await store.chatThreads.getSubagentRunByCall(CHAT.annA, 'tu-new')),
        again === RUN.done,
        strip(await store.chatThreads.getSubagentRunByCall(CHAT.annA, 'tu-old')),
      ];
    },
  },
  {
    method: 'chatThreads.progressSubagentRun',
    name: 'counters set, tokens added, a finished run left alone',
    fixture,
    run: async (store) => {
      const state = {
        steps: 3,
        toolCalls: 2,
        lastTool: 'code_read',
        inputTokens: 10,
        outputTokens: 1,
      };
      await store.chatThreads.progressSubagentRun(RUN.live, state);
      await store.chatThreads.progressSubagentRun(RUN.done, state);
      const pick = async (call: string) => {
        const run = await store.chatThreads.getSubagentRunByCall(CHAT.annA, call);
        return run && [run.steps, run.toolCalls, run.lastTool, run.inputTokens, run.outputTokens];
      };
      return [await pick('tu-sub'), await pick('tu-old')];
    },
  },
  {
    method: 'chatThreads.finishSubagentRun',
    name: 'its ending, transcript and report',
    fixture,
    run: async (store) => {
      await store.chatThreads.finishSubagentRun(RUN.live, {
        status: 'completed',
        steps: 4,
        toolCalls: 3,
        transcript: 'sealed-transcript',
        report: 'sealed-r',
        error: null,
      });
      const run = await store.chatThreads.getSubagentRunByCall(CHAT.annA, 'tu-sub');
      return (
        run && [
          run.status,
          run.steps,
          run.toolCalls,
          run.transcript,
          run.report,
          run.finishedAt !== null,
        ]
      );
    },
  },
  {
    method: 'chatThreads.interruptSubagentRuns',
    name: "the turn's running runs only",
    fixture,
    run: async (store) => {
      await store.chatThreads.interruptSubagentRuns(T.live, 'turn ended');
      await store.chatThreads.interruptSubagentRuns(T.done, 'turn ended');
      const pick = async (call: string) => {
        const run = await store.chatThreads.getSubagentRunByCall(CHAT.annA, call);
        return run && [run.status, run.error, run.finishedAt !== null];
      };
      return [await pick('tu-sub'), await pick('tu-old')];
    },
  },
  {
    method: 'chatThreads.getSubagentRunByCall',
    name: "with the model's label as it reads now; per chat",
    fixture,
    run: async (store) => [
      await store.chatThreads.getSubagentRunByCall(CHAT.annA, 'tu-sub'),
      await store.chatThreads.getSubagentRunByCall(CHAT.annA, 'tu-old'),
      await store.chatThreads.getSubagentRunByCall(CHAT.annB, 'tu-sub'),
    ],
  },
];
