import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { CHAT, at, chatWorld, uid } from '../chats/fixtures';

const TURN = { done: uid(501), running: uid(502), other: uid(503) };

function message(n: number, chatId: string, seq: number, turnId: string | null) {
  return {
    id: uid(600 + n),
    chat_id: chatId,
    turn_id: turnId,
    seq,
    role: seq % 2 ? 'user' : 'assistant',
    kind: seq % 2 ? 'prompt' : 'assistant',
    content: `sealed-${n}`,
    usage: n === 2 ? JSON.stringify({ inputTokens: 5, outputTokens: 7 }) : null,
    timing: n === 2 ? JSON.stringify({ durationMs: 10 }) : null,
    created_at: at(seq),
    updated_at: at(seq),
  };
}

const fixture = {
  ...chatWorld(),
  chat_turns: [
    {
      id: TURN.done,
      chat_id: CHAT.annA,
      status: 'complete',
      input_tokens: 5,
      output_tokens: 7,
      started_at: at(1),
      updated_at: at(2),
      finished_at: at(2),
    },
    {
      id: TURN.running,
      chat_id: CHAT.annA,
      status: 'running',
      tool_permission: JSON.stringify({ toolUseId: 't', decision: null }),
      runner: JSON.stringify({ subject: 'ann' }),
      started_at: at(3),
      updated_at: at(4),
    },
    {
      id: TURN.other,
      chat_id: CHAT.annB,
      status: 'failed',
      error: 'boom',
      started_at: at(1),
      updated_at: at(1),
    },
  ],
  chat_messages: [
    message(3, CHAT.annA, 3, TURN.running),
    message(1, CHAT.annA, 1, TURN.done),
    message(2, CHAT.annA, 2, TURN.done),
    message(4, CHAT.annB, 1, TURN.other),
  ],
  chat_summaries: [
    {
      id: uid(701),
      chat_id: CHAT.annA,
      content: 'old',
      through_seq: 1,
      folded_count: 1,
      created_by: 'auto',
      created_at: at(5),
    },
    {
      id: uid(702),
      chat_id: CHAT.annA,
      content: 'new',
      through_seq: 2,
      folded_count: 2,
      created_by: 'user',
      created_at: at(6),
    },
  ],
  chat_widget_decisions: [
    {
      state_key: 'b-key',
      chat_id: CHAT.annA,
      decided_by: 'ann',
      decision: 'confirmed',
      state: JSON.stringify({ icon: 'sent', headline: 'Sent' }),
    },
    {
      state_key: 'a-key',
      chat_id: CHAT.annA,
      decided_by: 'ann',
      decision: 'cancelled',
      state: JSON.stringify({ icon: 'cancelled', headline: 'No' }),
    },
    {
      state_key: 'c-key',
      chat_id: CHAT.annB,
      decided_by: 'ann',
      decision: 'cancelled',
      state: JSON.stringify({ icon: 'cancelled', headline: 'Other' }),
    },
  ],
  chat_drafts: [{ chat_id: CHAT.annA, content: 'sealed-draft' }],
  chat_queued_sends: [{ chat_id: CHAT.annA, queue: JSON.stringify([{ id: 1, kind: 'compact' }]) }],
};

