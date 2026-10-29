/**
 * recordWidgetModelContext against a real database (skipped without
 * DATABASE_URL and TOKEN_ENCRYPTION_KEY): a preview card's decision is a
 * note row that opens a turn of its own — the model's cue to reply — a
 * running turn refuses it, and a chat with no usable model keeps the
 * note on its own, with no turn. The turn's model work is captured
 * through `defer` and never run: what is under test is the rows.
 */

import { randomUUID } from 'node:crypto';
import { invalidateLlmCache } from '@renkei/agent-llm';
import { closeDataStore, getDataStore } from '@renkei/db';
import { encrypt, parseEncryptionKey } from '@renkei/crypto';
import {
  getWidgetDecision,
  listWidgetDecisions,
  recordWidgetModelContext,
  recordWidgetDecision,
} from './widget-tools';
import { insertMessage } from './messages';
import { chatCipherById } from './chat-keys';

// The delegate is the one process that holds keys; the web app reaches it
// over HTTP, so these tests run it in-process on a loopback port, one per
// describe block (each block opens and closes its own database pool).
import { useTestDelegate } from '@/lib/test-support/delegate';

/** A chat row with no key yet (its owner's first access mints one), titled by its owner; its id. */
async function newChat(ownerSubject: string, title: string): Promise<string> {
  const store = getDataStore();
  const id = await store.chats.create({
    ownerSubject,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
  });
  await store.chats.update(ownerSubject, id, { title });
  return id;
}

/** An enabled default chat model, the way the admin page adds one; its id. */
async function addDefaultModel(label: string): Promise<string> {
  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY ?? '');
  if (!key.ok) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  const id = randomUUID();
  const created = await getDataStore().llmModels.create(id, {
    label,
    provider: 'anthropic',
    model: 'e2e-model',
    baseUrl: null,
    settings: {},
    encryptedSecrets: encrypt(JSON.stringify({ apiKey: 'test' }), key.val),
    enabled: true,
    isDefault: true,
  });
  if (created !== 'created') throw new Error(`model not created: ${created}`);
  return id;
}

/** Switch one model on or off, the admin page's edit with everything else kept. */
async function setModelEnabled(id: string, enabled: boolean): Promise<void> {
  const store = getDataStore();
  const model = await store.llmModels.get(id);
  if (!model) throw new Error('no such model');
  const settings =
    typeof model.settings === 'object' && model.settings !== null
      ? Object.fromEntries(Object.entries(model.settings))
      : {};
  await store.llmModels.update(id, {
    label: model.label,
    provider: model.provider,
    model: model.model,
    baseUrl: model.baseUrl,
    settings,
    encryptedSecrets: model.encryptedSecrets,
    enabled,
    isDefault: model.isDefault,
  });
}

/** The ids of the turns the chat's messages belong to, sorted. */
async function turnIdsOf(chatId: string): Promise<string[]> {
  const messages = await getDataStore().chatThreads.listMessages(chatId);
  return [...new Set(messages.flatMap((m) => (m.turnId ? [m.turnId] : [])))].sort();
}

const maybe =
  process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? describe : describe.skip;

