/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The github_ tools against a stubbed GitHubAuth — the same seam the
 * Bitbucket suite uses. What earns a pin here: the scope gate
 * registering exactly the families the connection carries, the
 * installation-resolution `owner` indirection, the Git Data API sequence
 * `github_commit_files` builds, and the preview tools never performing
 * the act they preview.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
// pullrequests.ts imports helpers from ../common, which transitively pulls
// in @renkei/db (ESM-only kysely) for exports this suite never touches.
jest.mock('../common', () => ({
  withPresentationHint: (text: string) => text,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerGitHubTools } from './index';
import type { GitHubAuth } from './github-auth';
import { githubScopeFor } from './scopes';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

interface Route {
  match: string;
  method?: string;
  status?: number;
  body?: unknown;
  /** Raw text response (diffs, file reads, logs). */
  text?: string;
}

let routes: Route[] = [];
let requests: { path: string; method: string; json: unknown }[] = [];

const INSTALLATIONS = {
  installations: [
    { id: 42, account: { login: 'acme', type: 'Organization' }, repository_selection: 'all' },
  ],
};

const stubAuth: GitHubAuth = {
  kind: 'oauth',
  async fetch(_scopes, path, init) {
    const method = init?.method ?? 'GET';
    requests.push({ path, method, json: init?.json });
    const route = routes.find(
      (candidate) => path.includes(candidate.match) && (candidate.method ?? method) === method
    );
    if (!route) return new Response(JSON.stringify({}), { status: 404 });
    // 204/205/304 forbid a body at all, even an empty string.
    if (route.status === 204) return new Response(null, { status: 204 });
    if (route.text !== undefined) return new Response(route.text, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  },
};

async function toolsOf(scopes?: string[]): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const context = {
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
    githubScopes: scopes,
  } as unknown as MCPToolContext;
  await registerGitHubTools(server, context, stubAuth);
  return registered;
}

beforeEach(() => {
  routes = [{ match: '/user/installations', body: INSTALLATIONS }];
  requests = [];
});

describe('scope-gated registration', () => {
  it('registers every tool when no scopes are recorded (legacy grants)', async () => {
    const tools = await toolsOf(undefined);
    expect(tools.has('github_list_repositories')).toBe(true);
    expect(tools.has('github_merge_pull_request')).toBe(true);
    expect(tools.has('github_trigger_workflow')).toBe(true);
  });

  it('a repository-read connection gets no writes and no other families', async () => {
    const tools = await toolsOf(['repository']);
    expect(tools.has('github_list_repositories')).toBe(true);
    expect(tools.has('github_read_file')).toBe(true);
    expect(tools.has('github_create_branch')).toBe(false);
    expect(tools.has('github_list_pull_requests')).toBe(false);
    expect(tools.has('github_trigger_workflow')).toBe(false);
  });

  it('every registered tool has a real scope mapping', async () => {
    const tools = await toolsOf(undefined);
    const unmapped = [...tools.keys()].filter((name) =>
      githubScopeFor(name).includes('__unmapped__')
    );
    expect(unmapped).toEqual([]);
  });
});

describe('repositories', () => {
  it('resolves owner to the covering installation before listing', async () => {
    // Unshifted: the generic '/user/installations' route from beforeEach
    // is also a substring of this URL, and the stub matches in order.
    routes.unshift({
      match: '/user/installations/42/repositories',
      body: { repositories: [{ full_name: 'acme/api', name: 'api', default_branch: 'main' }] },
    });
    const tools = await toolsOf();
    const result = await tools.get('github_list_repositories')!({ owner: 'acme' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('acme/api');
  });

  it('refuses a listing for an owner with no covering installation', async () => {
    const tools = await toolsOf();
    const result = await tools.get('github_list_repositories')!({ owner: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No installation');
  });

  it('commits a single file as base64, fetching the prior sha to overwrite', async () => {
    routes.push(
      { match: '/contents/docs/README.md?ref=main', method: 'GET', body: { sha: 'old-sha' } },
      { match: '/contents/docs/README.md', method: 'PUT', body: { content: { sha: 'new-sha' } } }
    );
    const tools = await toolsOf();
    const result = await tools.get('github_commit_file')!({
      owner: 'acme',
      repo: 'api',
      branch: 'main',
      path: 'docs/README.md',
      content: '# Hello',
      message: 'Add readme',
    });

    expect(result.isError).not.toBe(true);
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.json).toMatchObject({
      message: 'Add readme',
      content: Buffer.from('# Hello', 'utf8').toString('base64'),
      branch: 'main',
      sha: 'old-sha',
    });
  });

  it('commits multiple files and a deletion through the Git Data API sequence', async () => {
    routes.push(
      { match: '/git/ref/heads/main', body: { object: { sha: 'base-commit' } } },
      { match: '/git/commits/base-commit', body: { tree: { sha: 'base-tree' } } },
      { match: '/git/blobs', method: 'POST', body: { sha: 'blob-1' } },
      { match: '/git/trees', method: 'POST', body: { sha: 'new-tree' } },
      { match: '/git/commits', method: 'POST', body: { sha: 'new-commit' } },
      { match: '/git/refs/heads/main', method: 'PATCH', body: {} }
    );
    const tools = await toolsOf();
    const result = await tools.get('github_commit_files')!({
      owner: 'acme',
      repo: 'api',
      branch: 'main',
      files: [{ path: 'docs/a.md', content: '# A' }],
      delete: ['docs/old.md'],
      message: 'Batch update docs',
    });

    expect(result.isError).not.toBe(true);
    const tree = requests.find((request) => request.method === 'POST' && request.path.endsWith('/git/trees'));
    expect(tree?.json).toMatchObject({
      base_tree: 'base-tree',
      tree: [
        { path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'blob-1' },
        { path: 'docs/old.md', mode: '100644', type: 'blob', sha: null },
      ],
    });
    const moved = requests.find((request) => request.method === 'PATCH');
    expect(moved?.json).toEqual({ sha: 'new-commit' });
  });

  it('reads a directory listing through the contents endpoint', async () => {
    routes.push({
      match: '/contents/?ref=main',
      body: [
        { type: 'file', path: 'index.ts', size: 120 },
        { type: 'dir', path: 'src' },
      ],
    });
    const tools = await toolsOf();
    const result = await tools.get('github_browse_source')!({
      owner: 'acme',
      repo: 'api',
      ref: 'main',
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('src/');
    expect(result.content[0]?.text).toContain('index.ts (120 bytes)');
  });
});

describe('pull requests', () => {
  it('creates a PR with head/base', async () => {
    routes.push({
      match: '/pulls',
      method: 'POST',
      body: { number: 7, title: 'Add rate limiting', head: { ref: 'feature/rl' }, base: { ref: 'main' } },
    });
    const tools = await toolsOf();
    const result = await tools.get('github_create_pull_request')!({
      owner: 'acme',
      repo: 'api',
      title: 'Add rate limiting',
      sourceBranch: 'feature/rl',
      destinationBranch: 'main',
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('#7');
    expect(result.content[0]?.text).toContain('https://github.com/acme/api/pull/7');
    const post = requests.find((request) => request.method === 'POST' && request.path.endsWith('/pulls'));
    expect(post?.json).toMatchObject({ title: 'Add rate limiting', head: 'feature/rl', base: 'main' });
  });

  it('the create preview never creates — the card does', async () => {
    routes.push({ match: '/repos/acme/api', body: { default_branch: 'main' } });
    const tools = await toolsOf();
    const result = await tools.get('github_create_pull_request_preview')!({
      owner: 'acme',
      repo: 'api',
      title: 'Add rate limiting',
      sourceBranch: 'feature/rl',
    });

    expect(result.isError).not.toBe(true);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      kind: 'issue',
      confirmTool: 'github_create_pull_request_confirm',
    });
  });

  it('the merge preview never merges — the card does', async () => {
    routes.push({
      match: '/pulls/7',
      body: { number: 7, title: 'Add rate limiting', head: { ref: 'feature/rl' }, base: { ref: 'main' } },
    });
    const tools = await toolsOf();
    const result = await tools.get('github_merge_pull_request_preview')!({
      owner: 'acme',
      repo: 'api',
      number: 7,
    });

    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({ confirmTool: 'github_merge_pull_request_confirm' });
  });

  it('merges with the chosen strategy', async () => {
    routes.push({ match: '/merge', method: 'PUT', body: {} });
    const tools = await toolsOf();
    const result = await tools.get('github_merge_pull_request')!({
      owner: 'acme',
      repo: 'api',
      number: 7,
      strategy: 'squash',
    });

    expect(result.isError).not.toBe(true);
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.json).toMatchObject({ merge_method: 'squash' });
  });
});

describe('actions', () => {
  it('dispatches a workflow on a ref', async () => {
    routes.push({ match: '/dispatches', method: 'POST', status: 204, body: {} });
    const tools = await toolsOf();
    const result = await tools.get('github_trigger_workflow')!({
      owner: 'acme',
      repo: 'api',
      workflowId: 'ci.yml',
      ref: 'main',
    });

    expect(result.isError).not.toBe(true);
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.json).toMatchObject({ ref: 'main' });
  });

  it('the trigger preview never triggers — the card does', async () => {
    const tools = await toolsOf();
    const result = await tools.get('github_trigger_workflow_preview')!({
      owner: 'acme',
      repo: 'api',
      workflowId: 'ci.yml',
      ref: 'main',
    });

    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({ confirmTool: 'github_trigger_workflow_confirm' });
  });
});
