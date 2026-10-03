/**
 * chat_widget_resolve against a real database (skipped without
 * DATABASE_URL and TOKEN_ENCRYPTION_KEY): marking a card decided writes
 * the same `chat_widget_decisions` row the card's own button would, keyed
 * so chat-view.ts reads it back as `resolved`, announces it on the turn's
 * stream, and refuses a card already decided, a card that is not in this
 * chat, and a losing race against a button click — first decision wins,
 * as between two devices.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { createLocalToolSet, type LocalToolContext } from './local-tools';
import { insertMessage } from './messages';
import { resourceCipher } from './content-crypto';

/** A chat key for the fixtures: the ciphers under test only care that one is there. */
const testCipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});
import type { WidgetDecisionState } from './views';
import { getWidgetDecision, recordWidgetDecision } from './widget-tools';
import { widgetStateTools, WIDGET_LIST_TOOL, WIDGET_RESOLVE_TOOL } from './widget-state-tools';

const maybe =
  process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? describe : describe.skip;

maybe('chat_widget_resolve', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const me = `me-${tenantId.slice(0, 8)}`;
  const chatId = randomUUID();
  const otherChatId = randomUUID();
  const turnId = randomUUID();
  const draftId = randomUUID();
  const previewId = randomUUID();
  const otherPreviewId = randomUUID();
  const tools = createLocalToolSet(widgetStateTools());
  const emitted: Array<{ stateKey: string; state: WidgetDecisionState }> = [];
  let context: LocalToolContext;

  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? '').join('\n');

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    context = {
      db,
      tenantId,
      subject: me,
      chatId,
      projectId: null,
      readOnly: false,
      cipher: testCipher,
      emitWidgetDecision: (decision) => {
        emitted.push(decision);
      },
    };
    await db.insertInto('tenants').values({ id: tenantId, slug: tenantId }).execute();
    await db
      .insertInto('chats')
      .values([
        { id: chatId, tenant_id: tenantId, owner_subject: me, title: 'Vesta troubleshooting' },
        { id: otherChatId, tenant_id: tenantId, owner_subject: me, title: 'Another chat' },
      ])
      .execute();
    await db
      .insertInto('chat_turns')
      .values({
        id: turnId,
        tenant_id: tenantId,
        chat_id: chatId,
        status: 'completed',
        llm_model_id: null,
        iterations: 1,
        finished_at: new Date(),
      })
      .execute();
    await insertMessage(db, {
      tenantId,
      chatId,
      turnId,
      role: 'assistant',
      kind: 'assistant',
      status: 'complete',
      cipher: testCipher,
      blocks: [
        { type: 'text', text: 'Two cards: the email, and a task.' },
        { type: 'tool_use', id: 'tu_mail', name: 'outlook_send_mail_preview', input: {} },
        { type: 'tool_use', id: 'tu_issue', name: 'jira_create_issue_preview', input: {} },
      ],
    });
    await insertMessage(db, {
      tenantId,
      chatId,
      turnId,
      role: 'user',
      kind: 'tool_results',
      status: 'complete',
      cipher: testCipher,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'tu_mail',
          content: 'The email is drafted and awaiting the user’s decision on the preview card.',
          uiResourceUri: 'ui://widget/email-compose.test.html',
          structuredContent: {
            kind: 'compose',
            draftId,
            to: ['michael@example.org'],
            subject: 'Vesta PRD connectivity',
          },
        },
        {
          type: 'tool_result',
          toolUseId: 'tu_issue',
          content: 'Awaiting the user’s decision on the preview card.',
          uiResourceUri: 'ui://widget/issue-preview.test.html',
          structuredContent: {
            kind: 'issue',
            previewId,
            title: 'Create Jira issue',
            subtitle: 'OPS · Task',
          },
        },
      ],
    });
    // A card in a different chat of the same tenant: never reachable from here.
    await insertMessage(db, {
      tenantId,
      chatId: otherChatId,
      turnId: null,
      role: 'user',
      kind: 'tool_results',
      status: 'complete',
      cipher: testCipher,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'tu_other',
          content: '…',
          uiResourceUri: 'ui://widget/issue-preview.test.html',
          structuredContent: { kind: 'issue', previewId: otherPreviewId, title: 'Elsewhere' },
        },
      ],
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM chat_widget_decisions WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chat_messages WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chat_turns WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chats WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('lists the chat’s cards, both awaiting a decision', async () => {
    const listed = await tools.run(WIDGET_LIST_TOOL, {}, context);
    expect(listed.isError).toBe(false);
    const out = text(listed);
    expect(out).toContain('2 preview card(s) in this chat, 2 awaiting a decision');
    expect(out).toContain(
      `Vesta PRD connectivity — to michael@example.org (outlook_send_mail_preview) · awaiting`
    );
    expect(out).toContain(`widget: ${draftId}`);
    expect(out).toContain(`Create Jira issue — OPS · Task (jira_create_issue_preview) · awaiting`);
    expect(out).toContain(`widget: ${previewId}`);
    expect(out).not.toContain(otherPreviewId);
  });

  it('marks a card done: the row the button would have written, and the event the thread flips on', async () => {
    const resolved = await tools.run(
      WIDGET_RESOLVE_TOOL,
      {
        widget: draftId,
        outcome: 'done',
        headline: 'Sent manually from Outlook',
        detail: 'To michael@example.org',
      },
      context
    );
    expect(resolved.isError).toBe(false);
    expect(text(resolved)).toContain(
      'Marked "Vesta PRD connectivity" as done: Sent manually from Outlook'
    );
    expect(text(resolved)).toContain('Nothing was sent');

    // Keyed exactly as the email card keys itself (ui.ts's rememberDone),
    // so chat-view.ts joins it back onto the card as `resolved`.
    expect(await getWidgetDecision(db, tenantId, `renkei-email:${draftId}`)).toEqual({
      icon: 'sent',
      headline: 'Sent manually from Outlook',
      detail: 'To michael@example.org',
    });
    const row = await db
      .selectFrom('chat_widget_decisions')
      .select(['chat_id', 'decision', 'decided_by'])
      .where('tenant_id', '=', tenantId)
      .where('state_key', '=', `renkei-email:${draftId}`)
      .executeTakeFirst();
    expect(row).toEqual({ chat_id: chatId, decision: 'confirmed', decided_by: me });
    expect(emitted).toEqual([
      {
        stateKey: `renkei-email:${draftId}`,
        state: {
          icon: 'sent',
          headline: 'Sent manually from Outlook',
          detail: 'To michael@example.org',
        },
      },
    ]);

    const listed = await tools.run(WIDGET_LIST_TOOL, {}, context);
    expect(text(listed)).toContain('2 preview card(s) in this chat, 1 awaiting a decision');
    expect(text(listed)).toContain('decided — Sent manually from Outlook (To michael@example.org)');
  });

  it('leaves a card already decided as it is', async () => {
    const again = await tools.run(
      WIDGET_RESOLVE_TOOL,
      { widget: draftId, outcome: 'cancelled', headline: 'Discarded' },
      context
    );
    expect(again.isError).toBe(true);
    expect(text(again)).toContain('already decided: Sent manually from Outlook');
    expect(await getWidgetDecision(db, tenantId, `renkei-email:${draftId}`)).toMatchObject({
      icon: 'sent',
      headline: 'Sent manually from Outlook',
    });
    expect(emitted).toHaveLength(1);
  });

  it('reaches no card outside this chat, and none by an unknown id', async () => {
    for (const widget of [otherPreviewId, 'not-a-card']) {
      const missing = await tools.run(WIDGET_RESOLVE_TOOL, { widget, outcome: 'done' }, context);
      expect(missing.isError).toBe(true);
      expect(text(missing)).toContain(`No preview card "${widget}" in this chat`);
    }
    expect(await getWidgetDecision(db, tenantId, `renkei-preview:${otherPreviewId}`)).toBeNull();
  });

  it('loses to a button click that lands first, and says so', async () => {
    // The card's own decision (widget-tools.ts's recordWidgetDecision, off
    // ui/report-decision) between the tool's read and its write: the tool
    // wrote nothing, and reports the receipt the card actually shows.
    const raced = createLocalToolSet(widgetStateTools());
    const clicked = await recordWidgetDecision(db, {
      tenantId,
      chatId,
      subject: me,
      stateKey: `renkei-preview:${previewId}`,
      decision: 'confirmed',
      state: { icon: 'sent', headline: 'Created issue OPS-7.' },
    });
    expect(clicked).toEqual({ ok: true });
    // The plain path: already decided by the time the tool reads.
    const late = await raced.run(
      WIDGET_RESOLVE_TOOL,
      { widget: previewId, outcome: 'cancelled' },
      context
    );
    expect(late.isError).toBe(true);
    expect(text(late)).toContain('already decided: Created issue OPS-7.');
    expect(await getWidgetDecision(db, tenantId, `renkei-preview:${previewId}`)).toEqual({
      icon: 'sent',
      headline: 'Created issue OPS-7.',
    });
    expect(emitted).toHaveLength(1);
  });

  it('defaults the receipt’s wording by outcome', async () => {
    const freshPreviewId = randomUUID();
    await insertMessage(db, {
      tenantId,
      chatId,
      turnId: null,
      role: 'user',
      kind: 'tool_results',
      status: 'complete',
      cipher: testCipher,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'tu_meeting',
          content: '…',
          uiResourceUri: 'ui://widget/meeting-preview.test.html',
          structuredContent: { kind: 'zoom', previewId: freshPreviewId, topic: 'Vesta sync' },
        },
      ],
    });
    const cancelled = await tools.run(
      WIDGET_RESOLVE_TOOL,
      { widget: freshPreviewId, outcome: 'cancelled' },
      context
    );
    expect(cancelled.isError).toBe(false);
    expect(text(cancelled)).toContain('Marked "Vesta sync" as cancelled: Cancelled.');
    expect(await getWidgetDecision(db, tenantId, `renkei-preview:${freshPreviewId}`)).toEqual({
      icon: 'cancelled',
      headline: 'Cancelled',
    });
    const row = await db
      .selectFrom('chat_widget_decisions')
      .select(['decision'])
      .where('tenant_id', '=', tenantId)
      .where('state_key', '=', `renkei-preview:${freshPreviewId}`)
      .executeTakeFirst();
    expect(row).toEqual({ decision: 'cancelled' });
  });
});