maybe('recordWidgetModelContext', () => {
  const delegate = useTestDelegate();
  const suiteId = randomUUID();
  const me = `me-${suiteId.slice(0, 8)}`;
  let chatId = '';
  let modellessChatId = '';
  let modelId = '';
  const session: { subject: string; roles: string[] } = { subject: me, roles: [] };
  const deferred: Array<() => Promise<void>> = [];
  const defer = (task: () => Promise<void>) => {
    deferred.push(task);
  };
  const DECISION =
    'The user confirmed "Create Jira issue" on the preview card. Result: Created issue OPS-1.';

  beforeAll(async () => {
    // The default model is the organization's, cached: the block before
    // this one configured (and then removed) its own.
    invalidateLlmCache();
    await delegate.enroll(me);
    modelId = await addDefaultModel(`Card model ${suiteId}`);
    chatId = await newChat(me, 'Rotate the secret');
    modellessChatId = await newChat(me, 'No model here');
  });

  afterAll(async () => {
    const store = getDataStore();
    // A chat's messages, turns and decisions go with it.
    await store.chats.delete(me, chatId);
    await store.chats.delete(me, modellessChatId);
    await store.llmModels.delete(modelId);
    await closeDataStore();
  });

  it('records the decision as a note row that opens a turn of its own', async () => {
    const recorded = await recordWidgetModelContext({
      session,
      chatId,
      text: DECISION,
      defer,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.turn).not.toBeNull();
    expect(recorded.message.kind).toBe('note');
    expect(recorded.message.turnId).toBe(recorded.turn?.turnId ?? null);
    expect(recorded.message.blocks).toEqual([{ type: 'text', text: DECISION }]);
    // The model work was handed off, not run here.
    expect(deferred).toHaveLength(1);

    const store = getDataStore();
    const turn = await store.chatThreads.getTurn(chatId, recorded.turn?.turnId ?? '');
    expect(turn).toMatchObject({ status: 'running', kind: 'reply' });
    const rows = (await store.chatThreads.listMessages(chatId)).map((row) => ({
      role: row.role,
      kind: row.kind,
      status: row.status,
      turnId: row.turnId,
    }));
    expect(rows).toEqual([
      { role: 'user', kind: 'note', status: 'complete', turnId: recorded.turn?.turnId },
      { role: 'assistant', kind: 'assistant', status: 'streaming', turnId: recorded.turn?.turnId },
    ]);
  });

  it('refuses while that turn is still running, writing nothing', async () => {
    const recorded = await recordWidgetModelContext({
      session,
      chatId,
      text: 'The user cancelled "Create Jira issue" from the preview card. Nothing was written.',
      defer,
    });
    expect(recorded).toEqual({ ok: false, reason: 'turn-running' });
    const notes = (await getDataStore().chatThreads.listMessages(chatId)).filter(
      (row) => row.kind === 'note'
    );
    expect(notes).toHaveLength(1);
    expect(deferred).toHaveLength(1);
  });

  it('keeps the note without a turn when the organization has no usable model', async () => {
    // The one model switched off for the length of this test: the chat
    // (any chat) has nothing to answer with.
    await setModelEnabled(modelId, false);
    invalidateLlmCache();
    let recorded: Awaited<ReturnType<typeof recordWidgetModelContext>>;
    try {
      recorded = await recordWidgetModelContext({
        session,
        chatId: modellessChatId,
        text: DECISION,
        defer,
      });
    } finally {
      await setModelEnabled(modelId, true);
      invalidateLlmCache();
    }
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.turn).toBeNull();
    expect(recorded.message.kind).toBe('note');
    expect(recorded.message.turnId).toBeNull();
    const store = getDataStore();
    const rows = (await store.chatThreads.listMessages(modellessChatId)).map((row) => ({
      role: row.role,
      kind: row.kind,
      turnId: row.turnId,
    }));
    expect(rows).toEqual([{ role: 'user', kind: 'note', turnId: null }]);
    // No turn was opened: none is running, and no message belongs to one.
    expect(await store.chatThreads.getActiveTurn(modellessChatId)).toBeNull();
    expect(await turnIdsOf(modellessChatId)).toEqual([]);
    expect(deferred).toHaveLength(1);
  });
});

/**
 * A card's decision, durable across devices (chat_widget_decisions): the
 * write path a card's Confirm or Cancel reports through (widget-tools.ts's
 * `recordWidgetDecision`), and the two read paths that keep a second device
 * from re-showing live buttons — `getWidgetDecision` (confirmWidgetTool's
 * own guard against running a confirm tool twice) and `listWidgetDecisions`
 * (chat-view.ts's batch read for one chat's whole message list).
 */
