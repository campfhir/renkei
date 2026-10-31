/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { MCPToolContext } from '../common';
import { lookupNames } from '../lookup';
import { nameKey } from '../previews/card';
import type { ConfluenceAuth } from './confluence-auth';
import { registerConfluencePreviewLookups } from './preview-lookups';

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(answers: Record<string, unknown>) {
  const urls: string[] = [];
  const auth: ConfluenceAuth = {
    kind: 'pat',
    resolve: async () => ({
      cloudId: 'c1',
      accountId: 'a1',
      auth: Object.assign(
        async (url: string) => {
          const path = String(url).split('/wiki')[1] ?? '';
          urls.push(path);
          const hit = Object.entries(answers).find(([prefix]) => path.startsWith(prefix));
          return hit ? json(hit[1]) : json({}, 404);
        },
        { grantKey: 'test' }
      ),
    }),
  };
  const context = {} as MCPToolContext;
  registerConfluencePreviewLookups(context, auth);
  return { context, urls };
}

describe('confluence preview lookups', () => {
  it('reads the page title for an edit', async () => {
    const { context, urls } = setup({ '/api/v2/pages/42': { title: 'Runbook' } });
    await expect(lookupNames(context, 'confluence_update_page', { pageId: '42' })).resolves.toEqual(
      {
        [nameKey('page', '42')]: 'Runbook',
      }
    );
    expect(urls).toEqual(['/api/v2/pages/42']);
  });

  it('names the space and parent a page is created under', async () => {
    const { context } = setup({
      '/api/v2/spaces/7': { name: 'Engineering' },
      '/api/v2/pages/9': { title: 'Home' },
    });
    await expect(
      lookupNames(context, 'confluence_create_page', { spaceId: '7', parentId: '9' })
    ).resolves.toEqual({
      [nameKey('space', '7')]: 'Engineering',
      [nameKey('page', '9')]: 'Home',
    });
  });

  it('describes a comment by its words and a task by its page', async () => {
    const { context } = setup({
      '/api/v2/footer-comments/5': { body: { storage: { value: '<p>Looks <b>good</b></p>' } } },
      '/api/v2/tasks/3': { pageId: '42' },
      '/api/v2/pages/42': { title: 'Runbook' },
    });
    await expect(
      lookupNames(context, 'confluence_delete_comment', { commentId: '5' })
    ).resolves.toEqual({ [nameKey('comment', '5')]: '“Looks good”' });
    await expect(
      lookupNames(context, 'confluence_update_task_status', { taskId: '3' })
    ).resolves.toEqual({ [nameKey('task', '3')]: 'Runbook' });
  });

  it('leaves the name out when Confluence refuses', async () => {
    const { context } = setup({});
    await expect(lookupNames(context, 'confluence_delete_page', { pageId: '42' })).resolves.toEqual(
      {}
    );
  });

  it('leaves the name out when the grant cannot be resolved', async () => {
    const context = {} as MCPToolContext;
    registerConfluencePreviewLookups(context, {
      kind: 'pat',
      resolve: async () => 'No signed-in subject on this MCP session.',
    });
    await expect(lookupNames(context, 'confluence_delete_page', { pageId: '42' })).resolves.toEqual(
      {}
    );
  });
});
