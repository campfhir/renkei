/**
 * chat_recall_chats against a real database (skipped without
 * DATABASE_URL): in a project it lists, searches and reads the project's
 * own chats — every member's — and nothing outside them, whatever id the
 * model hands in; outside a project it stays with the person's own chats.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import type { McpToolResult } from '@renkei/mcp-client';
import type { LocalToolContext } from './local-tools';
import { insertMessage } from './messages';
import { chatCipherById } from './chat-keys';
import { unavailableCipher } from './content-crypto';
import { recallTools } from './recall-tools';

// The delegate is the one process that holds keys; the web app reaches it
// over HTTP, so these tests run it in-process on a loopback port, one per
// describe block (each block opens and closes its own database pool).
import { useTestDelegate } from '@/lib/test-support/delegate';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

function textOf(result: McpToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

maybe('chat_recall_chats', () => {
  const delegate = useTestDelegate();
  const suiteId = randomUUID();
  const me = `me-${suiteId.slice(0, 8)}`;
  const colleague = `colleague-${suiteId.slice(0, 8)}`;
  let projectId = '';
  let otherProjectId = '';
  /** This conversation, in the project. */
  let thisChat = '';
  /** A colleague's earlier chat in the same project. */
  let siblingChat = '';
  /** My own chat outside any project. */
  let myOtherChat = '';
  /** My own chat in another project. */
  let elsewhereChat = '';
  /** A chat in the project nothing was ever said in. */
  let emptyChat = '';

  const tool = recallTools()[0]!;
  const contextFor = (chatId: string, inProject: string | null): LocalToolContext => ({
    subject: me,
    chatId,
    // The tool reads other chats as their owners; this chat's own cipher is unused here.
    cipher: unavailableCipher('no-key'),
    projectId: inProject,
    readOnly: false,
  });
  const call = (context: LocalToolContext, input: Record<string, unknown>) =>
    tool.execute(input, context);

  beforeAll(async () => {
    const store = getDataStore();
    await delegate.enroll(me);
    await delegate.enroll(colleague);
    // A code project (a repository on it) and a plain chat project.
    projectId = await store.chatProjects.create({
      ownerSubject: me,
      name: 'Ledger',
      description: null,
      toolConfig: null,
      repo: { provider: 'github', fullName: 'acme/ledger', branch: null },
    });
    otherProjectId = await store.chatProjects.create({
      ownerSubject: me,
      name: 'Billing',
      description: null,
      toolConfig: null,
    });
    const chat = async (owner: string, project: string | null, title: string) => {
      const id = await store.chats.create({
        ownerSubject: owner,
        projectId: project,
        llmModelId: null,
        toolConfig: null,
        thinkingEnabled: false,
        autoMode: false,
      });
      await store.chats.update(owner, id, { title });
      return id;
    };
    thisChat = await chat(me, projectId, 'Month-end close');
    siblingChat = await chat(colleague, projectId, 'Refund postings');
    myOtherChat = await chat(me, null, 'Refund policy email');
    elsewhereChat = await chat(me, otherProjectId, 'Refund invoices');
    emptyChat = await chat(me, projectId, 'Nothing here');
    const say = async (chatId: string, text: string) => {
      const row = await insertMessage({
        chatId,
        turnId: null,
        role: 'user',
        kind: 'prompt',
        status: 'complete',
        cipher: await chatCipherById(chatId),
        blocks: [{ type: 'text', text }],
      });
      if (!row) throw new Error('message not sealed — is TOKEN_ENCRYPTION_KEY set?');
      // The send's touch: the chat now has a last message.
      await store.chats.touch(chatId, {});
    };
    await say(thisChat, 'Close the books for March.');
    await say(siblingChat, 'Refunds post to the clearing account, not revenue.');
    await say(myOtherChat, 'Draft the refund policy email to customers.');
    await say(elsewhereChat, 'Refund the duplicate invoices from April.');
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