maybe('chat widget decisions', () => {
  const delegate = useTestDelegate();
  const suiteId = randomUUID();
  const me = `me-${suiteId.slice(0, 8)}`;
  let chatId = '';
  let otherChatId = '';
  const stateKey = `renkei-preview:${randomUUID()}`;

  beforeAll(async () => {
    // The default model is the organization's, cached: the block before
    // this one configured (and then removed) its own.
    invalidateLlmCache();
    await delegate.enroll(me);
    chatId = await newChat(me, 'Rotate the secret');
    otherChatId = await newChat(me, 'A different chat');
  });

  afterAll(async () => {
    const store = getDataStore();
    await store.chats.delete(me, chatId);
    await store.chats.delete(me, otherChatId);
    await closeDataStore();
  });

  it('is absent until recorded', async () => {
    expect(await getWidgetDecision(stateKey)).toBeNull();
    expect(await listWidgetDecisions(chatId)).toEqual(new Map());
  });

  it('records a decision, readable by its own key and by its chat', async () => {
    const recorded = await recordWidgetDecision({
      chatId,
      subject: me,
      stateKey,
      decision: 'confirmed',
      state: {
        icon: 'sent',
        headline: 'Created issue OPS-1.',
        detail: 'OPS · Task',
        links: [{ label: 'Open in Jira', href: 'https://example.atlassian.net/browse/OPS-1' }],
      },
    });
    expect(recorded).toEqual({ ok: true });

    expect(await getWidgetDecision(stateKey)).toEqual({
      icon: 'sent',
      headline: 'Created issue OPS-1.',
      detail: 'OPS · Task',
      links: [{ label: 'Open in Jira', href: 'https://example.atlassian.net/browse/OPS-1' }],
    });
    expect(await listWidgetDecisions(chatId)).toEqual(
      new Map([
        [
          stateKey,
          {
            icon: 'sent',
            headline: 'Created issue OPS-1.',
            detail: 'OPS · Task',
            links: [{ label: 'Open in Jira', href: 'https://example.atlassian.net/browse/OPS-1' }],
          },
        ],
      ])
    );
    // A different chat in the same tenant never sees another chat's card.
    expect(await listWidgetDecisions(otherChatId)).toEqual(new Map());
  });

  it('keeps the first decision when a second is reported for the same key', async () => {
    // A race between two devices, or a retry — by the time a second report
    // for one state_key could arrive, whatever it reported already
    // happened once (a tool call, or nothing, for Cancel); recording a
    // later, different report over it would rewrite that history.
    const recorded = await recordWidgetDecision({
      chatId,
      subject: me,
      stateKey,
      decision: 'cancelled',
      state: { icon: 'cancelled', headline: 'Cancelled' },
    });
    expect(recorded).toEqual({ ok: true });
    expect(await getWidgetDecision(stateKey)).toMatchObject({
      icon: 'sent',
      headline: 'Created issue OPS-1.',
    });
  });
});

/**
 * One reply presenting two cards at once: deciding the first must not open
 * a turn while the second is still undecided (the model would answer
 * having seen only one of them), and deciding the second — now that both
 * have a recorded decision — opens exactly one turn, informed by both.
 */
