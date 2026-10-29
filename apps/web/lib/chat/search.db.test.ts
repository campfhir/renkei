/**
 * The content scan against a real database (skipped without DATABASE_URL):
 * rows are sealed the way the app seals them, and the search must open
 * the right ones — prompts and replies, in the chats it was handed, newest
 * message first — and no others.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import type { LlmContentBlock } from '@renkei/agent-llm';
import { createResourceKey, setKeyVault } from '@renkei/user-keys';
import { enrollTestPerson, registerTestInstance } from '@renkei/user-keys/test-support';
import { resourceCipher, sealBlocks, type ContentCipher } from './content-crypto';
import { searchChatMessages } from './search';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('searchChatMessages', () => {
  const suiteId = randomUUID();
  const subject = `owner-${suiteId.slice(0, 8)}`;
  let chatA = '';
  let chatB = '';
  let chatC = '';
  let chatOutside = '';
  let ids: string[] = [];
  // Each chat's rows under that chat's own key, the way the app writes them;
  // the search is handed the same ciphers the sidebar's viewer would get.
  const ciphers = new Map<string, ContentCipher>();

  const seal = (chatId: string, blocks: LlmContentBlock[]): string => {
    const cipher = ciphers.get(chatId);
    if (!cipher) throw new Error('no cipher for chat');
    const sealed = sealBlocks(blocks, cipher);
    if (!sealed.ok) throw new Error(sealed.err.message);
    return sealed.val;
  };

  const message = (
    chatId: string,
    kind: 'prompt' | 'assistant' | 'tool_results',
    blocks: LlmContentBlock[]
  ) =>
    getDataStore().chatThreads.insertMessage({
      chatId,
      turnId: null,
      role: kind === 'assistant' ? 'assistant' : 'user',
      kind,
      status: 'complete',
      content: seal(chatId, blocks),
    });

  let instanceId = '';

  beforeAll(async () => {
    const store = getDataStore();
    // The keys are minted in this process: it registers a delegate instance
    // of its own and enrolls the person as their browser would.
    const instance = await registerTestInstance();
    instanceId = instance.id;
    await enrollTestPerson({
      subject,
      instances: [{ id: instance.id, publicKey: instance.pair.publicKey }],
    });
    const newChat = async (title: string) => {
      const id = await store.chats.create({
        ownerSubject: subject,
        projectId: null,
        llmModelId: null,
        toolConfig: null,
        thinkingEnabled: false,
        autoMode: false,
      });
      await store.chats.update(subject, id, { title });
      return id;
    };
    chatA = await newChat('Sprint review');
    chatB = await newChat('Older chat');
    chatC = await newChat('Tool-only chat');
    chatOutside = await newChat('Not mine');
    ids = [chatA, chatB, chatC];
    for (const id of [chatA, chatB, chatC, chatOutside]) {
      const key = await createResourceKey({ kind: 'chat', resourceId: id }, subject);
      if (!key.ok) throw new Error('no chat key');
      ciphers.set(id, resourceCipher(key.val));
    }
    // Chat A: the phrase appears in an early reply and a later prompt.
    await message(chatA, 'prompt', [{ type: 'text', text: 'Which issues slipped?' }]);
    await message(chatA, 'assistant', [
      { type: 'thinking', thinking: 'Rotate nothing; think about the webhook.' },
      { type: 'text', text: 'OPS-41 Rotate the Zoom webhook secret is still open.' },
    ]);
    await message(chatA, 'prompt', [
      { type: 'text', text: 'Then move the Zoom webhook rotation to the next sprint.' },
    ]);
    // Chat B: only a prompt says it.
    await message(chatB, 'prompt', [{ type: 'text', text: 'Who owns the zoom WEBHOOK?' }]);
    await message(chatB, 'assistant', [{ type: 'text', text: 'Nobody yet.' }]);
    // Chat C: the phrase only inside a tool result and a tool call — never opened.
    await message(chatC, 'assistant', [
      { type: 'tool_use', id: 't1', name: 'jira_search_issues', input: { jql: 'zoom webhook' } },
    ]);
    await message(chatC, 'tool_results', [
      { type: 'tool_result', toolUseId: 't1', content: '{"summary":"zoom webhook"}' },
    ]);
    // A chat the caller did not list, however well it matches.
    await message(chatOutside, 'prompt', [{ type: 'text', text: 'zoom webhook zoom webhook' }]);
    // Last touched oldest first — C, B, A, then the outside chat — the way
    // each chat's latest send touches it.
    for (const id of [chatC, chatB, chatA, chatOutside]) await store.chats.touch(id, {});
  });

  afterAll(async () => {
    setKeyVault(null);
    const store = getDataStore();
    await store.userKeys.deleteInstance(instanceId);
    for (const id of [chatA, chatB, chatC, chatOutside]) await store.chats.delete(subject, id);
    await closeDataStore();
  });

  it('finds prompts and replies, newest chat first, one hit per chat with the newest match', async () => {
    const hits = await searchChatMessages(ids, '  Zoom   webhook ', ciphers);
    expect(hits.map((hit) => hit.chatId)).toEqual([chatA, chatB]);
    expect(hits[0]?.snippet).toBe('Then move the Zoom webhook rotation to the next sprint.');
    expect(hits[1]?.snippet).toBe('Who owns the zoom WEBHOOK?');
  });

  it('never opens tool calls, tool results or thinking', async () => {
    expect(await searchChatMessages(ids, 'jira_search_issues', ciphers)).toEqual([]);
    expect(await searchChatMessages(ids, 'think about', ciphers)).toEqual([]);
  });

  it('stays within the chats it was handed', async () => {
    const hits = await searchChatMessages([chatOutside, chatB], 'zoom webhook', ciphers);
    expect(hits.map((hit) => hit.chatId)).toEqual([chatOutside, chatB]);
    expect(await searchChatMessages(['not-a-uuid'], 'zoom webhook', ciphers)).toEqual([]);
  });

  it('answers nothing to a query too short to mean anything', async () => {
    expect(await searchChatMessages(ids, 'z', ciphers)).toEqual([]);
  });
});
