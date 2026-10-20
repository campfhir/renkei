/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ActCard } from '@/lib/mcp-widgets/src/act-card';
import { APP_ONLY_META } from './widgets';
import {
  PREVIEW_OF_META_KEY,
  buildPreviewCard,
  needsPreview,
  previewTwinOf,
  withActPreviews,
} from './act-preview';
import { PREVIEW_BUILDERS } from './previews';

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

const builderFor = (name: string) => {
  const builder = PREVIEW_BUILDERS[name];
  if (!builder) throw new Error(`no builder for ${name}`);
  return builder;
};

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

  it('leaves platform-internal acts, Renkei-only writes and upload plumbing alone', () => {
    for (const name of [
      'sandbox_run_python',
      'card_create',
      'knowledge_create_note',
      'agent_create',
    ]) {
      expect(needsPreview(name, ACT)).toBe(false);
    }
    // Jira Administration only writes change requests and templates in Renkei.
    expect(needsPreview('jira_admin_propose_space', ACT)).toBe(false);
    // Capturing a Webex message adds a card to the feed and posts nothing.
    expect(needsPreview('webex_capture_message', ACT)).toBe(false);
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

describe('the card a builder draws', () => {
  it('draws a comment as a comment on the thing, with its words editable', () => {
    const card = buildPreviewCard(builderFor('jira_add_comment'), 'jira_add_comment', {
      issueKey: 'PROJ-12',
      comment: 'Looks good to me.',
    });
    expect(card).toMatchObject({
      kind: 'act',
      verb: 'Comment',
      icon: 'comment',
      title: 'Comment on PROJ-12',
      subtitle: 'Jira',
      confirmLabel: 'Post comment',
      editable: [{ key: 'comment', label: 'Comment', multiline: true }],
      body: { kind: 'comment', mode: 'add', on: { label: 'PROJ-12' }, body: 'Looks good to me.' },
      confirmTool: 'jira_add_comment_confirm',
      confirmArgs: { issueKey: 'PROJ-12', comment: 'Looks good to me.' },
    });
    // A fresh id per card, so a second preview never recalls the first's receipt.
    const again = buildPreviewCard(builderFor('jira_add_comment'), 'jira_add_comment', {
      issueKey: 'PROJ-12',
      comment: 'x',
    });
    expect(again.previewId).not.toBe(card.previewId);
  });

  it('draws a status change as one status moving to another, and a delete as a danger', () => {
    expect(
      buildPreviewCard(builderFor('jira_transition_issue'), 'jira_transition_issue', {
        issueKey: 'PROJ-12',
        transitionName: 'Done',
      }).body
    ).toMatchObject({ kind: 'transition', subject: { label: 'PROJ-12' }, to: 'Done' });
    expect(
      buildPreviewCard(builderFor('confluence_delete_page'), 'confluence_delete_page', {
        pageId: '7',
        purge: true,
      })
    ).toMatchObject({
      tone: 'danger',
      verb: 'Delete forever',
      body: { kind: 'document', mode: 'delete' },
    });
  });

  it('gives the Ops tools’ own “confirm: true” to the button, not to the model', () => {
    const card = buildPreviewCard(
      builderFor('jsm_ops_delete_override'),
      'jsm_ops_delete_override',
      { scheduleId: 's1', alias: 'o1' }
    );
    expect(card.confirmArgs).toEqual({ scheduleId: 's1', alias: 'o1', confirm: true });
  });

  it('shows a commit as files, each with what happens to it, and the message editable', () => {
    const card = buildPreviewCard(builderFor('github_commit_files'), 'github_commit_files', {
      owner: 'acme',
      repo: 'app',
      branch: 'feature',
      message: 'Rename the helper',
      files: [{ path: '/src/a.ts', content: 'one\ntwo\nthree' }],
      delete: ['src/old.ts'],
    });
    expect(card.body).toMatchObject({
      kind: 'commit',
      repo: 'acme/app',
      branch: 'feature',
      messageKey: 'message',
      files: [
        { path: 'src/a.ts', status: 'modify', lines: 3 },
        { path: 'src/old.ts', status: 'delete' },
      ],
    });
    expect(card.subtitle).toBe('GitHub · acme/app');
  });

  it('reads Bitbucket and GitHub arguments into the same pull-request card', () => {
    const bitbucket = buildPreviewCard(builderFor('bitbucket_approve_pull_request'), 'x', {
      workspace: 'acme',
      repoSlug: 'app',
      id: 4,
    });
    const github = buildPreviewCard(builderFor('github_approve_pull_request'), 'x', {
      owner: 'acme',
      repo: 'app',
      number: 4,
    });
    expect(bitbucket.body).toMatchObject({
      kind: 'verdict',
      verdict: 'approve',
      pullRequest: { label: '#4', context: 'acme/app' },
    });
    expect(github.body).toEqual(bitbucket.body);
  });

  it('describes an event’s repeat in words, as the tool would', () => {
    const card = buildPreviewCard(builderFor('outlook_create_event'), 'outlook_create_event', {
      subject: 'Standup',
      start: '2026-10-21T09:00:00',
      end: '2026-10-21T09:15:00',
      requiredAttendees: ['a@example.com'],
      recurrence: { frequency: 'weekly', daysOfWeek: ['monday'] },
    });
    expect(card.body).toMatchObject({
      kind: 'event',
      subject: 'Standup',
      attendees: [{ name: 'a@example.com' }],
    });
    expect((card.body as { recurrence?: string }).recurrence).toMatch(/week/i);
  });

  it('strips a SharePoint page’s HTML down to the words a person would read', () => {
    const card = buildPreviewCard(builderFor('sharepoint_create_page'), 'sharepoint_create_page', {
      site: 'hr',
      title: 'Welcome',
      contentHtml: '<h1>Hi</h1><p>Read <b>this</b> &amp; that</p>',
    });
    expect((card.body as { body?: string }).body).toBe('Hi\nRead this & that');
  });

  it('reads page HTML as text without parsing it, and decodes entities once', () => {
    const card = (contentHtml: string) =>
      (
        buildPreviewCard(builderFor('sharepoint_create_page'), 'sharepoint_create_page', {
          site: 'hr',
          title: 'T',
          contentHtml,
        }).body as { body?: string }
      ).body;
    // An unclosed or doubled tag leaves nothing of itself behind.
    expect(card('a<scr<script>ipt>b')).toBe('aipt>b');
    expect(card('x <b onclick="1">y</b> z <br/>w')).toBe('x y z \nw');
    // `&amp;lt;` is the text "&lt;", not "<".
    expect(card('&amp;lt;b&amp;gt; &lt;i&gt;')).toBe('&lt;b&gt; <i>');
  });

  it('never throws a card out of a missing optional argument', () => {
    for (const [name, build] of Object.entries(PREVIEW_BUILDERS)) {
      expect(() => buildPreviewCard(build, name, {})).not.toThrow();
    }
  });
});

describe('withActPreviews', () => {
  const schema = { issueKey: z.string(), commentId: z.string() };

  it('registers a preview and an app-only confirm for an act that has a card', () => {
    const { server, tools } = fakeServer();
    const wrapped = withActPreviews(server);
    register(wrapped.server, 'jira_delete_comment', {
      ...ACT,
      title: 'Jira · Act — Delete a comment',
      description: 'Delete a comment.',
      inputSchema: schema,
    });
    expect(tools.has('jira_delete_comment_preview')).toBe(false);
    wrapped.flush();

    const preview = tools.get('jira_delete_comment_preview');
    const confirm = tools.get('jira_delete_comment_confirm');
    expect(tools.has('jira_delete_comment')).toBe(true);
    expect(preview?.config.inputSchema).toBe(schema);
    expect(confirm?.config.inputSchema).toBe(schema);
    expect(preview?.config.description).toContain('Delete a comment.');
    expect(preview?.config._meta).toMatchObject({
      ui: { kind: 'approval' },
      [PREVIEW_OF_META_KEY]: 'jira_delete_comment',
    });
    expect(confirm?.config._meta).toEqual(APP_ONLY_META);
    expect(confirm?.config.description).toContain('jira_delete_comment_preview');
  });

  it('shows the card and writes nothing at preview time; the confirm runs the tool’s own handler', async () => {
    const { server, tools } = fakeServer();
    const wrapped = withActPreviews(server);
    const act = jest.fn(async () => ({ content: [{ type: 'text', text: 'Deleted comment 7' }] }));
    register(wrapped.server, 'jira_delete_comment', { ...ACT, inputSchema: schema }, act);
    wrapped.flush();

    const shown = (await tools.get('jira_delete_comment_preview')?.handler({
      issueKey: 'PROJ-1',
      commentId: '7',
    })) as { structuredContent: ActCard; content: { text: string }[] };
    expect(act).not.toHaveBeenCalled();
    expect(shown.structuredContent).toMatchObject({
      kind: 'act',
      confirmTool: 'jira_delete_comment_confirm',
      confirmArgs: { issueKey: 'PROJ-1', commentId: '7' },
      body: { kind: 'comment', mode: 'delete' },
    });
    expect(shown.content[0]?.text).toContain('awaiting the user');

    const done = await tools.get('jira_delete_comment_confirm')?.handler({
      issueKey: 'PROJ-1',
      commentId: '7',
    });
    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith({ issueKey: 'PROJ-1', commentId: '7' });
    expect(done).toEqual({ content: [{ type: 'text', text: 'Deleted comment 7' }] });
  });

  it('says so, rather than throwing, when a card cannot be drawn', async () => {
    // A builder that throws on an argument the schema let through.
    const original = PREVIEW_BUILDERS['jira_delete_comment'];
    Object.defineProperty(PREVIEW_BUILDERS, 'jira_delete_comment', {
      value: () => {
        throw new Error('odd arguments');
      },
      configurable: true,
    });
    try {
      const { server, tools } = fakeServer();
      const wrapped = withActPreviews(server);
      register(wrapped.server, 'jira_delete_comment', { ...ACT, inputSchema: schema });
      wrapped.flush();
      const result = (await tools.get('jira_delete_comment_preview')?.handler({})) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('odd arguments');
    } finally {
      Object.defineProperty(PREVIEW_BUILDERS, 'jira_delete_comment', {
        value: original,
        configurable: true,
      });
    }
  });

  it('leaves alone a tool that already has a preview, whichever registered first', () => {
    for (const order of ['direct first', 'preview first']) {
      const { server, tools } = fakeServer();
      const wrapped = withActPreviews(server);
      const direct = () => register(wrapped.server, 'zoom_delete_meeting', ACT);
      const handWritten = () => register(wrapped.server, 'zoom_delete_meeting_preview', ACT);
      if (order === 'direct first') {
        direct();
        handWritten();
      } else {
        handWritten();
        direct();
      }
      wrapped.flush();
      expect([...tools.keys()].sort()).toEqual([
        'zoom_delete_meeting',
        'zoom_delete_meeting_preview',
      ]);
    }
  });

  it('leaves alone the Outlook replies, whose preview is named differently', () => {
    const { server, tools } = fakeServer();
    const wrapped = withActPreviews(server);
    register(wrapped.server, 'outlook_reply_message', ACT);
    register(wrapped.server, 'outlook_reply_preview', ACT);
    wrapped.flush();
    expect([...tools.keys()].sort()).toEqual(['outlook_reply_message', 'outlook_reply_preview']);
  });

  it('generates nothing for reads, internal acts, or an act nobody has drawn a card for', () => {
    const { server, tools } = fakeServer();
    const wrapped = withActPreviews(server);
    register(wrapped.server, 'jira_get_issue', READ);
    register(wrapped.server, 'sandbox_delete_file', ACT);
    register(wrapped.server, 'jira_request_attachment_upload', ACT);
    // Eligible, but no builder: it stays plain, with no argument-printing card.
    register(wrapped.server, 'zoom_invent_a_new_act', ACT);
    wrapped.flush();
    wrapped.flush();
    expect([...tools.keys()].sort()).toEqual([
      'jira_get_issue',
      'jira_request_attachment_upload',
      'sandbox_delete_file',
      'zoom_invent_a_new_act',
    ]);
  });

  it('passes every other server member through untouched', () => {
    const { server } = fakeServer();
    const wrapped = withActPreviews(server);
    expect((wrapped.server as unknown as { somethingElse(): string }).somethingElse()).toBe(
      'passed through'
    );
  });
});
