/* eslint-disable @typescript-eslint/consistent-type-assertions -- a fake model and a bare context for tools that read only the chat id and subject */
/**
 * The chat title against a real database (skipped without DATABASE_URL):
 * the automatic title is asked once, lands on the placeholder the send
 * wrote, never overwrites a title the person set meanwhile, and a model
 * that fails leaves the placeholder in place. chat_rename itself renames
 * the chat the person owns and nothing else.
 */

import { randomUUID } from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import { closeDataStore, getDataStore } from '@renkei/db';
import type { ResolvedLlm } from '@renkei/agent-llm';
import type { LocalToolContext } from './local-tools';
import { autoTitleChat, chatRenameTool } from './chat-title-tools';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('chat titles', () => {
  const subject = `title-${randomUUID().slice(0, 8)}`;
  const placeholder = 'Ask about the budget';

  const chats: string[] = [];
  /** A new chat whose first send wrote `placeholder` as its title, the way a send does. */
  const newChat = async (placeholderTitle: string) => {
    const store = getDataStore();
    const id = await store.chats.create({
      ownerSubject: subject,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
    chats.push(id);
    await store.chats.touch(id, { titleIfMissing: placeholderTitle });
    return id;
  };
  const titleOf = async (id: string) => {
    const chat = await getDataStore().chats.get(id);
    if (!chat) throw new Error('no such chat');
    return { title: chat.title, autoTitleAsked: chat.autoTitleAsked };
  };

  /** A model that answers with the given title, and counts its calls. */
  const modelAnswering = (title: string | null) => {
    const complete = jest.fn(async () =>
      ok({
        usage: { inputTokens: 120, outputTokens: 9 },
        content:
          title === null
            ? [{ type: 'text' as const, text: 'I cannot title this.' }]
            : [{ type: 'tool_use' as const, id: 'toolu_1', name: 'chat_rename', input: { title } }],
      })
    );
    return { llm: { provider: { complete } } as unknown as ResolvedLlm, complete };
  };

  afterAll(async () => {
    // The subject is this run's own, so its ledger rows never mix with
    // another run's; they age out with the ledger like everyone's.
    const store = getDataStore();
    for (const chatId of chats) await store.chats.delete(subject, chatId);
    await closeDataStore();
  });

  it('records the title call under context_window, not as a chat turn', async () => {
    const chatId = await newChat(placeholder);
    const { llm } = modelAnswering('Budget review');
    const ledger = jest.spyOn(getDataStore().usage, 'recordLlmCall');

    await autoTitleChat({ subject, chatId, llm, firstPrompt: 'Budget help please.' });

    // The ledger row as written (the spy passes it through to the store)…
    expect(ledger).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveBeenCalledWith(
      expect.objectContaining({
        subject,
        purpose: 'context_window',
        inputTokens: 120,
        outputTokens: 9,
      })
    );
    ledger.mockRestore();
    // …and as read back: on the person's ledger today, and not among their
    // chat tokens, which count only purpose 'chat'.
    const totals = await getDataStore().usage.personTotals(subject, {
      span: { days: 1, endOffsetDays: 0 },
      timeZone: 'UTC',
    });
    expect(totals).toMatchObject({
      inputTokens: 120,
      outputTokens: 9,
      chatInputTokens: 0,
      chatOutputTokens: 0,
    });
  });

  it('titles a new chat once, from its first prompt', async () => {
    const chatId = await newChat(placeholder);
    const { llm, complete } = modelAnswering('Budget review');

    await autoTitleChat({
      subject,
      chatId,
      llm,
      firstPrompt: 'Help me plan the budget review.',
    });
    await autoTitleChat({
      subject,
      chatId,
      llm,
      firstPrompt: 'Help me plan the budget review.',
    });

    expect(await titleOf(chatId)).toEqual({ title: 'Budget review', autoTitleAsked: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ toolChoice: { name: 'chat_rename' } })
    );
  });

  it('keeps a title the person set while the model was thinking', async () => {
    const chatId = await newChat(placeholder);
    const complete = jest.fn(async () => {
      await getDataStore().chats.update(subject, chatId, { title: 'My own name' });
      return ok({
        usage: { inputTokens: 120, outputTokens: 9 },
        content: [
          {
            type: 'tool_use' as const,
            id: 'toolu_2',
            name: 'chat_rename',
            input: { title: 'Budget review' },
          },
        ],
      });
    });
    const llm = { provider: { complete } } as unknown as ResolvedLlm;

    await autoTitleChat({ subject, chatId, llm, firstPrompt: 'Budget help please.' });

    expect(await titleOf(chatId)).toEqual({ title: 'My own name', autoTitleAsked: true });
  });

  it('leaves the placeholder when the model gives no title, and never throws', async () => {
    const chatId = await newChat(placeholder);
    const { llm } = modelAnswering(null);

    await expect(
      autoTitleChat({ subject, chatId, llm, firstPrompt: 'Budget help please.' })
    ).resolves.toBeUndefined();

    expect(await titleOf(chatId)).toEqual({ title: placeholder, autoTitleAsked: true });
  });

  it('keeps the placeholder when the model call itself fails', async () => {
    const chatId = await newChat(placeholder);
    const complete = jest.fn(async () => err({ type: 'PROVIDER', message: 'overloaded' } as never));
    const llm = { provider: { complete } } as unknown as ResolvedLlm;

    await autoTitleChat({ subject, chatId, llm, firstPrompt: 'Budget help please.' });

    expect(await titleOf(chatId)).toEqual({ title: placeholder, autoTitleAsked: true });
  });

  it('chat_rename renames the chat the person owns, cleaned to the sidebar', async () => {
    const chatId = await newChat(placeholder);
    const tool = chatRenameTool();
    const context = { subject, chatId } as unknown as LocalToolContext;

    const result = await tool.execute({ title: '  "Team   offsite"  ' }, context);

    expect(result.isError).toBe(false);
    expect((await titleOf(chatId)).title).toBe('Team offsite');
    const blank = await tool.execute({ title: '   ' }, context);
    expect(blank.isError).toBe(true);
  });

  it('chat_rename refuses a chat someone else owns', async () => {
    const chatId = await newChat(placeholder);
    const tool = chatRenameTool();
    const stranger = { subject: `not-${subject}`, chatId } as unknown as LocalToolContext;

    const result = await tool.execute({ title: 'Taken' }, stranger);

    expect(result.isError).toBe(true);
    expect((await titleOf(chatId)).title).toBe(placeholder);
  });
});
