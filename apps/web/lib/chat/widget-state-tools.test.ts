/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for calls that never reach it */
/**
 * chat_widget_list / chat_widget_resolve without a database: which
 * tool_result blocks count as a decidable card and how one is addressed
 * (widgetCardsOf, findWidgetCard — the same key chat-view.ts and
 * widget-tools.ts use), and the refusals the resolve tool answers before
 * it ever reads a row. Everything that touches chat_widget_decisions is in
 * widget-state-tools.db.test.ts.
 */

import type { StoredMessage } from './messages';
import { createLocalToolSet, type LocalToolContext } from './local-tools';
import {
  findWidgetCard,
  widgetCardsOf,
  widgetStateTools,
  WIDGET_LIST_TOOL,
  WIDGET_RESOLVE_TOOL,
} from './widget-state-tools';
import { resourceCipher } from './content-crypto';

/** A chat key for the fixtures: the ciphers under test only care that one is there. */
const testCipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});

const context: LocalToolContext = {
  db: null as unknown as LocalToolContext['db'],
  tenantId: 't1',
  subject: 'u1',
  chatId: 'c1',
  cipher: testCipher,
  projectId: null,
  readOnly: false,
};

function row(
  seq: number,
  role: 'user' | 'assistant',
  kind: StoredMessage['kind'],
  blocks: StoredMessage['blocks']
): StoredMessage {
  return {
    id: `m${seq}`,
    chatId: 'c1',
    turnId: 'turn',
    seq,
    role,
    kind,
    status: 'complete',
    blocks,
    llmModelId: null,
    provider: null,
    model: null,
    stopReason: null,
    usage: null,
    timing: null,
    error: null,
    summaryId: null,
    createdAt: new Date('2026-09-04T00:00:00Z'),
    updatedAt: new Date('2026-09-04T00:00:00Z'),
  };
}

const messages: StoredMessage[] = [
  row(1, 'user', 'prompt', [{ type: 'text', text: 'Email Michael, then file a task.' }]),
  row(2, 'assistant', 'assistant', [
    { type: 'tool_use', id: 'tu_mail', name: 'outlook_send_mail_preview', input: {} },
    { type: 'tool_use', id: 'tu_issue', name: 'jira_create_issue_preview', input: {} },
    { type: 'tool_use', id: 'tu_list', name: 'jira_search_issues_preview', input: {} },
    { type: 'tool_use', id: 'tu_plain', name: 'whoami', input: {} },
  ]),
  row(3, 'user', 'tool_results', [
    {
      type: 'tool_result',
      toolUseId: 'tu_mail',
      content: 'The email is drafted…',
      uiResourceUri: 'ui://widget/email-compose.abc.html',
      structuredContent: {
        kind: 'compose',
        draftId: 'draft-1',
        to: ['michael@example.org'],
        subject: 'Vesta PRD connectivity',
      },
    },
    {
      type: 'tool_result',
      toolUseId: 'tu_issue',
      content: 'Awaiting the user’s decision…',
      uiResourceUri: 'ui://widget/issue-preview.abc.html',
      structuredContent: {
        kind: 'issue',
        previewId: 'preview-1',
        title: 'Create Jira issue',
        subtitle: 'OPS · Task',
      },
    },
    // A display-only card: a widget with nothing to decide, so no key.
    {
      type: 'tool_result',
      toolUseId: 'tu_list',
      content: '3 issues.',
      uiResourceUri: 'ui://widget/results-list.abc.html',
      structuredContent: { kind: 'issues', rows: [] },
    },
    // A plain result: no widget at all.
    { type: 'tool_result', toolUseId: 'tu_plain', content: 'You are u1.' },
  ]),
];

