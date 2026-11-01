/**
 * A card's decision, told to the model (POST …/widget/model-context), on
 * the memory store: the note it becomes, and when it opens the model's
 * turn. One reply presenting two cards opens exactly one turn, once both
 * are decided — the model must not answer having seen only one of them
 * (widget-tools.ts's waitingOnSiblings). This was widget-card.spec.ts's
 * "two cards from one reply" test; widget-tools.db.test.ts runs the same
 * rule against Postgres.
 *
 * Starting a turn reaches the model and the runner, which are not under
 * test: `startChatTurn` is replaced by one that writes the turn and its
 * note row the way it does, so the turns can be counted. The chat's key
 * is a fresh one rather than the delegate's.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/chat/chat-keys', () => ({ chatCipherById: jest.fn() }));
jest.mock('@/lib/chat/start-turn', () => ({ startChatTurn: jest.fn() }));

import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { ok } from '@campfhir/safe-functions/helpers';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { resourceCipher } from '@/lib/chat/content-crypto';
import { insertMessage } from '@/lib/chat/messages';
import { recordWidgetDecision } from '@/lib/chat/widget-tools';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { chatCipherById: mockChatCipher } = jest.requireMock<{ chatCipherById: jest.Mock }>(
  '@/lib/chat/chat-keys'
);
const { startChatTurn: mockStartChatTurn } = jest.requireMock<{ startChatTurn: jest.Mock }>(
  '@/lib/chat/start-turn'
);

const ME = 'alice';
const cipher = resourceCipher({ id: randomUUID(), key: randomBytes(32) });

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: [] });
  mockChatCipher.mockResolvedValue(cipher);
  // The turn and its note row, as startChatTurn writes them.
  mockStartChatTurn.mockImplementation(async (input: { chatId: string; text: string }) => {
    const turnId = await getDataStore().chatThreads.createTurn({
      chatId: input.chatId,
      kind: 'reply',
      llmModelId: null,
      thinkingBudget: null,
      runner: null,
    });
    const note = await insertMessage({
      chatId: input.chatId,
      turnId,
      role: 'user',
      kind: 'note',
      status: 'complete',
      blocks: [{ type: 'text', text: input.text }],
      cipher,
    });
    if (!note) throw new Error('note not written');
    return ok({
      turnId,
      userMessageId: note.id,
      userMessageSeq: note.seq,
      userMessageCreatedAt: note.createdAt.toISOString(),
      assistantMessageId: randomUUID(),
    });
  });
});

afterEach(() => resetDataStore());

async function newChat(owner = ME): Promise<string> {
  return getDataStore().chats.create({
    ownerSubject: owner,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
  });
}

/** A finished reply that presented one card per preview id; its turn id. */
async function replyWithCards(chatId: string, previewIds: string[]): Promise<string> {
  const store = getDataStore();
  const turnId = await store.chatThreads.createTurn({
    chatId,
    kind: 'reply',
    llmModelId: null,
    thinkingBudget: null,
    runner: null,
  });
  const ids = previewIds.map(() => `toolu_${randomUUID()}`);
  await insertMessage({
    chatId,
    turnId,
    role: 'assistant',
    kind: 'assistant',
    status: 'complete',
    cipher,
    blocks: [
      { type: 'text', text: 'Two previews — nothing is created until you confirm each.' },
      ...ids.map((id) => ({
        type: 'tool_use' as const,
        id,
        name: 'jira_create_issue_preview',
        input: {},
      })),
    ],
  });
  await insertMessage({
    chatId,
    turnId,
    role: 'user',
    kind: 'tool_results',
    status: 'complete',
    cipher,
    blocks: ids.map((toolUseId, i) => ({
      type: 'tool_result' as const,
      toolUseId,
      content: 'Awaiting the user’s decision on the preview card.',
      uiResourceUri: 'ui://widget/issue-preview.test.html',
      structuredContent: { kind: 'issue', previewId: previewIds[i] },
    })),
  });
  await store.chatThreads.finishTurn(turnId, {
    status: 'completed',
    error: null,
    iterations: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  return turnId;
}

/** The card's two reports, in the order its finishDone sends them. */
async function decide(chatId: string, previewId: string, text: string): Promise<Response> {
  const stateKey = `renkei-preview:${previewId}`;
  await recordWidgetDecision({
    chatId,
    subject: ME,
    stateKey,
    decision: 'confirmed',
    state: { icon: 'sent', headline: 'Created issue OPS-99.' },
  });
  return POST(
    new NextRequest('http://test.local/model-context', {
      method: 'POST',
      body: JSON.stringify({ text, stateKey }),
    }),
    { params: Promise.resolve({ chatId }) }
  );
}

async function turnIdsOf(chatId: string): Promise<string[]> {
  const messages = await getDataStore().chatThreads.listMessages(chatId);
  return [...new Set(messages.flatMap((m) => (m.turnId ? [m.turnId] : [])))];
}

async function notesOf(chatId: string): Promise<{ turnId: string | null }[]> {
  return (await getDataStore().chatThreads.listMessages(chatId))
    .filter((row) => row.kind === 'note')
    .map((row) => ({ turnId: row.turnId }));
}

const CONFIRMED_A = 'The user confirmed "Create Jira issue" on the preview card. Result: OPS-98.';
const CONFIRMED_B = 'The user confirmed "Create Jira issue" on the preview card. Result: OPS-99.';

describe('POST widget/model-context', () => {
  it('one card decided opens the model’s turn on its note at once', async () => {
    const chatId = await newChat();
    const reply = await replyWithCards(chatId, ['solo']);

    const response = await decide(chatId, 'solo', CONFIRMED_A);

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.turn).not.toBeNull();
    expect(body.message).toMatchObject({ kind: 'note', turnId: body.turn.turnId });
    expect(await turnIdsOf(chatId)).toEqual([reply, body.turn.turnId]);
  });

  it('two cards from one reply: the first decision is only a note, and the second opens exactly one turn', async () => {
    const chatId = await newChat();
    const reply = await replyWithCards(chatId, ['a', 'b']);

    const first = await decide(chatId, 'a', CONFIRMED_A);
    expect(first.status).toBe(200);
    expect((await first.json()).turn).toBeNull();
    expect(mockStartChatTurn).not.toHaveBeenCalled();
    expect(await turnIdsOf(chatId)).toEqual([reply]);
    expect(await notesOf(chatId)).toEqual([{ turnId: null }]);

    const second = await decide(chatId, 'b', CONFIRMED_B);
    expect(second.status).toBe(202);
    const opened = (await second.json()).turn.turnId;
    expect(mockStartChatTurn).toHaveBeenCalledTimes(1);
    expect(await turnIdsOf(chatId)).toEqual([reply, opened]);
    // Both notes are in the thread for the one reply to read.
    expect(await notesOf(chatId)).toEqual([{ turnId: null }, { turnId: opened }]);
  });

  it('a card whose sibling was decided first opens the turn itself, whichever order they land in', async () => {
    const chatId = await newChat();
    await replyWithCards(chatId, ['a', 'b']);

    expect((await decide(chatId, 'b', CONFIRMED_B)).status).toBe(200);
    expect((await decide(chatId, 'a', CONFIRMED_A)).status).toBe(202);
    expect(mockStartChatTurn).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty note, and someone else’s chat', async () => {
    const chatId = await newChat();
    await replyWithCards(chatId, ['solo']);
    expect((await decide(chatId, 'solo', '   ')).status).toBe(400);

    const theirs = await newChat('bob');
    expect((await decide(theirs, 'solo', CONFIRMED_A)).status).toBe(404);
    expect(mockStartChatTurn).not.toHaveBeenCalled();
  });
});
