/**
 * The content scan against a real database (skipped without DATABASE_URL):
 * rows are sealed the way the app seals them, and the search must open
 * the right ones — prompts and replies, in the chats it was handed, newest
 * message first — and no others.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import type { LlmContentBlock } from '@renkei/agent-llm';
import { sealBlocks } from './content-crypto';
import { searchChatMessages } from './search';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('searchChatMessages', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const subject = `owner-${tenantId.slice(0, 8)}`;
  const chatA = randomUUID();
  const chatB = randomUUID();
  const chatC = randomUUID();
  const chatOutside = randomUUID();
  const ids = [chatA, chatB, chatC];
  let seq = 0;

  const seal = (blocks: LlmContentBlock[]): string => {
    const sealed = sealBlocks(blocks);
    if (!sealed.ok) throw new Error(sealed.err.message);
    return sealed.val;
  };

  const message = (
    chatId: string,
    kind: 'prompt' | 'assistant' | 'tool_results',
    blocks: LlmContentBlock[]
  ) =>
    db
      .insertInto('chat_messages')
      .values({
        tenant_id: tenantId,
        chat_id: chatId,
        turn_id: null,
        seq: ++seq,
        role: kind === 'assistant' ? 'assistant' : 'user',
        kind,
        content: seal(blocks),
      })
      .execute();

  beforeAll(async () => {
    process.env.CONTENT_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `search-${tenantId.slice(0, 8)}` })
      .execute();
    for (const [id, title, updatedAt] of [
      [chatA, 'Sprint review', '2026-01-03'],
      [chatB, 'Older chat', '2026-01-02'],
      [chatC, 'Tool-only chat', '2026-01-01'],
      [chatOutside, 'Not mine', '2026-01-04'],
    ] as const) {
      await db
        .insertInto('chats')
        .values({
          id,
          tenant_id: tenantId,
          owner_subject: subject,
          title,
          updated_at: new Date(updatedAt),
        })
        .execute();
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
  });

  afterAll(async () => {
    await sql`DELETE FROM chats WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('finds prompts and replies, newest chat first, one hit per chat with the newest match', async () => {
    const hits = await searchChatMessages(db, tenantId, ids, '  Zoom   webhook ');
    expect(hits.map((hit) => hit.chatId)).toEqual([chatA, chatB]);
    expect(hits[0]?.snippet).toBe('Then move the Zoom webhook rotation to the next sprint.');
    expect(hits[1]?.snippet).toBe('Who owns the zoom WEBHOOK?');
  });

  it('never opens tool calls, tool results or thinking', async () => {
    expect(await searchChatMessages(db, tenantId, ids, 'jira_search_issues')).toEqual([]);
    expect(await searchChatMessages(db, tenantId, ids, 'think about')).toEqual([]);
  });

  it('stays within the chats it was handed', async () => {
    const hits = await searchChatMessages(db, tenantId, [chatOutside, chatB], 'zoom webhook');
    expect(hits.map((hit) => hit.chatId)).toEqual([chatOutside, chatB]);
    expect(await searchChatMessages(db, tenantId, ['not-a-uuid'], 'zoom webhook')).toEqual([]);
  });

  it('answers nothing to a query too short to mean anything', async () => {
    expect(await searchChatMessages(db, tenantId, ids, 'z')).toEqual([]);
  });
});
