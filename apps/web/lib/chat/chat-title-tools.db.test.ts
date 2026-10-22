/* eslint-disable @typescript-eslint/consistent-type-assertions -- a fake model and a bare context for tools that read only the chat id and subject */
/**
 * The chat title against a real database (skipped without DATABASE_URL):
 * the automatic title is asked once, lands on the placeholder the send
 * wrote, never overwrites a title the person set meanwhile, and a model
 * that fails leaves the placeholder in place. chat_rename itself renames
 * the chat the person owns and nothing else.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { ok, err } from '@campfhir/safe-functions/helpers';
import { getDatabase, type DB } from '@renkei/db';
import type { ResolvedLlm } from '@renkei/agent-llm';
import type { LocalToolContext } from './local-tools';
import { autoTitleChat, chatRenameTool } from './chat-title-tools';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('chat titles', () => {
  let db: Kysely<DB>;
  const subject = `title-${randomUUID().slice(0, 8)}`;
  const placeholder = 'Ask about the budget';

  const newChat = async (title: string | null) => {
    const id = randomUUID();
    await db.insertInto('chats').values({ id, owner_subject: subject, title }).execute();
    return id;
  };
  const titleOf = async (id: string) =>
    await db
      .selectFrom('chats')
      .select(['title', 'auto_title_asked'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  /** A model that answers with the given title, and counts its calls. */
  const modelAnswering = (title: string | null) => {
    const complete = jest.fn(async () =>
      ok({
        content:
          title === null
            ? [{ type: 'text' as const, text: 'I cannot title this.' }]
            : [{ type: 'tool_use' as const, id: 'toolu_1', name: 'chat_rename', input: { title } }],
      })
    );
    return { llm: { provider: { complete } } as unknown as ResolvedLlm, complete };
  };

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
  });

  afterAll(async () => {
    await db.deleteFrom('chats').where('owner_subject', '=', subject).execute();
  });

  it('titles a new chat once, from its first prompt', async () => {
    const chatId = await newChat(placeholder);
    const { llm, complete } = modelAnswering('Budget review');

    await autoTitleChat(db, { chatId, llm, firstPrompt: 'Help me plan the budget review.' });
    await autoTitleChat(db, { chatId, llm, firstPrompt: 'Help me plan the budget review.' });

    expect(await titleOf(chatId)).toEqual({ title: 'Budget review', auto_title_asked: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ toolChoice: { name: 'chat_rename' } })
    );
  });

  it('keeps a title the person set while the model was thinking', async () => {
    const chatId = await newChat(placeholder);
    const complete = jest.fn(async () => {
      await db
        .updateTable('chats')
        .set({ title: 'My own name' })
        .where('id', '=', chatId)
        .execute();
      return ok({
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

    await autoTitleChat(db, { chatId, llm, firstPrompt: 'Budget help please.' });

    expect(await titleOf(chatId)).toEqual({ title: 'My own name', auto_title_asked: true });
  });

  it('leaves the placeholder when the model gives no title, and never throws', async () => {
    const chatId = await newChat(placeholder);
    const { llm } = modelAnswering(null);

    await expect(
      autoTitleChat(db, { chatId, llm, firstPrompt: 'Budget help please.' })
    ).resolves.toBeUndefined();

    expect(await titleOf(chatId)).toEqual({ title: placeholder, auto_title_asked: true });
  });

  it('keeps the placeholder when the model call itself fails', async () => {
    const chatId = await newChat(placeholder);
    const complete = jest.fn(async () => err({ type: 'PROVIDER', message: 'overloaded' } as never));
    const llm = { provider: { complete } } as unknown as ResolvedLlm;

    await autoTitleChat(db, { chatId, llm, firstPrompt: 'Budget help please.' });

    expect(await titleOf(chatId)).toEqual({ title: placeholder, auto_title_asked: true });
  });

  it('chat_rename renames the chat the person owns, cleaned to the sidebar', async () => {
    const chatId = await newChat(placeholder);
    const tool = chatRenameTool();
    const context = { db, subject, chatId } as unknown as LocalToolContext;

    const result = await tool.execute({ title: '  "Team   offsite"  ' }, context);

    expect(result.isError).toBe(false);
    expect((await titleOf(chatId)).title).toBe('Team offsite');
    const blank = await tool.execute({ title: '   ' }, context);
    expect(blank.isError).toBe(true);
  });

  it('chat_rename refuses a chat someone else owns', async () => {
    const chatId = await newChat(placeholder);
    const tool = chatRenameTool();
    const stranger = { db, subject: `not-${subject}`, chatId } as unknown as LocalToolContext;

    const result = await tool.execute({ title: 'Taken' }, stranger);

    expect(result.isError).toBe(true);
    expect((await titleOf(chatId)).title).toBe(placeholder);
  });
});
