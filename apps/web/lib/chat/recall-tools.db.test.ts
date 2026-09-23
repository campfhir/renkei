/**
 * chat_recall_chats against a real database (skipped without
 * DATABASE_URL): in a project it lists, searches and reads the project's
 * own chats — every member's — and nothing outside them, whatever id the
 * model hands in; outside a project it stays with the person's own chats.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import type { McpToolResult } from '@renkei/mcp-client';
import type { LocalToolContext } from './local-tools';
import { insertMessage } from './messages';
import { recallTools } from './recall-tools';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

function textOf(result: McpToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

maybe('chat_recall_chats', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const me = `me-${tenantId.slice(0, 8)}`;
  const colleague = `colleague-${tenantId.slice(0, 8)}`;
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  /** This conversation, in the project. */
  const thisChat = randomUUID();
  /** A colleague's earlier chat in the same project. */
  const siblingChat = randomUUID();
  /** My own chat outside any project. */
  const myOtherChat = randomUUID();
  /** My own chat in another project. */
  const elsewhereChat = randomUUID();
  /** A chat in the project nothing was ever said in. */
  const emptyChat = randomUUID();

  const tool = recallTools()[0]!;
  const contextFor = (chatId: string, inProject: string | null): LocalToolContext => ({
    db,
    tenantId,
    subject: me,
    chatId,
    projectId: inProject,
    readOnly: false,
  });
  const call = (context: LocalToolContext, input: Record<string, unknown>) =>
    tool.execute(input, context);

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db.insertInto('tenants').values({ id: tenantId, slug: tenantId }).execute();
    await db
      .insertInto('chat_projects')
      .values([
        { id: projectId, tenant_id: tenantId, owner_subject: me, name: 'Ledger', kind: 'code' },
        { id: otherProjectId, tenant_id: tenantId, owner_subject: me, name: 'Billing' },
      ])
      .execute();
    const chat = (id: string, owner: string, project: string | null, title: string) => ({
      id,
      tenant_id: tenantId,
      owner_subject: owner,
      project_id: project,
      title,
    });
    await db
      .insertInto('chats')
      .values([
        chat(thisChat, me, projectId, 'Month-end close'),
        chat(siblingChat, colleague, projectId, 'Refund postings'),
        chat(myOtherChat, me, null, 'Refund policy email'),
        chat(elsewhereChat, me, otherProjectId, 'Refund invoices'),
        chat(emptyChat, me, projectId, 'Nothing here'),
      ])
      .execute();
    const say = async (chatId: string, text: string) => {
      const row = await insertMessage(db, {
        tenantId,
        chatId,
        turnId: null,
        role: 'user',
        kind: 'prompt',
        status: 'complete',
        blocks: [{ type: 'text', text }],
      });
      if (!row) throw new Error('message not sealed — is TOKEN_ENCRYPTION_KEY set?');
      await db
        .updateTable('chats')
        .set({ last_message_at: new Date() })
        .where('id', '=', chatId)
        .execute();
    };
    await say(thisChat, 'Close the books for March.');
    await say(siblingChat, 'Refunds post to the clearing account, not revenue.');
    await say(myOtherChat, 'Draft the refund policy email to customers.');
    await say(elsewhereChat, 'Refund the duplicate invoices from April.');
  });

  afterAll(async () => {
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('in a project, lists only the project’s other started chats', async () => {
    const result = await call(contextFor(thisChat, projectId), {});
    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text).toContain('other chats in this project');
    expect(text).toContain(siblingChat);
    expect(text).not.toContain(thisChat);
    expect(text).not.toContain(emptyChat);
    expect(text).not.toContain(myOtherChat);
    expect(text).not.toContain(elsewhereChat);
  });

  it('in a project, a search matches only within the project', async () => {
    const result = await call(contextFor(thisChat, projectId), { query: 'refund' });
    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text).toContain(siblingChat);
    expect(text).not.toContain(myOtherChat);
    expect(text).not.toContain(elsewhereChat);
  });

  it('in a project, reads a member’s chat in the project and nothing outside it', async () => {
    const context = contextFor(thisChat, projectId);
    const ok = await call(context, { chatId: siblingChat });
    expect(ok.isError).toBe(false);
    expect(textOf(ok)).toContain('clearing account');
    // My own chats elsewhere are outside the project: the same answer as
    // for an id that does not exist.
    for (const outside of [myOtherChat, elsewhereChat, randomUUID()]) {
      const refused = await call(context, { chatId: outside });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe('No such chat.');
    }
  });

  it('outside a project, stays with the person’s own chats', async () => {
    const context = contextFor(myOtherChat, null);
    const listed = textOf(await call(context, {}));
    expect(listed).toContain(elsewhereChat);
    expect(listed).not.toContain(siblingChat);
    const refused = await call(context, { chatId: siblingChat });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('No such chat.');
  });
});