describe('widgetCardsOf', () => {
  it('lists every decidable card, oldest first, keyed the way the card keys itself', () => {
    const cards = widgetCardsOf(messages, new Map());
    expect(cards).toEqual([
      {
        id: 'draft-1',
        stateKey: 'renkei-email:draft-1',
        toolName: 'outlook_send_mail_preview',
        toolUseId: 'tu_mail',
        title: 'Vesta PRD connectivity',
        detail: 'to michael@example.org',
        resolved: null,
      },
      {
        id: 'preview-1',
        stateKey: 'renkei-preview:preview-1',
        toolName: 'jira_create_issue_preview',
        toolUseId: 'tu_issue',
        title: 'Create Jira issue',
        detail: 'OPS · Task',
        resolved: null,
      },
    ]);
  });

  it('carries the decision already recorded for a card', () => {
    const cards = widgetCardsOf(
      messages,
      new Map([['renkei-email:draft-1', { icon: 'sent', headline: 'Sent' }]])
    );
    expect(cards.map((card) => card.resolved)).toEqual([{ icon: 'sent', headline: 'Sent' }, null]);
  });

  it('falls back to the tool name when the payload names nothing', () => {
    const cards = widgetCardsOf(
      [
        row(1, 'assistant', 'assistant', [
          { type: 'tool_use', id: 'tu', name: 'entra_assign_app_role_preview', input: {} },
        ]),
        row(2, 'user', 'tool_results', [
          {
            type: 'tool_result',
            toolUseId: 'tu',
            content: '…',
            uiResourceUri: 'ui://widget/directory-action-preview.abc.html',
            structuredContent: { kind: 'directory_action', previewId: 'p' },
          },
        ]),
      ],
      new Map()
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('entra_assign_app_role_preview');
    expect(cards[0].detail).toBe('');
  });
});

describe('findWidgetCard', () => {
  const cards = widgetCardsOf(messages, new Map());

  it('finds a card by its own id or by its whole state key, and nothing by a blank', () => {
    expect(findWidgetCard(cards, 'preview-1')?.stateKey).toBe('renkei-preview:preview-1');
    expect(findWidgetCard(cards, ' renkei-email:draft-1 ')?.id).toBe('draft-1');
    expect(findWidgetCard(cards, 'nope')).toBeNull();
    expect(findWidgetCard(cards, '  ')).toBeNull();
  });
});

describe('the widget state tools', () => {
  const tools = createLocalToolSet(widgetStateTools());

  it('offers listing as a read and resolving as an act, with widget and outcome required', () => {
    expect(tools.has(WIDGET_LIST_TOOL)).toBe(true);
    expect(tools.has(WIDGET_RESOLVE_TOOL)).toBe(true);
    expect(tools.readOnlyNames()).toEqual([WIDGET_LIST_TOOL]);
    const def = tools.defs().find((tool) => tool.name === WIDGET_RESOLVE_TOOL);
    expect(def?.inputSchema.required).toEqual(['widget', 'outcome']);
    expect(def?.description).toMatch(/sends, creates or discards NOTHING/);
  });

  it('refuses to resolve under read-only, without a widget, or with an unknown outcome', async () => {
    const readOnly = await tools.run(
      WIDGET_RESOLVE_TOOL,
      { widget: 'preview-1', outcome: 'done' },
      { ...context, readOnly: true }
    );
    expect(readOnly.isError).toBe(true);
    expect(readOnly.content[0]).toMatchObject({ text: expect.stringMatching(/read-only/) });

    const noWidget = await tools.run(WIDGET_RESOLVE_TOOL, { outcome: 'done' }, context);
    expect(noWidget.isError).toBe(true);
    expect(noWidget.content[0]).toMatchObject({
      text: expect.stringMatching(/`widget` is required/),
    });

    const badOutcome = await tools.run(
      WIDGET_RESOLVE_TOOL,
      { widget: 'preview-1', outcome: 'sent' },
      context
    );
    expect(badOutcome.isError).toBe(true);
    expect(badOutcome.content[0]).toMatchObject({
      text: expect.stringMatching(/"done" or "cancelled"/),
    });
  });
});
