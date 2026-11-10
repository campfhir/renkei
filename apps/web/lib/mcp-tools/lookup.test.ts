/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withActPreviews } from './act-preview';
import { lookupNames, registerPreviewLookups } from './lookup';
import type { MCPToolContext } from './common';
import { nameKey } from './previews/card';
import { PREVIEW_BUILDERS } from './previews';

type Card = { title: string; body: { sprint: { name: string; board: string } } };
type Handler = (...args: unknown[]) => Promise<{ structuredContent?: Card }>;

const context = () => ({}) as MCPToolContext;

/** Register a Jira act through the wrapper, flush, and run its generated preview. */
async function previewOf(ctx: MCPToolContext, tool: string, args: Record<string, unknown>) {
  const tools = new Map<string, Handler>();
  const target = {
    registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  const { server, flush } = withActPreviews(target, ctx);
  (server.registerTool as unknown as (n: string, c: unknown, h: Handler) => void)(
    tool,
    { annotations: { readOnlyHint: false }, inputSchema: z.object({}) },
    async () => ({})
  );
  flush();
  return (await tools.get(`${tool}_preview`)!(args)).structuredContent!;
}

describe('preview name lookups', () => {
  it('hands the looked-up sprint name to the card, never the id', async () => {
    const ctx = context();
    registerPreviewLookups(ctx, {
      jira_complete_sprint: async (args) => ({
        [nameKey('sprint', String(args.sprintId))]: 'Sprint 42 — Payments',
      }),
    });
    const card = await previewOf(ctx, 'jira_complete_sprint', { boardId: '7', sprintId: '90210' });
    expect(card.title).toBe('Complete Sprint 42 — Payments');
    expect(card.body.sprint.name).toBe('Sprint 42 — Payments');
    expect(
      JSON.stringify([card.title, card.body.sprint.name, card.body.sprint.board])
    ).not.toContain('90210');
  });

  it('says "the sprint" when the lookup fails, throws or has no answer', async () => {
    const failing = context();
    registerPreviewLookups(failing, {
      jira_complete_sprint: async () => {
        throw new Error('Jira is down');
      },
    });
    for (const ctx of [failing, context()]) {
      const card = await previewOf(ctx, 'jira_complete_sprint', {
        boardId: '7',
        sprintId: '90210',
      });
      expect(card.title).toBe('Complete the sprint');
      expect(JSON.stringify(card)).not.toMatch(/"(?:name|board)":"[^"]*(?:90210|7)"/);
    }
  });

  it('gives up on a lookup that never answers', async () => {
    jest.useFakeTimers();
    try {
      const ctx = context();
      registerPreviewLookups(ctx, { some_tool: () => new Promise(() => undefined) });
      const pending = lookupNames(ctx, 'some_tool', {});
      await jest.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toEqual({});
    } finally {
      jest.useRealTimers();
    }
  });

  it('names the other Jira ids it can read', () => {
    const names = {
      [nameKey('filter', '11')]: 'My open bugs',
      [nameKey('component', '5')]: 'Billing',
      [nameKey('component', '6')]: 'Checkout',
      [nameKey('comment', '3')]: 'by Ann: “Looks good”',
      [nameKey('worklog', '4')]: '2h by Ann',
      [nameKey('link', '8')]: 'PROJ-1 blocks PROJ-2',
    };
    const build = (tool: string, args: Record<string, unknown>) =>
      JSON.stringify(PREVIEW_BUILDERS[tool]!(args, names));
    expect(build('jira_delete_filter', { filterId: '11' })).toContain('My open bugs');
    expect(build('jira_delete_component', { componentId: '5', moveIssuesTo: '6' })).toContain(
      'Checkout'
    );
    expect(build('jira_delete_comment', { issueKey: 'P-1', commentId: '3' })).toContain(
      'Looks good'
    );
    expect(build('jira_delete_worklog', { issueKey: 'P-1', worklogId: '4' })).toContain(
      '2h by Ann'
    );
    expect(build('jira_delete_issue_link', { linkId: '8' })).toContain('PROJ-1 blocks PROJ-2');
    // No answer: nothing reads as an id.
    expect(
      build('jira_delete_filter', { filterId: '11' }).replace(/"filterId":"11"/g, '')
    ).toBeTruthy();
    const bare = PREVIEW_BUILDERS.jira_delete_filter!({ filterId: '11' }, {});
    expect(JSON.stringify(bare)).not.toContain('11');
  });
});
