/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { APP_ONLY_META } from './widgets';
import {
  PREVIEW_OF_META_KEY,
  buildPreviewCard,
  needsPreview,
  previewFields,
  previewTwinOf,
  withGenericPreview,
} from './generic-preview';

type Config = Parameters<McpServer['registerTool']>[1];
type Handler = (...args: unknown[]) => Promise<unknown>;

/** A server that remembers what was registered, with the handler to call it. */
function fakeServer() {
  const tools = new Map<string, { config: Config; handler: Handler }>();
  const server = {
    registerTool: (name: string, config: Config, handler: Handler) => {
      tools.set(name, { config, handler });
    },
    somethingElse: () => 'passed through',
  } as unknown as McpServer;
  return { server, tools };
}

const ACT: Config = { annotations: { readOnlyHint: false } };
const READ: Config = { annotations: { readOnlyHint: true } };

function register(
  server: McpServer,
  name: string,
  config: Config,
  handler: Handler = async () => ({ content: [{ type: 'text', text: 'ran' }] })
) {
  (server.registerTool as unknown as (n: string, c: Config, h: Handler) => void)(
    name,
    config,
    handler
  );
}

describe('needsPreview', () => {
  it('previews external acts, and only those', () => {
    expect(needsPreview('confluence_create_page', ACT)).toBe(true);
    // An absent hint means mutating, the rule every gate reads it by.
    expect(needsPreview('jira_add_comment', {})).toBe(true);
    expect(needsPreview('jira_search_issues', READ)).toBe(false);
    // A card's own halves are not acts to put a card in front of.
    expect(needsPreview('jira_create_issue_preview', ACT)).toBe(false);
    expect(needsPreview('jira_create_issue_confirm', { ...ACT, _meta: APP_ONLY_META })).toBe(false);
    expect(needsPreview('x_confirm', ACT)).toBe(false);
  });

  it('leaves platform-internal acts and upload plumbing alone', () => {
    for (const name of ['sandbox_run_python', 'card_create', 'knowledge_create_note']) {
      expect(needsPreview(name, ACT)).toBe(false);
    }
    expect(needsPreview('agent_create', ACT)).toBe(false);
    expect(needsPreview('jira_request_attachment_upload', ACT)).toBe(false);
    expect(needsPreview('outlook_request_draft_attachment_upload', ACT)).toBe(false);
  });

  it('previews a tool whose namespace is unknown, rather than letting it through', () => {
    expect(needsPreview('mystery_delete_everything', ACT)).toBe(true);
  });
});

describe('previewTwinOf', () => {
  it('finds <tool>_preview, and the Outlook reply family’s irregular names', () => {
    const names = new Set([
      'jira_add_comment_preview',
      'outlook_reply_preview',
      'outlook_forward_message_preview',
    ]);
    expect(previewTwinOf('jira_add_comment', names)).toBe('jira_add_comment_preview');
    expect(previewTwinOf('outlook_reply_message', names)).toBe('outlook_reply_preview');
    // An override that is not registered is no twin, even if the regular name is.
    expect(previewTwinOf('outlook_forward_message', names)).toBeNull();
    expect(previewTwinOf('jira_delete_comment', names)).toBeNull();
  });
});

describe('the preview card', () => {
  it('lists the arguments as readable rows, shortening what is long', () => {
    const rows = previewFields({
      issueKey: 'PROJ-1',
      body: 'x'.repeat(2000),
      labels: ['a', 'b'],
      empty: '',
      missing: undefined,
      nothing: null,
    });
    expect(rows.map((row) => row.label)).toEqual(['Issue key', 'Body', 'Labels']);
    expect(rows[0]?.value).toBe('PROJ-1');
    expect(rows[1]?.value.length).toBeLessThan(700);
    expect(rows[1]?.value).toContain('2000 characters');
    expect(rows[2]?.value).toBe('["a","b"]');
  });

  it('names the act, the system, and the tool its confirm button calls', () => {
    const card = buildPreviewCard('jira_delete_comment', 'Jira · Act — Delete a comment', {
      issueKey: 'PROJ-1',
      commentId: '10',
    });
    expect(card).toMatchObject({
      kind: 'directory_action',
      action: 'Delete',
      tone: 'caution',
      title: 'Delete a comment',
      subtitle: 'Jira',
      confirmTool: 'jira_delete_comment_confirm',
      confirmLabel: 'Delete',
      confirmArgs: { issueKey: 'PROJ-1', commentId: '10' },
    });
    // A fresh id per card, so a second preview never recalls the first's receipt.
    expect(typeof card.previewId).toBe('string');
    expect(buildPreviewCard('x_do', 'X', {}).previewId).not.toBe(card.previewId);
  });

  it('falls back to the tool’s name when it has no title to read', () => {
    expect(buildPreviewCard('zoom_widen_thing', undefined, {})).toMatchObject({
      title: 'Zoom widen thing',
      action: 'Confirm',
      tone: 'neutral',
    });
  });
});