maybe('recordWidgetModelContext: batches decisions from one reply', () => {
  const delegate = useTestDelegate();
  const suiteId = randomUUID();
  const me = `me-${suiteId.slice(0, 8)}`;
  let chatId = '';
  let modelId = '';
  let replyTurnId = '';
  const toolUseIdA = `toolu_${randomUUID()}`;
  const toolUseIdB = `toolu_${randomUUID()}`;
  const stateKeyA = `renkei-preview:${randomUUID()}`;
  const stateKeyB = `renkei-preview:${randomUUID()}`;
  const session: { subject: string; roles: string[] } = { subject: me, roles: [] };
  const deferred: Array<() => Promise<void>> = [];
  const defer = (task: () => Promise<void>) => {
    deferred.push(task);
  };

  beforeAll(async () => {
    // The default model is the organization's, cached: the block before
    // this one configured (and then removed) its own.
    invalidateLlmCache();
    await delegate.enroll(me);
    modelId = await addDefaultModel(`Card model ${suiteId}`);
    chatId = await newChat(me, 'Two cards at once');
    const store = getDataStore();
    // The reply that presented both cards — already finished, so a new
    // turn is free to start once both are decided.
    replyTurnId = await store.chatThreads.createTurn({
      chatId,
      kind: 'reply',
      llmModelId: modelId,
      thinkingBudget: null,
      runner: null,
    });
    await insertMessage({
      chatId,
      turnId: replyTurnId,
      role: 'assistant',
      kind: 'assistant',
      status: 'complete',
      cipher: await chatCipherById(chatId),
      blocks: [
        { type: 'text', text: 'Two role assignments to review.' },
        { type: 'tool_use', id: toolUseIdA, name: 'entra_assign_app_role_preview', input: {} },
        { type: 'tool_use', id: toolUseIdB, name: 'entra_assign_app_role_preview', input: {} },
      ],
    });
    await insertMessage({
      chatId,
      turnId: replyTurnId,
      role: 'user',
      kind: 'tool_results',
      status: 'complete',
      cipher: await chatCipherById(chatId),
      blocks: [
        {
          type: 'tool_result',
          toolUseId: toolUseIdA,
          content: 'Awaiting the user’s decision on the preview card.',
          uiResourceUri: 'ui://widget/directory-action-preview.test.html',
          structuredContent: { kind: 'directory_action', previewId: stateKeyA.split(':')[1] },
        },
        {
          type: 'tool_result',
          toolUseId: toolUseIdB,
          content: 'Awaiting the user’s decision on the preview card.',
          uiResourceUri: 'ui://widget/directory-action-preview.test.html',
          structuredContent: { kind: 'directory_action', previewId: stateKeyB.split(':')[1] },
        },
      ],
    });
    await store.chatThreads.finishTurn(replyTurnId, {
      status: 'completed',
      error: null,
      iterations: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  afterAll(async () => {
    const store = getDataStore();
    await store.chats.delete(me, chatId);
    await store.llmModels.delete(modelId);
    await closeDataStore();
  });

  it('appends the first decision as a note, opening no turn, while its sibling is undecided', async () => {
    await recordWidgetDecision({
      chatId,
      subject: me,
      stateKey: stateKeyA,
      decision: 'confirmed',
      state: { icon: 'sent', headline: 'Assigned Tony Liang.' },
    });
    const recorded = await recordWidgetModelContext({
      session,
      chatId,
      text: 'The user confirmed "Assign app role" (Tony Liang) on the preview card.',
      stateKey: stateKeyA,
      defer,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.turn).toBeNull();
    expect(recorded.message.turnId).toBeNull();
    expect(deferred).toHaveLength(0);

    // Still just the one (already-finished) reply turn — none opened yet.
    expect(await getDataStore().chatThreads.getActiveTurn(chatId)).toBeNull();
    expect(await turnIdsOf(chatId)).toEqual([replyTurnId]);
  });

  it('opens exactly one turn once the second decision lands, informed by both', async () => {
    await recordWidgetDecision({
      chatId,
      subject: me,
      stateKey: stateKeyB,
      decision: 'confirmed',
      state: { icon: 'sent', headline: 'Assigned Rachel Cheng.' },
    });
    const recorded = await recordWidgetModelContext({
      session,
      chatId,
      text: 'The user confirmed "Assign app role" (Rachel Cheng) on the preview card.',
      stateKey: stateKeyB,
      defer,
    });
    expect(recorded).toMatchObject({ ok: true });
    if (!recorded.ok) return;
    expect(recorded.turn).not.toBeNull();
    expect(recorded.message.turnId).toBe(recorded.turn?.turnId ?? null);
    // The model work for THIS turn was handed off, not run.
    expect(deferred).toHaveLength(1);

    const store = getDataStore();
    const newTurnId = recorded.turn?.turnId ?? '';
    // Exactly one NEW turn opened across both decisions, not one each.
    expect((await store.chatThreads.getActiveTurn(chatId))?.id).toBe(newTurnId);
    expect(await turnIdsOf(chatId)).toEqual([replyTurnId, newTurnId].sort());

    const noteRows = (await store.chatThreads.listMessages(chatId))
      .filter((row) => row.kind === 'note')
      .map((row) => ({ kind: row.kind, turnId: row.turnId }));
    expect(noteRows).toEqual([
      { kind: 'note', turnId: null },
      { kind: 'note', turnId: newTurnId },
    ]);
  });
});