export const chatThreadScenarios: Scenario<DataStore>[] = [
  {
    method: 'chatThreads.listMessages',
    name: 'in seq order, JSON parsed, per chat',
    fixture,
    run: async (store) => [
      await store.chatThreads.listMessages(CHAT.annA),
      (await store.chatThreads.listMessages(CHAT.annB)).map((m) => m.id),
      await store.chatThreads.listMessages(CHAT.catPrivate),
    ],
  },
  {
    method: 'chatThreads.listTurnMessages',
    name: "one turn's messages in order",
    fixture,
    run: async (store) => [
      (await store.chatThreads.listTurnMessages(TURN.done)).map((m) => m.id),
      (await store.chatThreads.listTurnMessages(TURN.running)).map((m) => m.seq),
      await store.chatThreads.listTurnMessages(uid(999)),
    ],
  },
  {
    method: 'chatThreads.getActiveTurn',
    name: 'the running one, or null',
    fixture,
    run: async (store) => [
      await store.chatThreads.getActiveTurn(CHAT.annA),
      await store.chatThreads.getActiveTurn(CHAT.annB),
    ],
  },
  {
    method: 'chatThreads.getTurn',
    name: "only the chat's own turn",
    fixture,
    run: async (store) => [
      await store.chatThreads.getTurn(CHAT.annB, TURN.other),
      await store.chatThreads.getTurn(CHAT.annA, TURN.other),
      (await store.chatThreads.getTurn(CHAT.annA, TURN.done))?.finishedAt,
    ],
  },
  {
    method: 'chatThreads.latestSummary',
    name: 'newest only',
    fixture,
    run: async (store) => [
      await store.chatThreads.latestSummary(CHAT.annA),
      await store.chatThreads.latestSummary(CHAT.annB),
    ],
  },
  {
    method: 'chatThreads.listWidgetDecisions',
    name: 'per chat by key',
    fixture,
    run: async (store) => [
      await store.chatThreads.listWidgetDecisions(CHAT.annA),
      await store.chatThreads.listWidgetDecisions(CHAT.catPrivate),
    ],
  },
  {
    method: 'chatThreads.getWidgetDecision',
    name: 'by key',
    fixture,
    run: async (store) => [
      await store.chatThreads.getWidgetDecision('c-key'),
      await store.chatThreads.getWidgetDecision('missing'),
    ],
  },
  {
    method: 'chatThreads.getDraft',
    name: 'saved or none',
    fixture,
    run: async (store) => [
      await store.chatThreads.getDraft(CHAT.annA),
      await store.chatThreads.getDraft(CHAT.annB),
    ],
  },
  {
    method: 'chatThreads.saveDraft',
    name: 'insert then replace; a missing chat is refused',
    fixture,
    run: async (store) => {
      await store.chatThreads.saveDraft(CHAT.annB, 'one');
      await store.chatThreads.saveDraft(CHAT.annB, 'two');
      await store.chatThreads.saveDraft(CHAT.annA, 'three');
      const refused = await store.chatThreads.saveDraft(uid(999), 'x').then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      );
      return [
        await store.chatThreads.getDraft(CHAT.annB),
        await store.chatThreads.getDraft(CHAT.annA),
        refused,
      ];
    },
  },
  {
    method: 'chatThreads.deleteDraft',
    name: 'gone, others kept',
    fixture: {
      ...fixture,
      chat_drafts: [...fixture.chat_drafts, { chat_id: CHAT.annB, content: 'b' }],
    },
    run: async (store) => {
      await store.chatThreads.deleteDraft(CHAT.annA);
      await store.chatThreads.deleteDraft(CHAT.catPrivate);
      return [
        await store.chatThreads.getDraft(CHAT.annA),
        await store.chatThreads.getDraft(CHAT.annB),
      ];
    },
  },
  {
    method: 'chatThreads.getQueue',
    name: 'parsed JSON or null',
    fixture,
    run: async (store) => [
      await store.chatThreads.getQueue(CHAT.annA),
      await store.chatThreads.getQueue(CHAT.annB),
    ],
  },
  {
    method: 'chatThreads.saveQueue',
    name: 'insert and replace',
    fixture,
    run: async (store) => {
      await store.chatThreads.saveQueue(CHAT.annB, [
        { id: 2, kind: 'message', input: { text: 'hi' } },
      ]);
      await store.chatThreads.saveQueue(CHAT.annA, []);
      return [
        await store.chatThreads.getQueue(CHAT.annB),
        await store.chatThreads.getQueue(CHAT.annA),
      ];
    },
  },
  {
    method: 'chatThreads.deleteQueue',
    name: 'gone',
    fixture,
    run: async (store) => {
      await store.chatThreads.deleteQueue(CHAT.annA);
      return store.chatThreads.getQueue(CHAT.annA);
    },
  },
  {
    method: 'chatThreads.interruptStaleTurns',
    name: 'running turns past the cutoff, with their streaming messages; as they were',
    fixture: {
      ...fixture,
      chat_turns: [
        ...fixture.chat_turns,
        {
          id: uid(511),
          chat_id: CHAT.annB,
          status: 'running',
          stage: 'tool:search',
          started_at: at(1),
          updated_at: at(2),
        },
      ],
      chat_messages: [
        ...fixture.chat_messages.map((m) =>
          m.turn_id === TURN.running ? { ...m, status: 'streaming' } : m
        ),
        { ...message(5, CHAT.annB, 2, uid(511)), status: 'streaming' },
        { ...message(6, CHAT.annB, 3, uid(511)), status: 'complete' },
      ],
    },
    run: async (store) => {
      const none = await store.chatThreads.interruptStaleTurns(at(2), 'stopped');
      const hit = await store.chatThreads.interruptStaleTurns(at(10), 'stopped');
      const again = await store.chatThreads.interruptStaleTurns(at(10), 'stopped');
      const turn = async (chatId: string, id: string) => {
        const row = await store.chatThreads.getTurn(chatId, id);
        return row && [row.status, row.error, row.finishedAt !== null];
      };
      return [
        none,
        hit,
        again,
        await turn(CHAT.annA, TURN.running),
        await turn(CHAT.annB, uid(511)),
        await turn(CHAT.annA, TURN.done),
        (await store.chatThreads.listTurnMessages(uid(511))).map((m) => m.status),
        (await store.chatThreads.listTurnMessages(TURN.running)).map((m) => m.status),
      ];
    },
  },
];