describe('withGenericPreview', () => {
  it('registers a preview and an app-only confirm for an act that has none', () => {
    const { server, tools } = fakeServer();
    const wrapped = withGenericPreview(server);
    const inputSchema = { pageId: z.string() };
    register(wrapped.server, 'confluence_delete_page', {
      ...ACT,
      title: 'Confluence · Act — Delete a page',
      description: 'Delete a Confluence page.',
      inputSchema,
    });
    expect(tools.has('confluence_delete_page_preview')).toBe(false);
    wrapped.flush();

    const preview = tools.get('confluence_delete_page_preview');
    const confirm = tools.get('confluence_delete_page_confirm');
    expect(tools.has('confluence_delete_page')).toBe(true);
    expect(preview?.config.inputSchema).toBe(inputSchema);
    expect(confirm?.config.inputSchema).toBe(inputSchema);
    expect(preview?.config.description).toContain('Delete a Confluence page.');
    expect(preview?.config._meta).toMatchObject({
      ui: { kind: 'approval' },
      [PREVIEW_OF_META_KEY]: 'confluence_delete_page',
    });
    expect(confirm?.config._meta).toEqual(APP_ONLY_META);
    expect(confirm?.config.description).toContain('confluence_delete_page_preview');
  });

  it('shows a card and writes nothing at preview time; the confirm runs the tool’s own handler', async () => {
    const { server, tools } = fakeServer();
    const wrapped = withGenericPreview(server);
    const act = jest.fn(async () => ({ content: [{ type: 'text', text: 'Deleted page 7' }] }));
    register(
      wrapped.server,
      'confluence_delete_page',
      { ...ACT, inputSchema: { pageId: z.string() } },
      act
    );
    wrapped.flush();

    const shown = (await tools.get('confluence_delete_page_preview')?.handler({
      pageId: '7',
    })) as { structuredContent: Record<string, unknown>; content: { text: string }[] };
    expect(act).not.toHaveBeenCalled();
    expect(shown.structuredContent).toMatchObject({
      confirmTool: 'confluence_delete_page_confirm',
      confirmArgs: { pageId: '7' },
    });
    expect(shown.content[0]?.text).toContain('awaiting the user');

    const done = await tools.get('confluence_delete_page_confirm')?.handler({ pageId: '7' });
    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith({ pageId: '7' });
    expect(done).toEqual({ content: [{ type: 'text', text: 'Deleted page 7' }] });
  });

  it('handles an act that takes no arguments', async () => {
    const { server, tools } = fakeServer();
    const wrapped = withGenericPreview(server);
    register(wrapped.server, 'jira_connect_everything', ACT);
    wrapped.flush();
    const shown = (await tools.get('jira_connect_everything_preview')?.handler({
      signal: 'extra, not arguments',
    })) as { structuredContent: { confirmArgs: unknown; fields: unknown[] } };
    expect(shown.structuredContent.confirmArgs).toEqual({});
    expect(shown.structuredContent.fields).toEqual([]);
    expect(tools.get('jira_connect_everything_preview')?.config.inputSchema).toBeUndefined();
  });

  it('leaves alone a tool that already has a preview, whichever registered first', () => {
    for (const order of ['direct first', 'preview first']) {
      const { server, tools } = fakeServer();
      const wrapped = withGenericPreview(server);
      const direct = () => register(wrapped.server, 'zoom_create_meeting', ACT);
      const handWritten = () => register(wrapped.server, 'zoom_create_meeting_preview', ACT);
      if (order === 'direct first') {
        direct();
        handWritten();
      } else {
        handWritten();
        direct();
      }
      wrapped.flush();
      expect([...tools.keys()].sort()).toEqual([
        'zoom_create_meeting',
        'zoom_create_meeting_preview',
      ]);
    }
  });

  it('leaves alone the Outlook replies, whose preview is named differently', () => {
    const { server, tools } = fakeServer();
    const wrapped = withGenericPreview(server);
    register(wrapped.server, 'outlook_reply_message', ACT);
    register(wrapped.server, 'outlook_reply_preview', ACT);
    wrapped.flush();
    expect([...tools.keys()].sort()).toEqual(['outlook_reply_message', 'outlook_reply_preview']);
  });

  it('generates nothing for reads, internal acts, or tools it already generated for', () => {
    const { server, tools } = fakeServer();
    const wrapped = withGenericPreview(server);
    register(wrapped.server, 'jira_get_issue', READ);
    register(wrapped.server, 'sandbox_delete_file', ACT);
    register(wrapped.server, 'jira_request_attachment_upload', ACT);
    wrapped.flush();
    wrapped.flush();
    expect([...tools.keys()].sort()).toEqual([
      'jira_get_issue',
      'jira_request_attachment_upload',
      'sandbox_delete_file',
    ]);
  });

  it('passes every other server member through untouched', () => {
    const { server } = fakeServer();
    const wrapped = withGenericPreview(server);
    expect((wrapped.server as unknown as { somethingElse(): string }).somethingElse()).toBe(
      'passed through'
    );
  });
});
