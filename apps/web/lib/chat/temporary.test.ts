/**
 * A temporary chat's memory gates, on the memory store: no memory or
 * recall tools among its local tools (an ordinary chat keeps them), no
 * user-memory connector on its tool surface, and other chats' recall
 * neither lists nor reads it.
 */

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { McpToolResult } from '@renkei/mcp-client';
import { chatLocalTools } from './chat-local-tools';
import { unavailableCipher } from './content-crypto';
import type { LocalToolContext } from './local-tools';
import { recallTools } from './recall-tools';
import { withoutMemoryConnectors } from './temporary';

const ME = 'temporary-chat-person';

const contextFor = (chatId: string, temporary: boolean): LocalToolContext => ({
  subject: ME,
  chatId,
  cipher: unavailableCipher('no-key'),
  projectId: null,
  readOnly: false,
  temporary,
});

async function newChat(temporary: boolean, title: string): Promise<string> {
  const id = await getDataStore().chats.create({
    ownerSubject: ME,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
    temporary,
  });
  await getDataStore().chats.touch(id, { titleIfMissing: title });
  return id;
}

const textOf = (result: McpToolResult) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

describe('a temporary chat', () => {
  it('is offered no memory or recall tools; an ordinary chat is', async () => {
    const names = async (temporary: boolean) =>
      (
        await chatLocalTools(
          contextFor(await newChat(temporary, 'x'), temporary),
          { connectors: [] },
          false
        )
      ).map((tool) => tool.def.name);
    const ordinary = await names(false);
    expect(ordinary).toEqual(
      expect.arrayContaining(['chat_memory_remember', 'chat_memory_list', 'chat_recall_chats'])
    );
    const temporary = await names(true);
    expect(temporary.filter((name) => /memory|recall/.test(name))).toEqual([]);
    expect(temporary).toContain('chat_rename');
  });

  it('leaves the user-memory connector off its tool surface', () => {
    expect(withoutMemoryConnectors({ connectors: ['jira', 'user-memory', 'sandbox'] })).toEqual({
      connectors: ['jira', 'sandbox'],
    });
  });

  it('is not recalled from the person’s other chats', async () => {
    const kept = await newChat(false, 'Budget review');
    const ghost = await newChat(true, 'Ghost notes');
    const here = await newChat(false, 'Here');
    const [tool] = recallTools();
    const listed = textOf(await tool!.execute({}, contextFor(here, false)));
    expect(listed).toContain(kept);
    expect(listed).not.toContain(ghost);
    const read = await tool!.execute({ chatId: ghost }, contextFor(here, false));
    expect(textOf(read)).toBe('No such chat.');
  });
});
